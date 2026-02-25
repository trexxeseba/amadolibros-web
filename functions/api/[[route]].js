// functions/api/[[route]].js
// VERSIÓN 3.0 - ARQUITECTURA CACHÉ KV
// El catálogo se sincroniza desde ML y se guarda en KV.
// El frontend siempre lee del caché (instantáneo), nunca de ML directamente.

const APP_ID = '4741021817925208';
const USER_ID = '440298103';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '');

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (path === '/catalog' || path === '/home') {
    return handleGetCatalog(env, url);
  }
  if (path === '/sync') {
    return handleSyncCatalog(env);
  }
  if (path === '/status') {
    return handleStatus(env);
  }
  if (path === '/health') {
    return new Response(
      JSON.stringify({ status: 'OK', timestamp: new Date().toISOString(), version: '3.0' }),
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
  if (path === '/webhooks/mercadolibre' && request.method === 'POST') {
    return handleWebhook(request, env, context);
  }

  return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
}

async function handleGetCatalog(env, url) {
  try {
    const searchQuery = url.searchParams.get('q') || '';
    const filterStatus = url.searchParams.get('status') || 'all';
    const sortBy = url.searchParams.get('sort') || 'recent';
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '50');

    const cachedData = await env.AMADO_KV.get('catalog:full', { type: 'json' });

    if (!cachedData) {
      return new Response(
        JSON.stringify({
          status: 'CACHE_EMPTY',
          message: 'El catálogo se está cargando. Intenta en 2 minutos o visita /api/sync para sincronizar.',
          items: [],
          total: 0
        }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } }
      );
    }

    let items = cachedData;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      items = items.filter(b =>
        (b.title && b.title.toLowerCase().includes(q)) ||
        (b.id && b.id.toLowerCase().includes(q))
      );
    }

    if (filterStatus === 'active') {
      items = items.filter(b => b.status !== 'paused' && b.status !== 'closed');
    } else if (filterStatus === 'paused') {
      items = items.filter(b => b.status === 'paused');
    }

    if (sortBy === 'price_asc') {
      items = items.sort((a, b) => (a.price || 0) - (b.price || 0));
    } else if (sortBy === 'price_desc') {
      items = items.sort((a, b) => (b.price || 0) - (a.price || 0));
    } else if (sortBy === 'title') {
      items = items.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    }

    const totalFiltered = items.length;
    const offset = (page - 1) * limit;
    const paginatedItems = items.slice(offset, offset + limit);

    const metadata = await env.AMADO_KV.get('catalog:metadata', { type: 'json' });

    return new Response(
      JSON.stringify({
        status: 'OK',
        items: paginatedItems,
        total: totalFiltered,
        page,
        limit,
        has_more: offset + limit < totalFiltered,
        last_sync: metadata?.last_sync || null,
        total_in_catalog: metadata?.total_items || 0
      }),
      {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300, s-maxage=300'
        }
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ status: 'ERROR', error: error.message, items: [], total: 0 }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
}

async function handleSyncCatalog(env) {
  const startTime = Date.now();
  const logs = [];

  try {
    logs.push('🔐 Obteniendo access token...');
    const accessToken = await getAccessToken(env);
    logs.push('✅ Token obtenido');

    logs.push('📋 Obteniendo lista de IDs de productos...');
    const allItemIds = [];
    let offset = 0;
    const limit = 100;
    let total = 0;

    while (true) {
      const url = `https://api.mercadolibre.com/users/${USER_ID}/items/search?offset=${offset}&limit=${limit}`;
      const res = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error(`Error obteniendo IDs: ${res.status}`);
      const data = await res.json();

      if (offset === 0) {
        total = data.paging?.total || 0;
        logs.push(`📊 Total de productos en ML: ${total}`);
      }

      if (!data.results || data.results.length === 0) break;
      allItemIds.push(...data.results);
      offset += limit;
      if (allItemIds.length >= total) break;
    }

    logs.push(`✅ ${allItemIds.length} IDs obtenidos`);
    logs.push('📦 Descargando detalles de productos...');

    const allItems = [];
    const batchSize = 20;

    for (let i = 0; i < allItemIds.length; i += batchSize) {
      const batch = allItemIds.slice(i, i + batchSize);
      const idsParam = batch.join(',');

      const detailRes = await fetch(
        `https://api.mercadolibre.com/items?ids=${idsParam}&attributes=id,title,price,status,available_quantity,thumbnail,pictures,permalink,condition,currency_id`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );

      if (!detailRes.ok) {
        logs.push(`⚠️ Error en lote ${i}: ${detailRes.status}`);
        continue;
      }

      const details = await detailRes.json();

      for (const res of details) {
        if (res.code === 200 && res.body) {
          const b = res.body;
          allItems.push({
            id: b.id,
            title: b.title,
            price: b.price,
            currency: b.currency_id,
            status: b.status,
            stock: b.available_quantity,
            condition: b.condition,
            thumbnail: (b.pictures?.[0]?.url || b.thumbnail || '').replace('http://', 'https://').replace('-I.jpg', '-O.jpg'),
            permalink: b.permalink
          });
        }
      }

      if (i % (batchSize * 10) === 0 && i > 0) {
        logs.push(`📦 Progreso: ${allItems.length}/${allItemIds.length} productos...`);
      }
    }

    logs.push(`✅ ${allItems.length} productos procesados`);
    logs.push('💾 Guardando en caché KV...');

    await env.AMADO_KV.put('catalog:full', JSON.stringify(allItems), { expirationTtl: 604800 });

    const metadata = {
      total_items: allItems.length,
      total_in_ml: total,
      active: allItems.filter(i => i.status === 'active').length,
      paused: allItems.filter(i => i.status === 'paused').length,
      last_sync: new Date().toISOString(),
      duration_seconds: Math.round((Date.now() - startTime) / 1000)
    };
    await env.AMADO_KV.put('catalog:metadata', JSON.stringify(metadata), { expirationTtl: 604800 });

    logs.push(`✅ SINCRONIZACIÓN COMPLETADA: ${allItems.length} productos en ${metadata.duration_seconds}s`);

    return new Response(
      JSON.stringify({ status: 'SUCCESS', metadata, logs }),
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    logs.push(`❌ Error crítico: ${error.message}`);
    return new Response(
      JSON.stringify({ status: 'ERROR', error: error.message, logs }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
}

async function handleStatus(env) {
  try {
    const metadata = await env.AMADO_KV.get('catalog:metadata', { type: 'json' });
    const catalogRaw = await env.AMADO_KV.get('catalog:full');
    const hasCatalog = catalogRaw !== null;

    return new Response(
      JSON.stringify({
        status: 'OK',
        cache_populated: hasCatalog,
        metadata: metadata || { message: 'Sin sincronización previa. Llama a /api/sync para iniciar.' },
        timestamp: new Date().toISOString()
      }),
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ status: 'ERROR', error: error.message }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
}

async function handleWebhook(request, env, context) {
  try {
    const payload = await request.json();
    const webhookKey = `webhook_${Date.now()}`;
    await env.AMADO_KV.put(
      webhookKey,
      JSON.stringify({ topic: payload.topic, resource: payload.resource, received_at: new Date().toISOString() }),
      { expirationTtl: 86400 }
    );

    if (context && context.waitUntil) {
      context.waitUntil(processWebhookAsync(payload, env));
    }

    return new Response(
      JSON.stringify({ status: 'received' }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ status: 'ERROR', error: error.message }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
}

async function processWebhookAsync(payload, env) {
  try {
    const { topic, resource } = payload;
    if (topic !== 'items' || !resource) return;

    const itemId = resource.split('/').pop();
    if (!itemId) return;

    const accessToken = await getAccessToken(env);
    const res = await fetch(
      `https://api.mercadolibre.com/items/${itemId}?attributes=id,title,price,status,available_quantity,thumbnail,pictures,permalink,condition,currency_id`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
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
  } catch (error) {
    console.error('Error procesando webhook:', error.message);
  }
}

async function getAccessToken(env) {
  const REFRESH_TOKEN = env.REFRESH_TOKEN;
  const CLIENT_SECRET = env.CLIENT_SECRET;

  if (!REFRESH_TOKEN || !CLIENT_SECRET) {
    throw new Error('Credenciales de ML no configuradas en las variables de entorno de Cloudflare.');
  }

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

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Error obteniendo token de ML (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return data.access_token;
}
