/**
 * worker-sync/index.js
 *
 * Entry point del Worker de sincronización de catálogo.
 *
 * Triggers:
 *   scheduled(event) — cron "15 7 * * *" (07:15 UTC = 04:15 Montevideo)
 *   fetch(request)   — POST /trigger con header Authorization: Bearer <SYNC_SECRET>
 *                      para disparar sync manualmente.
 *                    — GET /status con el mismo header para auditar KV + R2.
 *                    — POST /measure descarga y mide sin escribir R2 ni estado de sync.
 *                    — POST /publish-preview-catalog escribe únicamente el catálogo
 *                      separado de STOCK-1 (prefijo stock1-preview/*) cuando la
 *                      versión aislada lo habilita.
 *                    — POST /publish-production-catalog escribe el catálogo
 *                      productivo separado (prefijo catalog/*, nunca
 *                      stock1-preview/*) cuando PRODUCTION_PAUSED_CATALOG_PUBLISH_ENABLED
 *                      lo habilita. No toca catalog.json ni meta.json.
 *
 * Flujo de runSync():
 *   1. Obtener ML access token (meli-auth.js — KV lock + retry)
 *   2. Descargar catálogo completo (meli-catalog.js — scroll + batch details)
 *   3. Escribir catalog.json y meta.json en R2 (r2-publish.js)
 *   4. Notificar a IndexNow únicamente URLs indexables que cambiaron
 *   5. Guardar estado mínimo en KV (sync:last_ok / sync:last_error)
 *
 * KV keys escritas por este Worker:
 *   auth:refresh_token       — compartido con Pages (se actualiza en meli-auth.js)
 *   auth:refresh_token_lock  — mutex para el intercambio de token
 *   sync:last_started        — ISO timestamp del último sync iniciado
 *   sync:last_ok             — ISO timestamp del último sync exitoso
 *   sync:last_error          — string corto del último error (ausente si el último sync fue ok)
 *
 * Secret opcional:
 *   SYNC_HEALTHCHECK_URL     — Ping URL base de Healthchecks.io (nunca se loguea)
 *
 * KV keys que este Worker NO escribe:
 *   catalog:full, catalog_index, catalog_index:*, item:MLU*  — esquemas obsoletos
 *
 * Nota operativa:
 *   Con ~16.000 items, el sync tarda ~5-8 minutos (principalmente I/O hacia ML API).
 *   El cron trigger es el camino principal. Para ejecución manual verificable, usar:
 *   POST /trigger?mode=await
 */

import { getAccessToken } from './meli-auth.js';
import { buildCatalog   } from './meli-catalog.js';
import { publishToR2    } from './r2-publish.js';
import { notifyHealthcheck } from './healthcheck.js';
import { processStockWaitlist } from './stock-waitlist-notifier.js';
import { readPreviousPublicCatalog, submitIndexNow } from './indexnow.js';
import {
  addCompressedIndexes,
  buildManifest,
  buildPausedCatalogArtifacts,
  PAUSED_MANIFEST_KEY,
  PAUSED_PREFIX_ROOT,
  PRODUCTION_MANIFEST_KEY,
  PRODUCTION_PREFIX_ROOT,
} from './paused-catalog.js';

export const STOCK1_PREVIEW_CATALOG_KEY = PAUSED_MANIFEST_KEY;
export const PRODUCTION_CATALOG_KEY = PRODUCTION_MANIFEST_KEY;

export default {
  // ── Cron trigger ────────────────────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    console.log(`[Worker] Cron trigger: ${new Date().toISOString()}`);
    ctx.waitUntil(runSync(env, { source: 'cron' }));
  },

  // ── Manual trigger / status ─────────────────────────────────────────────────
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Validar SYNC_SECRET (común a todas las rutas protegidas)
    if (!env.SYNC_SECRET) {
      console.error('[Worker] SYNC_SECRET no configurado. Ejecutá: wrangler secret put SYNC_SECRET');
      return json({ error: 'Server misconfiguration: SYNC_SECRET not set.' }, 500);
    }
    const authHeader = request.headers.get('Authorization') || '';
    if (authHeader !== `Bearer ${env.SYNC_SECRET}`) {
      return json({ error: 'Unauthorized.' }, 401);
    }

    if (request.method === 'GET' && url.pathname === '/status') {
      return json(await readStatus(env));
    }

    if (request.method === 'POST' && url.pathname === '/measure') {
      const result = await runMeasure(env);
      return json(result, result.status === 'measured' ? 200 : 500);
    }

    if (request.method === 'POST' && url.pathname === '/publish-preview-catalog') {
      if (String(env.STOCK1_PREVIEW_PUBLISH_ENABLED) !== 'true') {
        return json({ error: 'Not found.' }, 404);
      }
      const result = await runPreviewCatalogPublish(env);
      return json(result, result.status === 'published-preview' ? 200 : 500);
    }

    if (request.method === 'POST' && url.pathname === '/publish-production-catalog') {
      if (String(env.PRODUCTION_PAUSED_CATALOG_PUBLISH_ENABLED) !== 'true') {
        return json({ error: 'Not found.' }, 404);
      }
      const result = await runProductionCatalogPublish(env);
      return json(result, result.status === 'published-production' ? 200 : 500);
    }

    if (request.method !== 'POST' || url.pathname !== '/trigger') {
      return json({ error: 'Not found. Use POST /measure, POST /trigger or GET /status.' }, 404);
    }

    const mode = url.searchParams.get('mode') || 'async';
    console.log(`[Worker] Trigger manual: ${new Date().toISOString()} | mode=${mode}`);

    if (mode === 'await') {
      const result = await runSync(env, { source: 'manual-await' });
      return json(result, result.status === 'ok' ? 200 : 500);
    }

    ctx.waitUntil(runSync(env, { source: 'manual-async' }));

    return json({
      status:  'SYNC_TRIGGERED',
      mode:    'async',
      message: 'Sync iniciado en background. Usá GET /status para auditar sync:last_ok, sync:last_error y R2/meta.json.',
      status_url: '/status',
    }, 202);
  },
};

// ── Medición segura ─────────────────────────────────────────────────────────

export function summarizeCatalog(catalog) {
  const items = Array.isArray(catalog?.items) ? catalog.items : [];
  const active = items.filter(
    item => item.status === 'active' && Number(item.available_quantity) > 0
  ).length;
  const paused = items.filter(item => item.status === 'paused').length;
  const activeWithoutStock = items.filter(
    item => item.status === 'active' && Number(item.available_quantity) <= 0
  ).length;
  const ids = items.map(item => item.id).filter(Boolean);
  const duplicateIds = ids.length - new Set(ids).size;
  const invalid = items.filter(
    item => !item.id || !item.title || !['active', 'paused'].includes(item.status)
  ).length;
  const bytes = new TextEncoder().encode(JSON.stringify(catalog)).length;
  return {
    total: items.length,
    active,
    paused,
    active_without_stock: activeWithoutStock,
    duplicate_ids: duplicateIds,
    invalid,
    bytes,
    mebibytes: Math.round((bytes / 1024 / 1024) * 100) / 100,
  };
}

export async function runMeasure(env, {
  getAccessTokenFn = getAccessToken,
  buildCatalogFn = buildCatalog,
} = {}) {
  try {
    const accessToken = await getAccessTokenFn(env);
    const catalog = await buildCatalogFn(env, accessToken);
    return {
      status: 'measured',
      checked_at: new Date().toISOString(),
      catalog: summarizeCatalog(catalog),
      published: false,
    };
  } catch (err) {
    console.error(`[Measure] Error: ${err.message}`);
    return {
      status: 'error',
      checked_at: new Date().toISOString(),
      published: false,
      error: String(err.message || 'Error').slice(0, 400),
    };
  }
}

// CF-R2-2-BRIDGE: lógica compartida entre Preview y producción. Sólo
// difieren en el flag que lo habilita, el manifest/prefijo de R2 destino y
// la etiqueta de scope — nunca en el algoritmo de construcción/verificación.
async function publishPausedCatalog(env, {
  getAccessTokenFn,
  buildCatalogFn,
  enabledFlag,
  manifestKey,
  prefixRoot,
  scope,
  statusOk,
  errorLabel,
}) {
  if (String(env?.[enabledFlag]) !== 'true') {
    return {
      status: 'error',
      published: false,
      error: `${errorLabel} catalog publishing is disabled.`,
    };
  }
  if (!env?.CATALOG_R2 || typeof env.CATALOG_R2.put !== 'function') {
    return {
      status: 'error',
      published: false,
      error: 'CATALOG_R2 binding is unavailable.',
    };
  }

  try {
    const accessToken = await getAccessTokenFn(env);
    const catalog = await buildCatalogFn(env, accessToken);
    const summary = summarizeCatalog(catalog);

    if (summary.invalid > 0 || summary.duplicate_ids > 0 || summary.paused === 0) {
      throw new Error(
        `Catálogo ${errorLabel} inválido: paused=${summary.paused}, ` +
        `duplicate_ids=${summary.duplicate_ids}, invalid=${summary.invalid}.`
      );
    }

    const artifacts = await addCompressedIndexes(
      buildPausedCatalogArtifacts(catalog, { prefixRoot }),
    );
    const previousManifest = await readExistingManifest(env.CATALOG_R2, manifestKey, errorLabel);
    const manifest = buildManifest(artifacts, previousManifest);

    await putCatalogArtifact(
      env.CATALOG_R2,
      artifacts.active_index.key,
      artifacts.active_index.body,
      'application/json',
      scope,
    );
    await putCatalogArtifact(
      env.CATALOG_R2,
      artifacts.active_index.gzip_key,
      artifacts.active_index.gzip_body,
      'application/gzip',
      scope,
    );
    await putCatalogArtifact(env.CATALOG_R2, artifacts.index.key, artifacts.index.body, 'application/json', scope);
    await putCatalogArtifact(
      env.CATALOG_R2,
      artifacts.index.gzip_key,
      artifacts.index.gzip_body,
      'application/gzip',
      scope,
    );
    for (const block of artifacts.blocks) {
      await putCatalogArtifact(env.CATALOG_R2, block.key, block.body, 'application/json', scope);
    }
    await verifyCatalogArtifacts(env.CATALOG_R2, artifacts);

    // El manifest es el único puntero mutable y se publica último. Si cualquier
    // escritura o verificación anterior falla, este entorno conserva la
    // versión previa — nunca queda en un estado a medio publicar.
    const manifestBody = JSON.stringify(manifest);
    await env.CATALOG_R2.put(manifestKey, manifestBody, {
      httpMetadata: {
        contentType: 'application/json',
        cacheControl: 'public, max-age=60',
      },
      customMetadata: {
        scope,
        publication: 'atomic-pointer',
      },
    });

    const samplePaused = catalog.items.find(item => item.status === 'paused') || null;
    return {
      status: statusOk,
      published: true,
      production_catalog_modified: false,
      key: manifestKey,
      checked_at: new Date().toISOString(),
      catalog: summary,
      paused_catalog: {
        version: artifacts.version,
        total: artifacts.total,
        index_bytes: artifacts.index.bytes,
        index_gzip_bytes: artifacts.index.gzip_bytes,
        block_count: artifacts.block_count,
        max_block_bytes: artifacts.max_block_bytes,
        total_detail_bytes: artifacts.total_detail_bytes,
        previous_version: manifest.previous?.version || null,
      },
      active_catalog: {
        total: artifacts.active_index.total,
        index_bytes: artifacts.active_index.bytes,
        index_gzip_bytes: artifacts.active_index.gzip_bytes,
      },
      data_quality: catalog.data_quality || null,
      sample_paused: samplePaused
        ? { id: samplePaused.id, title: samplePaused.title }
        : null,
    };
  } catch (err) {
    console.error(`[${errorLabel} catalog] Error: ${err.message}`);
    return {
      status: 'error',
      published: false,
      production_catalog_modified: false,
      key: manifestKey,
      error: String(err.message || 'Error').slice(0, 400),
    };
  }
}

export async function runPreviewCatalogPublish(env, {
  getAccessTokenFn = getAccessToken,
  buildCatalogFn = buildCatalog,
} = {}) {
  return publishPausedCatalog(env, {
    getAccessTokenFn,
    buildCatalogFn,
    enabledFlag: 'STOCK1_PREVIEW_PUBLISH_ENABLED',
    manifestKey: PAUSED_MANIFEST_KEY,
    prefixRoot: PAUSED_PREFIX_ROOT,
    scope: 'stock-1-preview-only',
    statusOk: 'published-preview',
    errorLabel: 'Preview',
  });
}

export async function runProductionCatalogPublish(env, {
  getAccessTokenFn = getAccessToken,
  buildCatalogFn = buildCatalog,
} = {}) {
  return publishPausedCatalog(env, {
    getAccessTokenFn,
    buildCatalogFn,
    enabledFlag: 'PRODUCTION_PAUSED_CATALOG_PUBLISH_ENABLED',
    manifestKey: PRODUCTION_MANIFEST_KEY,
    prefixRoot: PRODUCTION_PREFIX_ROOT,
    scope: 'production',
    statusOk: 'published-production',
    errorLabel: 'Production',
  });
}

async function readExistingManifest(bucket, manifestKey, errorLabel) {
  if (typeof bucket.get !== 'function') return null;
  try {
    const object = await bucket.get(manifestKey);
    if (!object) return null;
    const parsed = JSON.parse(await object.text());
    return parsed?.schema_version === 1 ? parsed : null;
  } catch (error) {
    console.warn(`[${errorLabel} catalog] No se pudo leer manifest anterior: ${error.message}`);
    return null;
  }
}

async function putCatalogArtifact(bucket, key, body, contentType, scope) {
  await bucket.put(key, body, {
    httpMetadata: {
      contentType,
      cacheControl: 'public, max-age=31536000, immutable',
    },
    customMetadata: {
      scope,
      publication: 'immutable-version',
    },
  });
}

async function verifyCatalogArtifacts(bucket, artifacts) {
  if (typeof bucket.head !== 'function') {
    throw new Error('CATALOG_R2.head no está disponible para verificar publicación.');
  }
  const expected = [
    { key: artifacts.active_index.key, bytes: artifacts.active_index.bytes },
    { key: artifacts.active_index.gzip_key, bytes: artifacts.active_index.gzip_bytes },
    { key: artifacts.index.key, bytes: artifacts.index.bytes },
    { key: artifacts.index.gzip_key, bytes: artifacts.index.gzip_bytes },
    ...artifacts.blocks.map(block => ({ key: block.key, bytes: block.bytes })),
  ];
  for (const artifact of expected) {
    const object = await bucket.head(artifact.key);
    if (!object || Number(object.size) !== artifact.bytes) {
      throw new Error(
        `Verificación R2 falló para ${artifact.key}: ` +
        `esperado=${artifact.bytes}, recibido=${object?.size ?? 'null'}.`
      );
    }
  }
}

// ── Sync principal ────────────────────────────────────────────────────────────

export async function runSync(env, options = {}, {
  getAccessTokenFn = getAccessToken,
  buildCatalogFn = buildCatalog,
  publishToR2Fn = publishToR2,
  notifyHealthcheckFn = notifyHealthcheck,
  processStockWaitlistFn = processStockWaitlist,
  readPreviousPublicCatalogFn = readPreviousPublicCatalog,
  submitIndexNowFn = submitIndexNow,
} = {}) {
  const startedAt = new Date().toISOString();
  const source = options.source || 'unknown';
  console.log(`[Sync] Iniciando sync completo — ${startedAt} | source=${source}`);

  if (source === 'cron') {
    await safeNotifyHealthcheck(notifyHealthcheckFn, env, 'start');
  }
  await kvPut(env, 'sync:last_started', startedAt);

  try {
    // 1. Auth
    const accessToken = await getAccessTokenFn(env);
    console.log('[Sync] Access token obtenido.');

    // 2. Catálogo
    // El catálogo público conserva únicamente publicaciones activas. Los
    // pausados se generan por el flujo versionado y aislado de Preview.
    const catalog = await buildCatalogFn(env, accessToken, {
      statuses: ['active'],
      enrichDescriptions: true,
    });

    // 3. Publicar en R2 (staging → validación → promote)
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - new Date(startedAt).getTime();
    const syncMeta = {
      total:          catalog.total,
      updated_at:     catalog.updated_at,
      last_full_sync: finishedAt,
      duration_ms:    durationMs,
      status:         'ok',
      source,
    };
    const previousCatalog = await readPreviousPublicCatalogFn(env);
    await publishToR2Fn(env, catalog, syncMeta);

    // IndexNow corre únicamente después de confirmar el promote de R2. Es una
    // señal de descubrimiento: su caída nunca invalida el catálogo publicado.
    let indexNow;
    try {
      indexNow = await submitIndexNowFn(env, previousCatalog, catalog);
    } catch (error) {
      console.error(`[IndexNow] Error: ${error?.message || 'Error'}`);
      indexNow = { status: 'error', reason: 'unexpected-error' };
    }
    if (indexNow.status === 'sent') {
      await kvPut(env, 'indexnow:last_result', JSON.stringify({
        at: finishedAt,
        ...indexNow,
      }));
      await kvDelete(env, 'indexnow:last_error');
    } else if (indexNow.status === 'error') {
      await kvPut(env, 'indexnow:last_error', JSON.stringify({
        at: finishedAt,
        status: indexNow.http_status || null,
        reason: indexNow.reason || 'http-error',
      }));
    }

    // STOCK-AVISO-2: sólo después de que R2 confirmó la publicación. Un fallo
    // de correo queda registrado y reintentable, pero no convierte un catálogo
    // ya publicado correctamente en un sync fallido.
    let stockNotifications;
    try {
      stockNotifications = await processStockWaitlistFn(env, catalog);
    } catch (error) {
      console.error(`[Stock waitlist] Error: ${error?.message || 'Error'}`);
      stockNotifications = { status: 'error', error: String(error?.message || 'Error').slice(0, 200) };
    }

    // 4. Estado: éxito
    await kvPut(env, 'sync:last_ok', finishedAt);
    await kvDelete(env, 'sync:last_error');
    await safeNotifyHealthcheck(notifyHealthcheckFn, env, 'success');

    console.log(`[Sync] Completado: ${catalog.total} items en ${Math.round(durationMs / 1000)}s`);
    return {
      status:         'ok',
      source,
      total:          catalog.total,
      updated_at:     catalog.updated_at,
      started_at:     startedAt,
      finished_at:    finishedAt,
      duration_ms:    durationMs,
      indexnow:       indexNow,
      stock_notifications: stockNotifications,
    };

  } catch (err) {
    console.error(`[Sync] Error crítico: ${err.message}`);

    // Estado: error (string corto)
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - new Date(startedAt).getTime();
    const summary = `${finishedAt} — ${err.message}`.slice(0, 400);
    await kvPut(env, 'sync:last_error', summary);
    await safeNotifyHealthcheck(notifyHealthcheckFn, env, 'fail');

    return {
      status:      'error',
      source,
      started_at:  startedAt,
      finished_at: finishedAt,
      duration_ms: durationMs,
      error:       err.message,
    };
  }
}

async function safeNotifyHealthcheck(notifyFn, env, kind) {
  try {
    await notifyFn(env, kind);
  } catch {
    // La observabilidad nunca cambia el resultado del sync ni oculta su error.
    console.warn(`[Healthcheck] No se pudo enviar la señal ${kind}.`);
  }
}

// ── Status ───────────────────────────────────────────────────────────────────

async function readStatus(env) {
  const [lastStarted, lastOk, lastError, indexNowResult, indexNowError, meta, catalogHead] = await Promise.all([
    kvGet(env, 'sync:last_started'),
    kvGet(env, 'sync:last_ok'),
    kvGet(env, 'sync:last_error'),
    kvGet(env, 'indexnow:last_result'),
    kvGet(env, 'indexnow:last_error'),
    readR2Json(env, 'meta.json'),
    readR2Head(env, 'catalog.json'),
  ]);

  return {
    status: 'ok',
    checked_at: new Date().toISOString(),
    kv: {
      last_started: lastStarted,
      last_ok:      lastOk,
      last_error:   lastError,
    },
    indexnow: {
      last_result: parseJsonOrValue(indexNowResult),
      last_error: parseJsonOrValue(indexNowError),
    },
    r2: {
      meta,
      catalog: catalogHead,
    },
  };
}

async function readR2Json(env, key) {
  try {
    const obj = await env.CATALOG_R2.get(key);
    if (!obj) return { exists: false };
    return {
      exists: true,
      size: obj.size ?? null,
      uploaded: dateToIso(obj.uploaded),
      etag: obj.etag || obj.httpEtag || null,
      body: JSON.parse(await obj.text()),
    };
  } catch (e) {
    return { exists: false, error: e.message };
  }
}

async function readR2Head(env, key) {
  try {
    const obj = await env.CATALOG_R2.head(key);
    if (!obj) return { exists: false };
    return {
      exists: true,
      size: obj.size ?? null,
      uploaded: dateToIso(obj.uploaded),
      etag: obj.etag || obj.httpEtag || null,
    };
  } catch (e) {
    return { exists: false, error: e.message };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function kvGet(env, key) {
  try {
    return await env.AMADO_KV.get(key);
  } catch (e) {
    console.error(`[Sync] Error leyendo KV ${key}:`, e.message);
    return null;
  }
}

async function kvPut(env, key, value) {
  try {
    await env.AMADO_KV.put(key, value);
  } catch (e) {
    console.error(`[Sync] Error escribiendo KV ${key}:`, e.message);
  }
}

async function kvDelete(env, key) {
  try {
    await env.AMADO_KV.delete(key);
  } catch (e) {
    console.error(`[Sync] Error borrando KV ${key}:`, e.message);
  }
}

function dateToIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function parseJsonOrValue(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
