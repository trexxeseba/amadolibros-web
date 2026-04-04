/**
 * worker-sync/index.js
 *
 * Entry point del Worker de sincronización de catálogo.
 *
 * Triggers:
 *   scheduled(event) — cron "0 *\/6 * * *" (cada 6 horas)
 *   fetch(request)   — POST /trigger con header Authorization: Bearer <SYNC_SECRET>
 *                      para disparar sync manualmente sin esperar al cron
 *
 * Flujo de runSync():
 *   1. Obtener ML access token (meli-auth.js — KV lock + retry)
 *   2. Descargar catálogo completo (meli-catalog.js — scroll + batch details)
 *   3. Escribir catalog.json y meta.json en R2 (r2-publish.js)
 *   4. Guardar estado mínimo en KV (sync:state:worker)
 *
 * KV keys escritas por este Worker:
 *   auth:refresh_token       — compartido con Pages (se actualiza en meli-auth.js)
 *   auth:refresh_token_lock  — mutex para el intercambio de token
 *   sync:state:worker        — estado del último sync { status, started_at, finished_at, total_items, error }
 *
 * KV keys que este Worker NO escribe (esquemas obsoletos):
 *   catalog:full, catalog_index, catalog_index:*, item:MLU*
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
      message: 'Sync iniciado en background. Consultá KV sync:state:worker para el resultado.',
    });
  },
};

// ── Sync principal ────────────────────────────────────────────────────────────

async function runSync(env) {
  const startedAt = new Date().toISOString();
  console.log(`[Sync] Iniciando sync completo — ${startedAt}`);

  await writeState(env, {
    status:     'running',
    started_at: startedAt,
    error:      null,
  });

  try {
    // 1. Auth
    const accessToken = await getAccessToken(env);
    console.log('[Sync] Access token obtenido.');

    // 2. Catálogo
    const catalog = await buildCatalog(env, accessToken);

    // 3. Publicar en R2
    const finishedAt   = new Date().toISOString();
    const durationMs   = Date.now() - new Date(startedAt).getTime();
    const syncMeta = {
      total:          catalog.total,
      updated_at:     catalog.updated_at,
      last_full_sync: finishedAt,
      duration_ms:    durationMs,
      status:         'ok',
    };
    await publishToR2(env, catalog, syncMeta);

    // 4. Estado final
    await writeState(env, {
      status:      'ok',
      started_at:  startedAt,
      finished_at: finishedAt,
      duration_ms: durationMs,
      total_items: catalog.total,
      error:       null,
    });

    console.log(`[Sync] Completado: ${catalog.total} items en ${Math.round(durationMs / 1000)}s`);

  } catch (err) {
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - new Date(startedAt).getTime();
    console.error(`[Sync] Error crítico: ${err.message}`);

    await writeState(env, {
      status:      'error',
      started_at:  startedAt,
      finished_at: finishedAt,
      duration_ms: durationMs,
      total_items: null,
      error:       err.message.slice(0, 400),
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function writeState(env, state) {
  try {
    await env.AMADO_KV.put('sync:state:worker', JSON.stringify(state));
  } catch (e) {
    console.error('[Sync] Error escribiendo sync:state:worker:', e.message);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
