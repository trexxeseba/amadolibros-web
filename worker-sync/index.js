import { IMAGE_SOURCE_POLICY_VERSION } from '../functions/_shared/image-source-policy.js';
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
 *                    — GET /bing-webmaster/summary consulta Bing Webmaster
 *                      en modo solo lectura con el mismo header.
 *                    — POST /measure descarga y mide sin escribir R2 ni estado de sync.
 *                    — POST /publish-preview-catalog escribe únicamente el catálogo
 *                      separado de STOCK-1 (prefijo stock1-preview/*) cuando la
 *                      versión aislada lo habilita.
 *                    — POST /publish-production-catalog escribe el catálogo
 *                      productivo separado (prefijo catalog/*, nunca
 *                      stock1-preview/*) cuando PRODUCTION_PAUSED_CATALOG_PUBLISH_ENABLED
 *                      lo habilita. No toca catalog.json ni meta.json.
 *                    — POST /visits/sync dispara manualmente RADAR DATA 1
 *                      (issue #275) — ingesta de visitas ML — cuando
 *                      VISITS_SYNC_ENABLED lo habilita.
 *                    — GET /visits/summary?ids=MLU1,MLU2 devuelve ventanas
 *                      7/30/90 de visitas ya persistidas en D1. Sólo lectura.
 *                    — GET /visits/daily?item_id=MLU1 devuelve la serie
 *                      diaria cruda de un item_id (readout de validación).
 *
 * Flujo de runSync():
 *   1. Obtener ML access token (meli-auth.js — KV lock + retry)
 *   2. Descargar catálogo completo (meli-catalog.js — scroll + batch details)
 *   3. Escribir catalog.json y meta.json en R2 (r2-publish.js)
 *   4. Notificar a IndexNow únicamente URLs indexables que cambiaron
 *   5. Guardar estado mínimo en KV (sync:last_ok / sync:last_error)
 *
 * Flujo de runVisitsSync() — RADAR DATA 1 (issue #275), apagado por
 * defecto (VISITS_SYNC_ENABLED debe ser 'true'):
 *   1. Leer los item_id activos desde catalog.json en R2 (no vuelve a
 *      pedirle el catálogo a ML — reutiliza lo que runSync ya publicó).
 *   2. Pedir GET /items/visits?ids=...&date_from=...&date_to=... en lotes
 *      (ml-visits.js), para cada día calendario en la ventana de backfill.
 *   3. Guardar cada fila en D1 (visits-store.js, tabla item_daily_visits)
 *      de forma idempotente por (item_id, visit_date).
 *   Un lote fallido no aborta la corrida completa: ML documenta hasta 48h
 *   de demora en consolidar visitas, así que el día se reintenta solo en
 *   la próxima corrida (VISITS_BACKFILL_DAYS).
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
import { buildCatalog, createSyncRetryBudget } from './meli-catalog.js';
import { publishToR2    } from './r2-publish.js';
import { notifyHealthcheck } from './healthcheck.js';
import { processStockWaitlist } from './stock-waitlist-notifier.js';
import { readPreviousPublicCatalog, submitIndexNow } from './indexnow.js';
import { getBingWebmasterReadOnlySummary } from './bing-webmaster.js';
import { syncCoverMirror } from './cover-mirror.js';
import { processPendingGa4Purchases } from '../functions/api/_ga4_measurement.js';
import {
  addCompressedIndexes,
  buildManifest,
  buildPausedCatalogArtifacts,
  PAUSED_MANIFEST_KEY,
  PAUSED_PREFIX_ROOT,
  PRODUCTION_MANIFEST_KEY,
  PRODUCTION_PREFIX_ROOT,
} from './paused-catalog.js';
import { fetchVisitsRange, fetchVisitsTimeWindow, DEFAULT_VISITS_BATCH_SIZE } from './ml-visits.js';
import { getDailyVisits, getVisitWindows, upsertDailyVisits } from './visits-store.js';

export const STOCK1_PREVIEW_CATALOG_KEY = PAUSED_MANIFEST_KEY;
export const PRODUCTION_CATALOG_KEY = PRODUCTION_MANIFEST_KEY;

export default {
  // ── Cron trigger ────────────────────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    console.log(`[Worker] Cron trigger: ${new Date().toISOString()}`);
    if (event?.cron === '*/5 * * * *') {
      // Backfill autónomo: cada 5 minutos hasta cubrir todo. Una vez completo,
      // baja solo a una ejecución por hora para revalidar el ciclo de 30 días.
      const minute = new Date().getUTCMinutes();
      ctx.waitUntil(Promise.all([
        runCoverMirror(env, {
          limit: configuredCoverMirrorBatchSize(env),
          maintenanceMinute: minute,
        }),
        processPendingGa4Purchases(env).catch(error => {
          console.error('[GA4 purchase] Error de reintento', error?.name || 'Error');
          return { status: 'error' };
        }),
      ]));
      return;
    }
    ctx.waitUntil((async () => {
      await runSync(env, { source: 'cron' });
      // RADAR DATA 1 (issue #275): corre después de runSync para leer el
      // catalog.json recién publicado. Apagado por defecto — nunca hace
      // nada salvo que VISITS_SYNC_ENABLED='true'. Nunca lanza (siempre
      // devuelve un status), así que jamás enmascara el resultado de runSync.
      await runVisitsSync(env, { source: 'cron' });
    })());
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

    if (request.method === 'POST' && url.pathname === '/visits/sync') {
      if (String(env.VISITS_SYNC_ENABLED) !== 'true') {
        return json({ error: 'Not found.' }, 404);
      }
      const mode = url.searchParams.get('mode') || 'async';
      if (mode === 'await') {
        const result = await runVisitsSync(env, { source: 'manual-await' });
        return json(result, result.status === 'error' ? 500 : 200);
      }
      ctx.waitUntil(runVisitsSync(env, { source: 'manual-async' }));
      return json({ status: 'VISITS_SYNC_TRIGGERED', mode: 'async' }, 202);
    }

    if (request.method === 'GET' && url.pathname === '/visits/summary') {
      const ids = (url.searchParams.get('ids') || '').split(',').map(id => id.trim()).filter(Boolean);
      if (ids.length === 0) {
        return json({ error: 'Falta ?ids=MLU1,MLU2 (máximo 20 por consulta).' }, 400);
      }
      if (ids.length > 20) {
        return json({ error: 'Máximo 20 item_id por consulta a /visits/summary.' }, 400);
      }
      const asOf = url.searchParams.get('as_of') || undefined;
      const items = await Promise.all(ids.map(id => getVisitWindows(env, id, { asOf })));
      return json({ generated_at: new Date().toISOString(), items });
    }

    if (request.method === 'GET' && url.pathname === '/visits/daily') {
      const itemId = url.searchParams.get('item_id');
      if (!itemId) return json({ error: 'Falta ?item_id=MLUxxxxxxxxx.' }, 400);
      const from = url.searchParams.get('from') || undefined;
      const to = url.searchParams.get('to') || undefined;
      const daily = await getDailyVisits(env, itemId, { from, to });
      return json({ item_id: itemId, from: from || null, to: to || null, daily });
    }

    if (request.method === 'GET' && url.pathname === '/visits/verify') {
      const itemId = url.searchParams.get('item_id');
      if (!itemId) return json({ error: 'Falta ?item_id=MLUxxxxxxxxx.' }, 400);
      const last = Number(url.searchParams.get('last') || 90);
      try {
        const accessToken = await getAccessToken(env);
        const result = await fetchVisitsTimeWindow(itemId, accessToken, { last });
        return json({ item_id: itemId, last, source: 'items_visits_time_window', result });
      } catch (error) {
        return json({ error: String(error?.message || 'Error').slice(0, 400) }, 502);
      }
    }

    if (request.method === 'GET' && url.pathname === '/bing-webmaster/summary') {
      const result = await getBingWebmasterReadOnlySummary(env);
      return json(result, result.status === 'error' ? 502 : 200);
    }

    if (request.method === 'POST' && url.pathname === '/measure') {
      const result = await runMeasure(env);
      return json(result, result.status === 'measured' ? 200 : 500);
    }

    if (request.method === 'POST' && url.pathname === '/cover-mirror') {
      const requested = Number(url.searchParams.get('limit') || env.COVER_MIRROR_BATCH_SIZE || 250);
      const limit = Math.min(1000, Math.max(1, Number.isFinite(requested) ? requested : 250));
      const result = await runCoverMirror(env, { limit });
      return json(result, result.status === 'completed' ? 200 : 500);
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
      return json({ error: 'Not found. Use POST /measure, POST /trigger, GET /status or GET /bing-webmaster/summary.' }, 404);
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
    const catalog = await buildCatalogFn(env, accessToken, {
      // Preview conserva su aislamiento: la caché compartida de galerías y
      // el mirror R2 se actualizan únicamente desde la publicación real.
      enrichCatalogPictures: scope === 'production',
    });
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

    let coverMirror = null;
    if (scope === 'production') {
      try {
        coverMirror = await syncCoverMirror(env, catalog, {
          limit: Math.max(20, Number(env.COVER_MIRROR_BATCH_SIZE) || 100),
          includePaused: true,
        });
      } catch (error) {
        console.warn(`[${errorLabel} catalog] Mirror de galerías pendiente: ${error.message}`);
        coverMirror = {
          status: 'error',
          error: String(error?.message || 'Error').slice(0, 240),
        };
      }
    }

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
      cover_mirror: coverMirror,
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
  syncCoverMirrorFn = syncCoverMirror,
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
      enrichCatalogPictures: true,
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

    // Portadas propias: R2 es el origen duradero y Mercado Libre queda como
    // respaldo durante el backfill. Un fallo de imagen nunca revierte un
    // catálogo ya publicado, pero queda visible en el resultado del sync.
    let coverMirror;
    try {
      // Un catálogo nuevo invalida cualquier marca de backfill anterior. La
      // marca versionada también protege contra una corrida vieja que termine
      // después y vuelva a escribir su propio estado.
      if (env?.COVER_R2) await kvDelete(env, 'cover-mirror:backfill_complete');
      coverMirror = await syncCoverMirrorFn(env, catalog);
      await persistCoverMirrorState(env, coverMirror, catalog);
    } catch (error) {
      console.error(`[Cover mirror] Error: ${error?.message || 'Error'}`);
      coverMirror = { status: 'error', error: String(error?.message || 'Error').slice(0, 200) };
    }

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
      cover_mirror: coverMirror,
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

// ── RADAR DATA 1 (issue #275) — visitas ML ──────────────────────────────────

const VISITS_AVAILABILITY_LAG_DAYS_DEFAULT = 3; // ML documenta hasta 48h de demora en consolidar el conteo.
const VISITS_BACKFILL_DAYS_DEFAULT = 1; // día lagueado únicamente; ver nota de costo en el PR antes de subirlo.

function positiveIntEnv(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Fechas 'YYYY-MM-DD' consecutivas (oldest→newest), terminando en
 * referenceDate menos lagDays. Ej.: lagDays=3, count=1, referenceDate=hoy
 * → [hoy-3]. Con count=3 → [hoy-5, hoy-4, hoy-3].
 */
export function lastNCalendarDates(referenceDate, lagDays, count) {
  const base = new Date(Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate(),
  ));
  const dates = [];
  for (let i = count - 1; i >= 0; i--) {
    const day = new Date(base);
    day.setUTCDate(day.getUTCDate() - lagDays - i);
    dates.push(day.toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * Lista de item_id a auditar: se lee directamente del catalog.json que
 * runSync ya publicó en R2 — RADAR DATA 1 no vuelve a pedirle el listado
 * completo a Mercado Libre.
 */
export async function readCatalogItemIdsFromR2(env) {
  try {
    const object = await env?.CATALOG_R2?.get?.('catalog.json');
    if (!object) return [];
    const catalog = JSON.parse(await object.text());
    return (catalog?.items || []).map(item => item?.id).filter(Boolean);
  } catch (error) {
    console.error(`[Visits] No se pudo leer catalog.json: ${error?.message || 'Error'}`);
    return [];
  }
}

/**
 * Ingesta diaria de visitas (RADAR DATA 1). Apagada por defecto: exige
 * VISITS_SYNC_ENABLED='true'. Sólo lectura de Mercado Libre + escritura en
 * D1 (item_daily_visits) — nunca toca catalog.json, precio ni estado de
 * publicación.
 */
export async function runVisitsSync(env, options = {}, {
  getAccessTokenFn = getAccessToken,
  readCatalogItemIdsFn = readCatalogItemIdsFromR2,
  fetchVisitsRangeFn = fetchVisitsRange,
  upsertDailyVisitsFn = upsertDailyVisits,
  now = () => new Date(),
} = {}) {
  const startedAt = now().toISOString();
  const source = options.source || 'unknown';

  if (String(env?.VISITS_SYNC_ENABLED) !== 'true') {
    return { status: 'skipped', reason: 'visits_sync_disabled', started_at: startedAt, source };
  }

  try {
    const accessToken = await getAccessTokenFn(env);
    const itemIds = await readCatalogItemIdsFn(env);
    if (itemIds.length === 0) {
      return {
        status: 'error',
        started_at: startedAt,
        source,
        error: 'catalog.json sin items en R2 — no hay publicaciones para auditar visitas.',
      };
    }

    const lagDays = positiveIntEnv(env?.VISITS_AVAILABILITY_LAG_DAYS, VISITS_AVAILABILITY_LAG_DAYS_DEFAULT);
    const backfillDays = positiveIntEnv(env?.VISITS_BACKFILL_DAYS, VISITS_BACKFILL_DAYS_DEFAULT);
    const batchSize = positiveIntEnv(env?.VISITS_BATCH_SIZE, DEFAULT_VISITS_BATCH_SIZE);
    const targetDates = lastNCalendarDates(now(), lagDays, backfillDays);
    const retryBudget = createSyncRetryBudget();

    let rowsUpserted = 0;
    let requestBatches = 0;
    let failedBatches = 0;

    for (const date of targetDates) {
      for (let offset = 0; offset < itemIds.length; offset += batchSize) {
        const batch = itemIds.slice(offset, offset + batchSize);
        requestBatches++;
        try {
          const entries = await fetchVisitsRangeFn(batch, accessToken, {
            dateFrom: date,
            dateTo: date,
            retryBudget,
          });
          const rows = entries.map(entry => ({
            item_id: entry.item_id,
            visit_date: date,
            visits: entry.total_visits,
            source: 'items_visits_range',
            observed_at: startedAt,
          }));
          await upsertDailyVisitsFn(env, rows);
          rowsUpserted += rows.length;
        } catch (error) {
          failedBatches++;
          console.error(
            `[Visits] Lote ${offset}-${offset + batch.length} (${date}) falló: ${error?.message || 'Error'}`
          );
        }
      }
    }

    return {
      status: failedBatches > 0 ? 'partial' : 'ok',
      started_at: startedAt,
      finished_at: now().toISOString(),
      source,
      dates: targetDates,
      items_considered: itemIds.length,
      batch_size: batchSize,
      request_batches: requestBatches,
      failed_batches: failedBatches,
      rows_upserted: rowsUpserted,
    };
  } catch (error) {
    return {
      status: 'error',
      started_at: startedAt,
      source,
      error: String(error?.message || 'Error').slice(0, 400),
    };
  }
}

export function configuredCoverMirrorBatchSize(env) {
  const parsed = Number(env?.COVER_MIRROR_BATCH_SIZE || 250);
  return Math.min(1000, Math.max(1, Number.isFinite(parsed) ? parsed : 250));
}

function catalogBackfillVersion(catalog) {
  return String(catalog?.updated_at || catalog?.last_full_sync || '').trim() || null;
}

function parseBackfillMarker(value) {
  if (!value) return null;
  if (value === 'true') return { completed: true, catalog_version: null };
  try {
    const parsed = JSON.parse(value);
    return parsed?.completed === true ? parsed : null;
  } catch {
    return null;
  }
}

export async function persistCoverMirrorState(env, result, catalog) {
  const catalogVersion = catalogBackfillVersion(catalog);
  await kvPut(env, 'cover-mirror:last_result', JSON.stringify({
    at: new Date().toISOString(),
    status: result.status,
    catalog_version: catalogVersion,
    attempted: result.attempted ?? null,
    failed: result.failed ?? null,
    pending: result.pending ?? null,
    valid_copies: result.valid_copies ?? null,
    ai_upscaled: result.ai_upscaled ?? null,
    quality_pending: result.quality_pending ?? null,
    source_policy_version: result.source_policy_version ?? null,
    scope_images: result.scope_images ?? null,
    needs_better_source: result.needs_better_source ?? null,
    paused_progress: result.paused_progress ?? null,
    manifest_retries: result.manifest_retries ?? null,
  }));
  if (result.status === 'completed' && result.pending === 0) {
    await kvPut(env, 'cover-mirror:backfill_complete', JSON.stringify({
      completed: true,
      source_policy_version: IMAGE_SOURCE_POLICY_VERSION,
      catalog_version: catalogVersion,
      at: new Date().toISOString(),
    }));
  } else if (result.status === 'completed') {
    await kvDelete(env, 'cover-mirror:backfill_complete');
  }
}

export async function runCoverMirror(env, { limit = 250, maintenanceMinute = null } = {}, {
  syncCoverMirrorFn = syncCoverMirror,
} = {}) {
  try {
    const object = await env?.CATALOG_R2?.get?.('catalog.json');
    if (!object) return { status: 'error', error: 'catalog.json no disponible.' };
    const catalog = JSON.parse(await object.text());
    if (maintenanceMinute !== null && Number(maintenanceMinute) !== 0) {
      const marker = parseBackfillMarker(await kvGet(env, 'cover-mirror:backfill_complete'));
      const currentVersion = catalogBackfillVersion(catalog);
      if (marker?.source_policy_version === IMAGE_SOURCE_POLICY_VERSION && marker?.catalog_version && marker.catalog_version === currentVersion) {
        return { status: 'skipped', reason: 'hourly-maintenance', catalog_version: currentVersion };
      }
    }
    // Include one full paused block per pass; preserve galleries, not only index thumbnails.
    const pausedManifest = await readR2Json(env, 'catalog/manifest.json');
    if (pausedManifest.error) throw new Error('Paused manifest unreadable; completion withheld: '+pausedManifest.error);
    const descriptor = pausedManifest?.body?.current;
    let cursor = null;
    let pausedItems = [];
    if (descriptor?.block_prefix && Number.isInteger(descriptor.block_count) && descriptor.block_count > 0) {
      try { cursor = JSON.parse(await kvGet(env, 'cover-mirror:paused_cursor') || 'null'); } catch {}
      if (!cursor || cursor.block_count !== descriptor.block_count || cursor.policy !== IMAGE_SOURCE_POLICY_VERSION) {
        cursor = { index: 0, remaining: descriptor.block_count, block_count: descriptor.block_count, policy: IMAGE_SOURCE_POLICY_VERSION };
      }
      if (cursor.catalog_version !== descriptor.version) {
        cursor.remaining = cursor.block_count;
        cursor.catalog_version = descriptor.version;
      }
      const block = await readR2Json(env, `${descriptor.block_prefix}/block-${String(cursor.index).padStart(3,'0')}.json`);
      if (!Array.isArray(block?.body?.items)) throw new Error('Paused image block unavailable; cursor retained.');
      const activeIds = new Set(catalog.items.map(item => item.id));
      pausedItems = block.body.items.filter(item => item.status === 'paused' && !activeIds.has(item.id));
    }
    const result = await syncCoverMirrorFn(env, { ...catalog, items: [...catalog.items, ...pausedItems] }, { limit, includePaused: true });
    if (cursor && result.status === 'completed') {
      if ((result.source_discovery_pending ?? result.pending) === 0) {
        cursor.index = (cursor.index + 1) % cursor.block_count;
        cursor.remaining = Math.max(0, cursor.remaining - 1);
        await kvPut(env, 'cover-mirror:paused_cursor', JSON.stringify(cursor));
      }
      result.paused_progress = cursor;
      result.pending += cursor.remaining > 0 ? 1 : 0;
    }
    await persistCoverMirrorState(env, result, catalog);
    return result;
  } catch (error) {
    return { status: 'error', error: String(error?.message || 'Error').slice(0, 240) };
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
  const [lastStarted, lastOk, lastError, indexNowResult, indexNowError, coverMirrorResult, coverMirrorComplete, meta, catalogHead, coverManifest] = await Promise.all([
    kvGet(env, 'sync:last_started'),
    kvGet(env, 'sync:last_ok'),
    kvGet(env, 'sync:last_error'),
    kvGet(env, 'indexnow:last_result'),
    kvGet(env, 'indexnow:last_error'),
    kvGet(env, 'cover-mirror:last_result'),
    kvGet(env, 'cover-mirror:backfill_complete'),
    readR2Json(env, 'meta.json'),
    readR2Head(env, 'catalog.json'),
    readBucketHead(env?.COVER_R2, 'covers/v1/manifest.json'),
  ]);

  const parsedCoverMirrorComplete = parseBackfillMarker(coverMirrorComplete);
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
    cover_mirror: {
      last_result: parseJsonOrValue(coverMirrorResult),
      backfill_complete: parsedCoverMirrorComplete?.completed === true,
      backfill_catalog_version: parsedCoverMirrorComplete?.catalog_version || null,
    },
    r2: {
      meta,
      catalog: catalogHead,
      cover_manifest: coverManifest,
    },
  };
}

async function readBucketHead(bucket, key) {
  try {
    const object = await bucket?.head?.(key);
    if (!object) return { exists: false };
    return {
      exists: true,
      size: object.size ?? null,
      uploaded: dateToIso(object.uploaded),
      etag: object.etag || object.httpEtag || null,
    };
  } catch (error) {
    return { exists: false, error: error.message };
  }
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
