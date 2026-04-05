/**
 * worker-sync/index.js
 *
 * Entry point del Worker de sincronización de catálogo.
 *
 * Triggers:
 *   scheduled(event) — cron "15 7 * * *" (07:15 UTC = 04:15 Montevideo)
 *   fetch(request)   — POST /trigger con header Authorization: Bearer <SYNC_SECRET>
 *                      para disparar sync manualmente sin esperar al cron
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
 *   sync:last_ok             — ISO timestamp del último sync exitoso
 *   sync:last_error          — string corto del último error (ausente si el último sync fue ok)
 *
 * KV keys que este Worker NO escribe:
 *   catalog:full, catalog_index, catalog_index:*, item:MLU*  — esquemas obsoletos
 *
 * Nota de tiempo de ejecución:
 *   Con ~16.000 items, el sync tarda ~5-8 minutos (principalmente I/O hacia ML API).
 *   El tiempo de CPU real es < 1 segundo (parsing JSON, array ops).
 *   Cron triggers en CF Workers tienen 15 minutos de wall-clock time — suficiente.
 *   Para el fetch trigger el sync corre en ctx.waitUntil() — la respuesta HTTP
 *   vuelve inmediatamente, el sync continúa en background.
 */

import { getAccessToken } from './meli-auth.js';
import { buildCatalog   } from './meli-catalog.js';
import { publishToR2    } from './r2-publish.js';

export default {
  // ── Cron trigger ────────────────────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    console.log(`[Worker] Cron trigger: ${new Date().toISOString()}`);
    ctx.waitUntil(runSync(env));
  },

  // ── Manual trigger ───────────────────────────────────────────────────────────
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Solo acepta POST /trigger
    if (request.method !== 'POST' || url.pathname !== '/trigger') {
      return json({ error: 'Not found. Use POST /trigger.' }, 404);
    }

    // Validar SYNC_SECRET
    if (!env.SYNC_SECRET) {
      console.error('[Worker] SYNC_SECRET no configurado. Ejecutá: wrangler secret put SYNC_SECRET');
      return json({ error: 'Server misconfiguration: SYNC_SECRET not set.' }, 500);
    }
    const authHeader = request.headers.get('Authorization') || '';
    if (authHeader !== `Bearer ${env.SYNC_SECRET}`) {
      return json({ error: 'Unauthorized.' }, 401);
    }

    console.log(`[Worker] Trigger manual: ${new Date().toISOString()}`);
    ctx.waitUntil(runSync(env));

    return json({
      status:  'SYNC_TRIGGERED',
      message: 'Sync iniciado en background. Consultá KV sync:last_ok / sync:last_error para el resultado.',
    });
  },
};

// ── Sync principal ────────────────────────────────────────────────────────────

async function runSync(env) {
  const startedAt = new Date().toISOString();
  console.log(`[Sync] Iniciando sync completo — ${startedAt}`);

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
    };
    await publishToR2(env, catalog, syncMeta);

    // 4. Estado: éxito
    await kvPut(env, 'sync:last_ok', finishedAt);

    console.log(`[Sync] Completado: ${catalog.total} items en ${Math.round(durationMs / 1000)}s`);

  } catch (err) {
    console.error(`[Sync] Error crítico: ${err.message}`);

    // Estado: error (string corto)
    const summary = `${new Date().toISOString()} — ${err.message}`.slice(0, 400);
    await kvPut(env, 'sync:last_error', summary);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function kvPut(env, key, value) {
  try {
    await env.AMADO_KV.put(key, value);
  } catch (e) {
    console.error(`[Sync] Error escribiendo KV ${key}:`, e.message);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
