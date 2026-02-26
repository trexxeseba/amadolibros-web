// functions/api/[[route]].js
// VERSIÓN 4.0 - ARQUITECTURA DE SINCRONIZACIÓN POR CHUNKS
// Sincroniza 16,000+ libros sin exceder el límite de 30s de Cloudflare

const APP_ID = '4741021817925208';
const USER_ID = '440298103';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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
      JSON.stringify({ status: 'OK', timestamp: new Date().toISOString(), version: '4.0' }),
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
  if (path === '/webhooks/mercadolibre' && request.method === 'POST') {
    waitUntil(handleWebhook(request, env));
    return new Response(JSON.stringify({ status: 'received' }), { status: 200 });
  }

  return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
}

// === MANEJO DEL CATÁLOGO (LECTURA) ===
async function handleGetCatalog(env, url) {
  try {
    const searchQuery = url.searchParams.get('q') || '';
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '50');

    const cachedData = await env.AMADO_KV.get('catalog:full', { type: 'json' });

    if (!cachedData) {
      return new Response(
        JSON.stringify({
          status: 'CACHE_EMPTY',
          message: 'El catálogo se está cargando. Intenta en 2 minutos o visita /api/sync para sincronizar.',
          items: [], total: 0
        }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } }
      );
    }

    let items = cachedData;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      items = items.filter(b => (b.title && b.title.toLowerCase().includes(q)) || (b.id && b.id.toLowerCase().includes(q)));
    }

    const totalFiltered = items.length;
    const offset = (page - 1) * limit;
    const paginatedItems = items.slice(offset, offset + limit);
    const metadata = await env.AMADO_KV.get('catalog:metadata', { type: 'json' });

    return new Response(
      JSON.stringify({
        status: 'OK', items: paginatedItems, total: totalFiltered, page, limit,
        has_more: offset + limit < totalFiltered,
        last_sync: metadata?.last_sync || null,
        total_in_catalog: metadata?.total_items || 0
      }),
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300, s-maxage=300' } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ status: 'ERROR', error: error.message, items: [], total: 0 }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
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

async function getAccessToken(env) {
  const CLIENT_SECRET = env.CLIENT_SECRET;
  let REFRESH_TOKEN = await env.AMADO_KV.get('auth:refresh_token') || env.REFRESH_TOKEN;

  if (!REFRESH_TOKEN || !CLIENT_SECRET) {
    throw new Error('Credenciales de ML no configuradas.');
  }

  const response = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: APP_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH_TOKEN }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Error obteniendo token de ML (${response.status}): ${errText}`);
  }

  const data = await response.json();
  if (data.refresh_token) {
    await env.AMADO_KV.put('auth:refresh_token', data.refresh_token, { expirationTtl: 86400 * 30 });
  }
  return data.access_token;
}
