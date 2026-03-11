// functions/api/[[route]].js
// VERSIÓN 5.0 - ARQUITECTURA CON BLOQUEO DISTRIBUIDO Y REINTENTOS
// Solución definitiva para el Refresh Token rotativo de Mercado Libre
// Consenso de Gemini 2.5 Flash + GPT-4.1: KV como única fuente de verdad + lock + backoff

const APP_ID = '4741021817925208';
const USER_ID = '440298103';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// === CRON TRIGGER ===
export async function onScheduled(context) {
  const { env, waitUntil } = context;
  console.log('[Cron] Ejecutando sincronización programada...');
  waitUntil(handleCronSync(env));
}

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
    // No bloquear la respuesta al usuario, la sincronización corre en background
    waitUntil(handleSyncCatalog(env, url));
    return new Response(
      JSON.stringify({ status: 'SYNC_STARTED', message: 'La sincronización ha comenzado. Revisa /api/status para ver el progreso.' }),
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
  if (path === '/status') {
    return handleStatus(env);
  }
  if (path === '/health') {
    return new Response(
      JSON.stringify({ status: 'OK', timestamp: new Date().toISOString(), version: '5.0' }),
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
  if (path === '/reset' && request.method === 'POST') {
    waitUntil(handleReset(env));
    return new Response(
      JSON.stringify({ status: 'RESET_STARTED', message: 'Los datos de sincronización han sido limpiados. Ejecutá /api/sync para reiniciar.' }),
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
  if (path === '/reset' && request.method === 'GET') {
    waitUntil(handleReset(env));
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

// === MANEJO DEL CATÁLOGO (LECTURA) - v7.0 Opus Fix ===
async function handleGetCatalog(env, url) {
  const page = parseInt(url.searchParams.get('page') || '0');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  const search = (url.searchParams.get('q') || '').toLowerCase().trim();
  const KV = env.AMADO_KV;

  try {
    // 1. Leer metadata del índice (el Worker v3 guarda 'total', no 'totalItems')
    const indexMeta = await KV.get('catalog_index', { type: 'json' });

    if (!indexMeta || !indexMeta.total || indexMeta.total === 0) {
      return new Response(JSON.stringify({
        items: [], total: 0, page, limit, pages: 0,
        message: 'El catálogo se está sincronizando. Intentá de nuevo en unos minutos.'
      }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } });
    }

    // 2. Cargar los IDs desde los chunks del índice
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

    // 3. Búsqueda: cargar primeros 2000 items y filtrar
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

    // 4. Sin búsqueda: paginar directamente los IDs
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

// === SINCRONIZACIÓN POR CHUNKS (ESCRITURA) ===
async function handleSyncCatalog(env, url) {
  const startTime = Date.now();
  let logs = [];

  const syncLock = await env.AMADO_KV.get('sync:lock');
  if (syncLock) return;
  await env.AMADO_KV.put('sync:lock', 'true', { expirationTtl: 600 });

  try {
    const accessToken = await getAccessToken(env);
    let state = await env.AMADO_KV.get('sync:state', { type: 'json' }) || { offset: 0, allItemIds: [], total: 0, allItems: [] };

    // 1. OBTENER IDs
    if (state.offset < state.total || state.total === 0) {
      const initialUrl = `https://api.mercadolibre.com/users/${USER_ID}/items/search?offset=${state.offset}&limit=100`;
      const res = await fetch(initialUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error(`Error obteniendo IDs en offset ${state.offset}: ${res.status}`);
      const data = await res.json();

      if (state.offset === 0) state.total = data.paging?.total || 0;
      if (data.results) {
        state.allItemIds.push(...data.results);
        state.offset += data.results.length;
      }

      await env.AMADO_KV.put('sync:state', JSON.stringify(state));

      if (state.offset < state.total) {
        // Auto-encadenar la próxima llamada
        fetch(url.toString()).catch(e => console.error('Error en fetch encadenado:', e));
        return;
      }
    }

    // 2. OBTENER DETALLES DE PRODUCTOS
    const CHUNK_SIZE = 500;
    const unprocessedIds = state.allItemIds.slice(state.allItems.length, state.allItems.length + CHUNK_SIZE);

    if (unprocessedIds.length > 0) {
      const batchSize = 20;
      for (let i = 0; i < unprocessedIds.length; i += batchSize) {
        const batch = unprocessedIds.slice(i, i + batchSize);
        const detailRes = await fetch(
          `https://api.mercadolibre.com/items?ids=${batch.join(',')}&attributes=id,title,price,status,available_quantity,thumbnail,pictures,permalink,condition,currency_id`,
          { headers: { 'Authorization': `Bearer ${accessToken}` } }
        );
        if (detailRes.ok) {
          const details = await detailRes.json();
          for (const item of details) {
            if (item.code === 200 && item.body) {
              const b = item.body;
              state.allItems.push({
                id: b.id, title: b.title, price: b.price, currency: b.currency_id, status: b.status,
                stock: b.available_quantity, condition: b.condition,
                thumbnail: (b.pictures?.[0]?.url || b.thumbnail || '').replace('http://', 'https://').replace('-I.jpg', '-O.jpg'),
                permalink: b.permalink
              });
            }
          }
        }
      }
      await env.AMADO_KV.put('sync:state', JSON.stringify(state));

      if (state.allItems.length < state.total) {
        fetch(url.toString()).catch(e => console.error('Error en fetch encadenado:', e));
        return;
      }
    }

    // 3. FINALIZAR Y GUARDAR
    await env.AMADO_KV.put('catalog:full', JSON.stringify(state.allItems), { expirationTtl: 604800 });
    const metadata = {
      total_items: state.allItems.length, total_in_ml: state.total,
      last_sync: new Date().toISOString(), duration_seconds: Math.round((Date.now() - startTime) / 1000)
    };
    await env.AMADO_KV.put('catalog:metadata', JSON.stringify(metadata), { expirationTtl: 604800 });
    await env.AMADO_KV.delete('sync:state');

  } catch (error) {
    console.error('Error crítico en sync:', error.message);
  } finally {
    await env.AMADO_KV.delete('sync:lock');
  }
}

// === OTRAS FUNCIONES ===
async function handleStatus(env) {
  const metadata = await env.AMADO_KV.get('catalog:metadata', { type: 'json' });
  const syncState = await env.AMADO_KV.get('sync:state', { type: 'json' });
  return new Response(JSON.stringify({ metadata, syncState }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

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

// ============================================================
// getAccessToken v5.0 - Bloqueo Distribuido + Backoff Exponencial
// Consenso de Gemini 2.5 Flash + GPT-4.1
// ============================================================
async function getAccessToken(env) {
  const CLIENT_SECRET = env.CLIENT_SECRET;
  const KV_KEY = 'auth:refresh_token';
  const LOCK_KEY = 'auth:refresh_token_lock';
  const LOCK_TTL = 15;       // segundos máximos que puede durar el lock
  const MAX_RETRIES = 5;
  const BASE_DELAY_MS = 200; // backoff exponencial con jitter

  for (let i = 0; i < MAX_RETRIES; i++) {
    // 1. Leer el Refresh Token desde KV (única fuente de verdad)
    let REFRESH_TOKEN = await env.AMADO_KV.get(KV_KEY);

    // 2. Si KV está vacío, usar variable de entorno como fallback de emergencia
    if (!REFRESH_TOKEN) {
      REFRESH_TOKEN = env.REFRESH_TOKEN;
      if (!REFRESH_TOKEN) {
        throw new Error('No se encontró Refresh Token en KV ni en variables de entorno. Configura auth:refresh_token en KV.');
      }
      // Guardar inmediatamente en KV para que futuras llamadas lo encuentren
      await env.AMADO_KV.put(KV_KEY, REFRESH_TOKEN, { expirationTtl: 86400 * 30 });
      console.log('[Auth] Refresh Token inicializado en KV desde variable de entorno.');
    }

    // 3. Verificar si hay un lock activo (otro Worker está refrescando el token)
    const existingLock = await env.AMADO_KV.get(LOCK_KEY);
    if (existingLock) {
      // Otro Worker está refrescando. Esperar y reintentar para leer el nuevo token.
      const delay = BASE_DELAY_MS * Math.pow(2, i) + Math.random() * BASE_DELAY_MS;
      console.log(`[Auth] Lock activo, esperando ${Math.round(delay)}ms antes de reintentar (intento ${i+1}/${MAX_RETRIES})...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }

    // 4. Adquirir el lock antes de usar el Refresh Token
    await env.AMADO_KV.put(LOCK_KEY, Date.now().toString(), { expirationTtl: LOCK_TTL });

    try {
      // 5. Llamar a la API de Mercado Libre para obtener el Access Token
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
        // 6. Éxito: guardar el NUEVO Refresh Token en KV inmediatamente
        if (data.refresh_token) {
          await env.AMADO_KV.put(KV_KEY, data.refresh_token, { expirationTtl: 86400 * 30 });
          console.log('[Auth] Nuevo Refresh Token guardado en KV exitosamente.');
        }
        await env.AMADO_KV.delete(LOCK_KEY);
        return data.access_token;

      } else if (data.error === 'invalid_grant' || (data.message && data.message.includes('invalid'))) {
        // 7. Token inválido (race condition): liberar lock, esperar con backoff y reintentar
        await env.AMADO_KV.delete(LOCK_KEY);
        const delay = BASE_DELAY_MS * Math.pow(2, i) + Math.random() * BASE_DELAY_MS;
        console.warn(`[Auth] Refresh Token inválido (race condition). Reintentando en ${Math.round(delay)}ms (intento ${i+1}/${MAX_RETRIES})...`);
        await new Promise(resolve => setTimeout(resolve, delay));

      } else {
        // 8. Error inesperado
        await env.AMADO_KV.delete(LOCK_KEY);
        throw new Error(`Error obteniendo token de ML (${response.status}): ${JSON.stringify(data)}`);
      }

    } catch (err) {
      // 9. Siempre liberar el lock en caso de error
      await env.AMADO_KV.delete(LOCK_KEY).catch(() => {});
      if (i === MAX_RETRIES - 1) throw err;
      const delay = BASE_DELAY_MS * Math.pow(2, i);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error('[Auth] Fallo al obtener Access Token después de 5 reintentos. Verifica el Refresh Token en KV.');
}

// === RESET - LIMPIAR ESTADO CONGELADO ===
async function handleReset(env) {
  const keysToDelete = [
    'sync_status',
    'sync_phase',
    'sync_logs',
    'sync:state',
    'sync:lock',
    'all_item_ids',
    'all_item_ids:0',
    'all_item_ids:1',
    'pending_details',
    'pending_details:0',
    'scroll_ids_partial',
    'sync_cursor'
  ];

  for (const key of keysToDelete) {
    try {
      await env.AMADO_KV.delete(key);
      console.log(`[Reset] Eliminado: ${key}`);
    } catch (err) {
      console.error(`[Reset] Error eliminando ${key}:`, err.message);
    }
  }

  console.log('[Reset] Estado de sincronización limpiado correctamente.');
}

// === CRON SYNC - ROBUSTO CON HEALTHCHECK Y REINTENTOS ===
async function handleCronSync(env) {
  const CRON_KEY = 'cron:last_run';
  const CRON_STATUS_KEY = 'cron:status';
  const MAX_SYNC_TIME = 1800000; // 30 minutos máximo
  const RETRY_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 5000;

  try {
    // 1. HEALTHCHECK: Verificar si hay un sync activo
    const currentStatus = await env.AMADO_KV.get('sync_status', { type: 'json' });
    if (currentStatus?.status === 'scrolling' || currentStatus?.status === 'fetching_details') {
      const startTime = new Date(currentStatus.updatedAt).getTime();
      const elapsedMs = Date.now() - startTime;

      if (elapsedMs > MAX_SYNC_TIME) {
        // Sync congelado: resetear y reintentar
        console.warn(`[Cron] ⚠️  Sync congelado por ${Math.round(elapsedMs / 1000)}s. Resetando...`);
        await handleReset(env);
      } else {
        // Sync todavía en progreso, no interferir
        console.log(`[Cron] Sync en progreso (${Math.round(elapsedMs / 1000)}s). Saltando...`);
        await env.AMADO_KV.put(CRON_STATUS_KEY, JSON.stringify({
          status: 'skipped',
          reason: 'sync_in_progress',
          elapsed_ms: elapsedMs,
          timestamp: new Date().toISOString()
        }));
        return;
      }
    }

    // 2. VERIFICAR: Último sync exitoso
    const lastRun = await env.AMADO_KV.get(CRON_KEY);
    if (lastRun) {
      const lastTime = new Date(lastRun).getTime();
      const hoursSinceLastRun = (Date.now() - lastTime) / (1000 * 60 * 60);

      if (hoursSinceLastRun < 5) {
        // Ejecutado hace menos de 5 horas, skip
        console.log(`[Cron] ✅ Último sync hace ${Math.round(hoursSinceLastRun)}h. Saltando.`);
        await env.AMADO_KV.put(CRON_STATUS_KEY, JSON.stringify({
          status: 'skipped',
          reason: 'too_recent',
          hours_since_last_run: Math.round(hoursSinceLastRun * 10) / 10,
          timestamp: new Date().toISOString()
        }));
        return;
      }
    }

    // 3. INICIAR SYNC con reintentos
    let syncStarted = false;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      try {
        console.log(`[Cron] 🔄 Intento ${attempt}/${RETRY_ATTEMPTS}: Iniciando sync...`);
        
        // Lanzar sync en background
        const accessToken = await getAccessToken(env);
        let state = await env.AMADO_KV.get('sync:state', { type: 'json' }) || { 
          offset: 0, allItemIds: [], total: 0, allItems: [] 
        };

        // Ejecutar la sincronización
        const startMs = Date.now();
        await handleSyncCatalog(env, new URL('https://amadolibros-sync.undiaes.workers.dev/api/sync'));
        const durationMs = Date.now() - startMs;

        // Guardar timestamp de ejecución
        await env.AMADO_KV.put(CRON_KEY, new Date().toISOString(), { expirationTtl: 86400 * 30 });
        await env.AMADO_KV.put(CRON_STATUS_KEY, JSON.stringify({
          status: 'completed',
          attempt,
          duration_ms: durationMs,
          timestamp: new Date().toISOString()
        }));

        console.log(`[Cron] ✅ Sync completado en ${Math.round(durationMs / 1000)}s`);
        syncStarted = true;
        break;

      } catch (err) {
        console.error(`[Cron] ❌ Intento ${attempt} falló:`, err.message);
        
        if (attempt < RETRY_ATTEMPTS) {
          const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          console.log(`[Cron] ⏳ Esperando ${Math.round(delay / 1000)}s antes de reintentar...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    if (!syncStarted) {
      // Todos los reintentos fallaron
      await env.AMADO_KV.put(CRON_STATUS_KEY, JSON.stringify({
        status: 'failed',
        reason: 'max_retries_exceeded',
        attempts: RETRY_ATTEMPTS,
        timestamp: new Date().toISOString()
      }));

      // Guardar alerta para que la vea
      await env.AMADO_KV.put('cron:last_error', JSON.stringify({
        error: 'Sync falló después de 3 intentos',
        timestamp: new Date().toISOString(),
        check_endpoint: '/api/status'
      }), { expirationTtl: 86400 });

      console.error('[Cron] ❌ Todos los reintentos fallaron. Alerta guardada.');
    }

  } catch (err) {
    console.error('[Cron] 💥 Error crítico:', err.message);
    await env.AMADO_KV.put(CRON_STATUS_KEY, JSON.stringify({
      status: 'critical_error',
      error: err.message,
      timestamp: new Date().toISOString()
    }));
  }
}
}
