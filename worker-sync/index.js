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
 *
 * Flujo de runSync():
 *   1. Obtener ML access token (meli-auth.js — KV lock + retry)
 *   2. Descargar catálogo completo (meli-catalog.js — scroll + batch details)
 *   3. Escribir catalog.json y meta.json en R2 (r2-publish.js)
 *   4. Guardar estado mínimo en KV (sync:last_ok / sync:last_error)
 *
 * KV keys escritas por este Worker:
 *   auth:refresh_token       — compartido con Pages (se actualiza en meli-auth.js)
 *   auth:refresh_token_lock  — mutex para el intercambio de token
 *   sync:last_started        — ISO timestamp del último sync iniciado
 *   sync:last_ok             — ISO timestamp del último sync exitoso
 *   sync:last_error          — string corto del último error (ausente si el último sync fue ok)
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
  const bytes = new TextEncoder().encode(JSON.stringify(catalog)).length;
  return {
    total: items.length,
    active,
    paused,
    active_without_stock: activeWithoutStock,
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

// ── Sync principal ────────────────────────────────────────────────────────────

async function runSync(env, options = {}) {
  const startedAt = new Date().toISOString();
  const source = options.source || 'unknown';
  console.log(`[Sync] Iniciando sync completo — ${startedAt} | source=${source}`);
  await kvPut(env, 'sync:last_started', startedAt);

  try {
    // 1. Auth
    const accessToken = await getAccessToken(env);
    console.log('[Sync] Access token obtenido.');

    // 2. Catálogo
    const catalog = await buildCatalog(env, accessToken);

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
    await publishToR2(env, catalog, syncMeta);

    // 4. Estado: éxito
    await kvPut(env, 'sync:last_ok', finishedAt);
    await kvDelete(env, 'sync:last_error');

    console.log(`[Sync] Completado: ${catalog.total} items en ${Math.round(durationMs / 1000)}s`);
    return {
      status:         'ok',
      source,
      total:          catalog.total,
      updated_at:     catalog.updated_at,
      started_at:     startedAt,
      finished_at:    finishedAt,
      duration_ms:    durationMs,
    };

  } catch (err) {
    console.error(`[Sync] Error crítico: ${err.message}`);

    // Estado: error (string corto)
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - new Date(startedAt).getTime();
    const summary = `${finishedAt} — ${err.message}`.slice(0, 400);
    await kvPut(env, 'sync:last_error', summary);

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

// ── Status ───────────────────────────────────────────────────────────────────

async function readStatus(env) {
  const [lastStarted, lastOk, lastError, meta, catalogHead] = await Promise.all([
    kvGet(env, 'sync:last_started'),
    kvGet(env, 'sync:last_ok'),
    kvGet(env, 'sync:last_error'),
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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
