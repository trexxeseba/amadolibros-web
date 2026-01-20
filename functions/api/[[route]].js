// functions/api/[[route]].js
// Backend simple - Devuelve datos directamente

const APP_ID = '4741021817925208';
const USER_ID = '440298103';

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '');

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (path === '/health') {
    return new Response(JSON.stringify({ status: 'OK', timestamp: new Date().toISOString() }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (path === '/sync-catalog') {
    return handleSyncCatalog(env, corsHeaders);
  }

  return new Response('Not Found', { status: 404, headers: corsHeaders });
}

async function getAccessToken(env) {
  const REFRESH_TOKEN = env.REFRESH_TOKEN;
  const CLIENT_SECRET = env.CLIENT_SECRET;
  
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
    const errorText = await response.text();
    throw new Error(`Error obteniendo access token: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function fetchAllItemsWithScrollId(accessToken) {
  const logs = [];
  const allItems = [];
  let scrollId = null;
  let page = 1;
  let hasMore = true;

  logs.push('📡 Iniciando sincronización con scroll_id...');

  while (hasMore) {
    try {
      const url = scrollId 
        ? `https://api.mercadolibre.com/users/${USER_ID}/items/search?scroll_id=${scrollId}`
        : `https://api.mercadolibre.com/users/${USER_ID}/items/search?limit=100`;

      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });

      if (!response.ok) {
        throw new Error(`Error HTTP ${response.status}`);
      }

      const data = await response.json();
      scrollId = data.scroll_id;

      if (data.results && data.results.length > 0) {
        allItems.push(...data.results);
        
        // Log cada 10 páginas para no saturar
        if (page % 10 === 0) {
          logs.push(`  → Página ${page}: total acumulado ${allItems.length} items`);
        }
        page++;
      }

      if (!scrollId) {
        hasMore = false;
        logs.push(`✅ Sincronización completa: ${allItems.length} items obtenidos`);
      }

      // Límite de seguridad
      if (page > 200) {
        logs.push('⚠️ Alcanzado límite de seguridad (200 páginas / 20,000 items)');
        hasMore = false;
      }

    } catch (error) {
      logs.push(`❌ Error en página ${page}: ${error.message}`);
      hasMore = false;
    }
  }

  return { items: allItems, logs };
}

async function enrichItemsWithDetails(itemIds, accessToken) {
  const logs = [];
  const enrichedItems = [];
  const BATCH_SIZE = 20;
  const totalBatches = Math.ceil(itemIds.length / BATCH_SIZE);

  logs.push(`📚 Enriqueciendo ${itemIds.length} items...`);

  for (let i = 0; i < itemIds.length; i += BATCH_SIZE) {
    const batch = itemIds.slice(i, i + BATCH_SIZE);
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;

    try {
      const ids = batch.join(',');
      const response = await fetch(
        `https://api.mercadolibre.com/items?ids=${ids}&attributes=id,title,price,currency_id,status,condition,available_quantity,thumbnail,pictures,permalink,shipping,attributes`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );

      if (!response.ok) {
        throw new Error(`Error HTTP ${response.status}`);
      }

      const data = await response.json();
      
      data.forEach(item => {
        if (item.body) {
          enrichedItems.push(transformItem(item.body));
        }
      });

      // Log cada 50 lotes
      if (batchNumber % 50 === 0 || batchNumber === totalBatches) {
        logs.push(`  → Procesados ${batchNumber}/${totalBatches} lotes (${enrichedItems.length} items)`);
      }

    } catch (error) {
      logs.push(`  ⚠️ Error en lote ${batchNumber}: ${error.message}`);
    }
  }

  logs.push(`✅ Items enriquecidos: ${enrichedItems.length}`);
  return { items: enrichedItems, logs };
}

function transformItem(item) {
  const attributes = {};
  if (item.attributes) {
    item.attributes.forEach(attr => {
      attributes[attr.name] = attr.value_name || attr.value_struct?.number || attr.value_struct?.unit || attr.values?.[0]?.name || '';
    });
  }

  return {
    id: item.id,
    title: item.title,
    price: item.price,
    currency: item.currency_id,
    status: item.status,
    condition: item.condition,
    available_quantity: item.available_quantity,
    thumbnail: item.thumbnail,
    image: item.pictures?.[0]?.url || item.thumbnail,
    permalink: item.permalink,
    shipping: {
      mode: item.shipping?.mode,
      free_shipping: item.shipping?.free_shipping,
      local_pick_up: item.shipping?.local_pick_up,
    },
    attributes,
  };
}

async function handleSyncCatalog(env, corsHeaders) {
  const startTime = Date.now();
  const logs = [];

  try {
    logs.push('🔐 Obteniendo access token...');
    const accessToken = await getAccessToken(env);
    logs.push('✅ Token obtenido');

    const { items: itemIds, logs: fetchLogs } = await fetchAllItemsWithScrollId(accessToken);
    logs.push(...fetchLogs);

    const { items: enrichedItems, logs: enrichLogs } = await enrichItemsWithDetails(itemIds, accessToken);
    logs.push(...enrichLogs);

    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    const stats = {
      total: enrichedItems.length,
      active: enrichedItems.filter(i => i.status === 'active').length,
      paused: enrichedItems.filter(i => i.status === 'paused').length,
      closed: enrichedItems.filter(i => i.status === 'closed').length,
      last_sync: new Date().toISOString(),
      duration_seconds: durationSeconds,
    };

    logs.push(`✅ COMPLETADO: ${enrichedItems.length} items en ${durationSeconds}s`);

    return new Response(
      JSON.stringify({
        status: 'SUCCESS',
        stats,
        logs,
        items: enrichedItems, // TODOS los items aquí
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );

  } catch (error) {
    logs.push(`❌ Error: ${error.message}`);
    return new Response(
      JSON.stringify({
        status: 'ERROR',
        error: error.message,
        logs,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
}
