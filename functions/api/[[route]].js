// functions/api/[[route]].js
// VERSIÓN 6.0 - KV POR ENTORNO + SYNC:STATE SLIM + DEBUG ENDPOINT
// Preview y producción NO comparten claves de KV.
// sync:state no contiene arrays; diagnóstico en sync:debug:<env>

const APP_ID = '4741021817925208';
const USER_ID = '440298103';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── Helpers de entorno ──────────────────────────────────────────────────────

/**
 * Devuelve un prefijo corto y estable para las claves de KV según el hostname.
 * Prod → "prod" | Preview → primer segmento del hostname (ej. "fix-sync-v2")
 */
function getEnvPrefix(url) {
  const host = url.hostname;
  if (host === 'www.amadolibros.com' || host === 'amadolibros.com') return 'prod';
  // Preview URLs: <branch>.amadolibros-web.pages.dev
  const firstSegment = host.split('.')[0].replace(/[^a-z0-9-]/gi, '').slice(0, 24);
  return firstSegment || 'preview';
}

/** Claves de KV namespaceadas por entorno */
function kvKeys(prefix) {
  return {
    state: `sync:state:${prefix}`,
    lock:  `sync:lock:${prefix}`,
    debug: `sync:debug:${prefix}`,
  };
}

// ─── Cron trigger ────────────────────────────────────────────────────────────

export async function onScheduled(context) {
  const { env, waitUntil } = context;
  console.log('[Cron] Ejecutando sincronización programada...');
  waitUntil(handleCronSync(env));
}

// ─── Router principal ────────────────────────────────────────────────────────

export async function onRequest(context) {
  const { request, env, waitUntil } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '');

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (path === '/catalog' || path === '/home') {
    return handleGetCatalog(env, url);
  }
  if (path === '/sync') {
    waitUntil(handleSyncCatalog(env, url));
    return new Response(
      JSON.stringify({ status: 'SYNC_STARTED', message: 'La sincronización ha comenzado. Revisa /api/status para ver el progreso.' }),
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
  if (path === '/status') {
    return handleStatus(env, url);
  }
  if (path === '/debug-sync') {
    return handleDebugSync(env, url);
  }
  if (path === '/health') {
    return new Response(
      JSON.stringify({ status: 'OK', timestamp: new Date().toISOString(), version: '6.0', env: getEnvPrefix(url) }),
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
  if (path === '/reset' && (request.method === 'POST' || request.method === 'GET')) {
    waitUntil(handleReset(env, url));
    return new Response(
      JSON.stringify({ status: 'RESET_STARTED', message: 'Los datos de sincronización han sido limpiados. Ejecutá /api/sync para reiniciar.' }),
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
  if (path === '/webhooks/mercadolibre' && request.method === 'POST') {
    waitUntil(handleWebhook(request, env));
    return new Response(JSON.stringify({ status: 'received' }), { status: 200 });
  }

  return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
}

// ─── Lectura del catálogo ────────────────────────────────────────────────────

async function handleGetCatalog(env, url) {
  const page = parseInt(url.searchParams.get('page') || '0');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  const search = (url.searchParams.get('q') || '').toLowerCase().trim();
  const KV = env.AMADO_KV;

  try {
    const indexMeta = await KV.get('catalog_index', { type: 'json' });

    if (!indexMeta || !indexMeta.total || indexMeta.total === 0) {
      return new Response(JSON.stringify({
        items: [], total: 0, page, limit, pages: 0,
        message: 'El catálogo se está sincronizando. Intentá de nuevo en unos minutos.'
      }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } });
    }

    let allIds = [];
    for (let i = 0; i < indexMeta.chunks; i++) {
      const chunk = await KV.get(`catalog_index:${i}`, { type: 'json' });
      if (chunk && Array.isArray(chunk)) allIds = allIds.concat(chunk);
    }

    if (allIds.length === 0) {
      return new Response(JSON.stringify({
        items: [], total: 0, page, limit, pages: 0,
        message: 'Índice vacío. Ejecutá /sync/rebuild-index en el Worker.'
      }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } });
    }

    if (search) {
      const searchIds = allIds.slice(0, 2000);
      const allItems = (await Promise.all(
        searchIds.map(id => KV.get(`item:${id}`, { type: 'json' }).catch(() => null))
      )).filter(Boolean);
      const filtered = allItems.filter(item =>
        item.title?.toLowerCase().includes(search) ||
        item.author?.toLowerCase().includes(search) ||
        item.editorial?.toLowerCase().includes(search)
      );
      const paginated = filtered.slice(page * limit, (page + 1) * limit);
      return new Response(JSON.stringify({
        items: paginated, total: filtered.length, page, limit,
        pages: Math.ceil(filtered.length / limit)
      }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } });
    }

    const pageIds = allIds.slice(page * limit, (page + 1) * limit);
    const items = (await Promise.all(
      pageIds.map(id => KV.get(`item:${id}`, { type: 'json' }).catch(() => null))
    )).filter(Boolean);

    return new Response(JSON.stringify({
      items, total: allIds.length, page, limit,
      pages: Math.ceil(allIds.length / limit),
      has_more: (page + 1) * limit < allIds.length
    }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } });

  } catch (error) {
    console.error('handleGetCatalog error:', error);
    return new Response(JSON.stringify({ error: error.message, items: [], total: 0 }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

// ─── Sincronización ──────────────────────────────────────────────────────────

async function handleSyncCatalog(env, url) {
  const startTime = Date.now();
  const envPrefix = getEnvPrefix(url);
  const keys = kvKeys(envPrefix);

  // ── Lock ──────────────────────────────────────────────────────────────────
  const syncLock = await env.AMADO_KV.get(keys.lock);
  if (syncLock) return;
  await env.AMADO_KV.put(keys.lock, 'true', { expirationTtl: 600 });

  // ── Estado slim (sin arrays) ───────────────────────────────────────────────
  const writeState = async (fields) => {
    try {
      await env.AMADO_KV.put(keys.state, JSON.stringify(fields));
    } catch (e) {
      console.error('[Sync] Error escribiendo sync:state:', e.message);
    }
  };

  // ── Debug separado ────────────────────────────────────────────────────────
  let dbg = { phase: 'init', iteration: 0, offset: 0, last_step: 'lock_acquired', last_error_message: null, heartbeat_ts: Date.now() };
  const writeDebug = async () => {
    try {
      await env.AMADO_KV.put(keys.debug, JSON.stringify(dbg));
    } catch (e) { /* no-op: debug is best-effort */ }
  };

  // Estado de progreso slim (en KV, sin arrays)
  let slim = { status: 'running', phase: 'init', offset: 0, total: 0, synced_items: 0, last_update: new Date().toISOString(), error: null };

  // Arrays grandes: sólo en memoria, nunca en KV
  let allItemIds = [];
  let allItems   = [];

  try {
    dbg.last_step = 'before_auth';
    await writeDebug();

    const accessToken = await getAccessToken(env);

    dbg.last_step = 'auth_acquired';
    slim.phase = 'phase1_ids';
    slim.last_update = new Date().toISOString();
    await writeState(slim);
    await writeDebug();

    // ── Fase 1: obtener IDs ───────────────────────────────────────────────
    dbg.phase = 'phase1_ids';
    while (allItemIds.length < slim.total || slim.total === 0) {
      dbg.iteration++;
      dbg.offset = slim.offset;
      dbg.heartbeat_ts = Date.now();
      dbg.last_step = `phase1_iter_${dbg.iteration}_offset_${slim.offset}`;
      await writeDebug();

      const fetchUrl = `https://api.mercadolibre.com/users/${USER_ID}/items/search?offset=${slim.offset}&limit=100`;
      const res = await fetch(fetchUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });

      dbg.last_step = `phase1_response_${res.status}`;
      if (!res.ok) throw new Error(`Error obteniendo IDs en offset ${slim.offset}: ${res.status}`);

      const data = await res.json();
      if (slim.offset === 0) slim.total = data.paging?.total || 0;

      if (data.results && data.results.length > 0) {
        allItemIds.push(...data.results);
        slim.offset += data.results.length;
      } else {
        // Sin resultados: evitar bucle infinito
        break;
      }

      slim.last_update = new Date().toISOString();
      dbg.last_step = `phase1_kv_write_offset_${slim.offset}`;
      await writeState(slim);
      await writeDebug();

      if (slim.total !== 0 && slim.offset >= slim.total) break;
    }

    // ── Fase 2: obtener detalles ──────────────────────────────────────────
    dbg.phase = 'phase2_details';
    dbg.iteration = 0;
    slim.phase = 'phase2_details';
    await writeState(slim);

    const batchSize = 20;
    let processed = 0;

    while (processed < allItemIds.length) {
      dbg.iteration++;
      dbg.heartbeat_ts = Date.now();
      dbg.offset = processed;

      const chunkEnd = Math.min(processed + 500, allItemIds.length);
      const chunk = allItemIds.slice(processed, chunkEnd);

      dbg.last_step = `phase2_chunk_${processed}-${chunkEnd}`;
      await writeDebug();

      for (let i = 0; i < chunk.length; i += batchSize) {
        const batch = chunk.slice(i, i + batchSize);
        const detailUrl = `https://api.mercadolibre.com/items?ids=${batch.join(',')}&attributes=id,title,price,status,available_quantity,thumbnail,pictures,permalink,condition,currency_id`;
        dbg.last_step = `phase2_batch_${processed + i}`;

        const detailRes = await fetch(detailUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
        if (detailRes.ok) {
          const details = await detailRes.json();
          for (const item of details) {
            if (item.code === 200 && item.body) {
              const b = item.body;
              allItems.push({
                id: b.id, title: b.title, price: b.price, currency: b.currency_id,
                status: b.status, stock: b.available_quantity, condition: b.condition,
                thumbnail: (b.pictures?.[0]?.url || b.thumbnail || '').replace('http://', 'https://').replace('-I.jpg', '-O.jpg'),
                permalink: b.permalink
              });
            }
          }
        }
      }

      processed = chunkEnd;
      slim.synced_items = allItems.length;
      slim.last_update = new Date().toISOString();
      await writeState(slim);
      await writeDebug();
    }

    // ── Fase 3: finalizar ─────────────────────────────────────────────────
    dbg.phase = 'phase3_finalize';
    dbg.last_step = 'writing_catalog_full';
    await writeDebug();

    await env.AMADO_KV.put('catalog:full', JSON.stringify(allItems), { expirationTtl: 604800 });

    const metadata = {
      total_items: allItems.length,
      total_in_ml: slim.total,
      last_sync: new Date().toISOString(),
      duration_seconds: Math.round((Date.now() - startTime) / 1000),
      env: envPrefix
    };
    await env.AMADO_KV.put('catalog:metadata', JSON.stringify(metadata), { expirationTtl: 604800 });

    // Marcar estado como completado y limpiar
    slim.status = 'completed';
    slim.phase = 'done';
    slim.synced_items = allItems.length;
    slim.last_update = new Date().toISOString();
    await writeState(slim);

    dbg.phase = 'done';
    dbg.last_step = 'completed';
    dbg.heartbeat_ts = Date.now();
    await writeDebug();

    console.log(`[Sync][${envPrefix}] Completado: ${allItems.length} items en ${metadata.duration_seconds}s`);

  } catch (error) {
    dbg.last_error_message = error.message.slice(0, 200);
    dbg.last_step = 'error';
    dbg.heartbeat_ts = Date.now();
    await writeDebug();

    slim.status = 'error';
    slim.error = error.message.slice(0, 200);
    slim.last_update = new Date().toISOString();
    await writeState(slim);

    console.error(`[Sync][${envPrefix}] Error crítico:`, error.message);
  } finally {
    await env.AMADO_KV.delete(keys.lock);
  }
}

// ─── /api/status ─────────────────────────────────────────────────────────────

async function handleStatus(env, url) {
  try {
    if (!env.AMADO_KV) {
      return new Response(JSON.stringify({ error: 'KV binding not available', hint: 'Configure AMADO_KV in CF Dashboard > Pages > Settings > Functions' }),
        { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }
    const envPrefix = getEnvPrefix(url);
    const keys = kvKeys(envPrefix);

    const syncStateRaw = await env.AMADO_KV.get(keys.state);
    const metadataRaw  = await env.AMADO_KV.get('catalog:metadata');

    let syncState = null;
    let metadata  = null;
    try { syncState = syncStateRaw ? JSON.parse(syncStateRaw) : null; } catch (e) { syncState = { parse_error: e.message, raw_length: (syncStateRaw || '').length }; }
    try { metadata  = metadataRaw  ? JSON.parse(metadataRaw)  : null; } catch (e) { metadata  = { parse_error: e.message }; }

    return new Response(
      JSON.stringify({ env: envPrefix, syncState, metadata }),
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message, stack: (err.stack || '').slice(0, 600) }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
}

// ─── /api/debug-sync ─────────────────────────────────────────────────────────

async function handleDebugSync(env, url) {
  try {
    if (!env.AMADO_KV) {
      return new Response(JSON.stringify({ error: 'KV binding not available', hint: 'Configure AMADO_KV in CF Dashboard > Pages > Settings > Functions' }),
        { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }
    const envPrefix = getEnvPrefix(url);
    const keys = kvKeys(envPrefix);

    const debugRaw = await env.AMADO_KV.get(keys.debug);
    let debug = null;
    try { debug = debugRaw ? JSON.parse(debugRaw) : null; } catch (e) { debug = { parse_error: e.message }; }

    return new Response(
      JSON.stringify({ env: envPrefix, debug }),
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message, stack: (err.stack || '').slice(0, 600) }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
}

// ─── Webhook ─────────────────────────────────────────────────────────────────

async function handleWebhook(request, env) {
  const payload = await request.json();
  const { topic, resource } = payload;
  if (topic !== 'items' || !resource) return;
  const itemId = resource.split('/').pop();
  if (!itemId) return;

  const accessToken = await getAccessToken(env);
  const res = await fetch(`https://api.mercadolibre.com/items/${itemId}?attributes=id,title,price,status,available_quantity,thumbnail,pictures,permalink,condition,currency_id`, { headers: { 'Authorization': `Bearer ${accessToken}` } });
  if (!res.ok) return;
  const b = await res.json();

  const catalog = await env.AMADO_KV.get('catalog:full', { type: 'json' });
  if (!catalog) return;

  const updatedItem = {
    id: b.id, title: b.title, price: b.price, currency: b.currency_id,
    status: b.status, stock: b.available_quantity, condition: b.condition,
    thumbnail: (b.pictures?.[0]?.url || b.thumbnail || '').replace('http://', 'https://').replace('-I.jpg', '-O.jpg'),
    permalink: b.permalink
  };

  const idx = catalog.findIndex(i => i.id === itemId);
  if (idx >= 0) { catalog[idx] = updatedItem; } else { catalog.unshift(updatedItem); }
  await env.AMADO_KV.put('catalog:full', JSON.stringify(catalog), { expirationTtl: 604800 });
}

// ─── getAccessToken v5.0 ─────────────────────────────────────────────────────
// Bloqueo distribuido + backoff exponencial
// Consenso Gemini 2.5 Flash + GPT-4.1: KV como única fuente de verdad

async function getAccessToken(env) {
  const CLIENT_SECRET = env.CLIENT_SECRET;
  const KV_KEY = 'auth:refresh_token';
  const LOCK_KEY = 'auth:refresh_token_lock';
  const LOCK_TTL = 60;       // segundos máximos del lock (KV mínimo: 60)
  const MAX_RETRIES = 5;
  const BASE_DELAY_MS = 200;

  for (let i = 0; i < MAX_RETRIES; i++) {
    let REFRESH_TOKEN = await env.AMADO_KV.get(KV_KEY);

    if (!REFRESH_TOKEN) {
      REFRESH_TOKEN = env.REFRESH_TOKEN;
      if (!REFRESH_TOKEN) {
        throw new Error('No se encontró Refresh Token en KV ni en variables de entorno. Configura auth:refresh_token en KV.');
      }
      await env.AMADO_KV.put(KV_KEY, REFRESH_TOKEN, { expirationTtl: 86400 * 30 });
      console.log('[Auth] Refresh Token inicializado en KV desde variable de entorno.');
    }

    const existingLock = await env.AMADO_KV.get(LOCK_KEY);
    if (existingLock) {
      const delay = BASE_DELAY_MS * Math.pow(2, i) + Math.random() * BASE_DELAY_MS;
      console.log(`[Auth] Lock activo, esperando ${Math.round(delay)}ms antes de reintentar (intento ${i+1}/${MAX_RETRIES})...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }

    await env.AMADO_KV.put(LOCK_KEY, Date.now().toString(), { expirationTtl: LOCK_TTL });

    try {
      const response = await fetch('https://api.mercadolibre.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: APP_ID,
          client_secret: CLIENT_SECRET,
          refresh_token: REFRESH_TOKEN,
        }),
      });

      const data = await response.json();

      if (response.ok && data.access_token) {
        if (data.refresh_token) {
          await env.AMADO_KV.put(KV_KEY, data.refresh_token, { expirationTtl: 86400 * 30 });
          console.log('[Auth] Nuevo Refresh Token guardado en KV exitosamente.');
        }
        await env.AMADO_KV.delete(LOCK_KEY);
        return data.access_token;

      } else if (data.error === 'invalid_grant' || (data.message && data.message.includes('invalid'))) {
        await env.AMADO_KV.delete(LOCK_KEY);
        const delay = BASE_DELAY_MS * Math.pow(2, i) + Math.random() * BASE_DELAY_MS;
        console.warn(`[Auth] Refresh Token inválido (race condition). Reintentando en ${Math.round(delay)}ms (intento ${i+1}/${MAX_RETRIES})...`);
        await new Promise(resolve => setTimeout(resolve, delay));

      } else {
        await env.AMADO_KV.delete(LOCK_KEY);
        throw new Error(`Error obteniendo token de ML (${response.status}): ${JSON.stringify(data)}`);
      }

    } catch (err) {
      await env.AMADO_KV.delete(LOCK_KEY).catch(() => {});
      if (i === MAX_RETRIES - 1) throw err;
      const delay = BASE_DELAY_MS * Math.pow(2, i);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error('[Auth] Fallo al obtener Access Token después de 5 reintentos. Verifica el Refresh Token en KV.');
}

// ─── Reset ───────────────────────────────────────────────────────────────────

async function handleReset(env, url) {
  const envPrefix = getEnvPrefix(url);
  const keys = kvKeys(envPrefix);

  // Claves del entorno actual
  const envKeys = [keys.state, keys.lock, keys.debug];

  // Claves legacy (sin prefijo) que pueden estar contaminando
  const legacyKeys = [
    'sync:state', 'sync:lock',
    'sync_status', 'sync_phase', 'sync_logs',
    'all_item_ids', 'all_item_ids:0', 'all_item_ids:1',
    'pending_details', 'pending_details:0',
    'scroll_ids_partial', 'sync_cursor'
  ];

  for (const key of [...envKeys, ...legacyKeys]) {
    try {
      await env.AMADO_KV.delete(key);
      console.log(`[Reset][${envPrefix}] Eliminado: ${key}`);
    } catch (err) {
      console.error(`[Reset][${envPrefix}] Error eliminando ${key}:`, err.message);
    }
  }

  console.log(`[Reset][${envPrefix}] Estado de sincronización limpiado.`);
}

// ─── Cron sync ───────────────────────────────────────────────────────────────

async function handleCronSync(env) {
  const CRON_KEY = 'cron:last_run';
  const CRON_STATUS_KEY = 'cron:status';
  const MAX_SYNC_TIME = 1800000; // 30 minutos
  const RETRY_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 5000;

  // URL de producción para que el cron escriba en sync:state:prod
  const PROD_URL = new URL('https://www.amadolibros.com/api/sync');

  try {
    const currentStatus = await env.AMADO_KV.get('sync_status', { type: 'json' });
    if (currentStatus?.status === 'scrolling' || currentStatus?.status === 'fetching_details') {
      const startTime = new Date(currentStatus.updatedAt).getTime();
      const elapsedMs = Date.now() - startTime;

      if (elapsedMs > MAX_SYNC_TIME) {
        console.warn(`[Cron] Sync congelado por ${Math.round(elapsedMs / 1000)}s. Resetando...`);
        await handleReset(env, PROD_URL);
      } else {
        console.log(`[Cron] Sync en progreso (${Math.round(elapsedMs / 1000)}s). Saltando...`);
        await env.AMADO_KV.put(CRON_STATUS_KEY, JSON.stringify({
          status: 'skipped', reason: 'sync_in_progress',
          elapsed_ms: elapsedMs, timestamp: new Date().toISOString()
        }));
        return;
      }
    }

    const lastRun = await env.AMADO_KV.get(CRON_KEY);
    if (lastRun) {
      const hoursSinceLastRun = (Date.now() - new Date(lastRun).getTime()) / (1000 * 60 * 60);
      if (hoursSinceLastRun < 5) {
        console.log(`[Cron] Último sync hace ${Math.round(hoursSinceLastRun)}h. Saltando.`);
        await env.AMADO_KV.put(CRON_STATUS_KEY, JSON.stringify({
          status: 'skipped', reason: 'too_recent',
          hours_since_last_run: Math.round(hoursSinceLastRun * 10) / 10,
          timestamp: new Date().toISOString()
        }));
        return;
      }
    }

    let syncStarted = false;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      try {
        console.log(`[Cron] Intento ${attempt}/${RETRY_ATTEMPTS}: Iniciando sync...`);
        const startMs = Date.now();
        await handleSyncCatalog(env, PROD_URL);
        const durationMs = Date.now() - startMs;

        await env.AMADO_KV.put(CRON_KEY, new Date().toISOString(), { expirationTtl: 86400 * 30 });
        await env.AMADO_KV.put(CRON_STATUS_KEY, JSON.stringify({
          status: 'completed', attempt, duration_ms: durationMs, timestamp: new Date().toISOString()
        }));

        console.log(`[Cron] Sync completado en ${Math.round(durationMs / 1000)}s`);
        syncStarted = true;
        break;

      } catch (err) {
        console.error(`[Cron] Intento ${attempt} falló:`, err.message);
        if (attempt < RETRY_ATTEMPTS) {
          const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    if (!syncStarted) {
      await env.AMADO_KV.put(CRON_STATUS_KEY, JSON.stringify({
        status: 'failed', reason: 'max_retries_exceeded',
        attempts: RETRY_ATTEMPTS, timestamp: new Date().toISOString()
      }));
      await env.AMADO_KV.put('cron:last_error', JSON.stringify({
        error: 'Sync falló después de 3 intentos',
        timestamp: new Date().toISOString(), check_endpoint: '/api/status'
      }), { expirationTtl: 86400 });
      console.error('[Cron] Todos los reintentos fallaron.');
    }

  } catch (err) {
    console.error('[Cron] Error crítico:', err.message);
    await env.AMADO_KV.put(CRON_STATUS_KEY, JSON.stringify({
      status: 'critical_error', error: err.message, timestamp: new Date().toISOString()
    }));
  }
}
