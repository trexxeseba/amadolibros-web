// functions/api/[[route]].js
// Backend robusto para sincronización de catálogo Mercado Libre → Cloudflare KV
// Plan: Cloudflare Workers Paid (30s CPU disponible)

const SELLER_ID = '440298103'; // Tu seller ID de Mercado Libre
const ML_API_BASE = 'https://api.mercadolibre.com';
const BATCH_SIZE = 20; // IDs por request de multiget
const MAX_ITEMS = 20000; // Tope de seguridad

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // ==================== ENDPOINT DE DIAGNÓSTICO ====================
    if (path === '/api/test-connection') {
      return handleDiagnostic(env, corsHeaders);
    }

    // ==================== ENDPOINT DE SINCRONIZACIÓN ====================
    if (path === '/api/sync-catalog') {
      return handleSyncCatalog(env, corsHeaders);
    }

    // ==================== ENDPOINT PARA LEER CATÁLOGO ====================
    if (path === '/api/catalog') {
      return handleGetCatalog(env, corsHeaders);
    }

    // ==================== ENDPOINT DE STATS ====================
    if (path === '/api/stats') {
      return handleStats(env, corsHeaders);
    }

    return new Response(
      JSON.stringify({ 
        error: 'Endpoint no encontrado',
        available: ['/api/test-connection', '/api/sync-catalog', '/api/catalog', '/api/stats']
      }),
      { status: 404, headers: corsHeaders }
    );

  } catch (error) {
    console.error('Error global:', error);
    return new Response(
      JSON.stringify({ 
        error: 'Error interno del servidor',
        message: error.message,
        stack: error.stack
      }),
      { status: 500, headers: corsHeaders }
    );
  }
}

// ==================== DIAGNÓSTICO ====================
async function handleDiagnostic(env, corsHeaders) {
  const checks = {
    kv_binding: !!env.AMADO_KV,
    app_id: !!env.APP_ID,
    client_secret: !!env.CLIENT_SECRET,
    refresh_token: !!env.REFRESH_TOKEN,
  };

  const allOk = Object.values(checks).every(v => v);

  if (!allOk) {
    return new Response(
      JSON.stringify({ 
        status: 'ERROR',
        checks,
        missing: Object.keys(checks).filter(k => !checks[k]),
        help: 'Configura las variables faltantes en Cloudflare Dashboard'
      }),
      { status: 500, headers: corsHeaders }
    );
  }

  // Test KV write/read
  try {
    await env.AMADO_KV.put('test:connection', 'OK', { expirationTtl: 60 });
    const testRead = await env.AMADO_KV.get('test:connection');
    
    return new Response(
      JSON.stringify({ 
        status: 'OK',
        checks,
        kv_test: testRead === 'OK' ? 'PASS' : 'FAIL',
        timestamp: new Date().toISOString()
      }),
      { headers: corsHeaders }
    );
  } catch (kvError) {
    return new Response(
      JSON.stringify({ 
        status: 'ERROR',
        checks,
        kv_error: kvError.message
      }),
      { status: 500, headers: corsHeaders }
    );
  }
}

// ==================== SINCRONIZACIÓN COMPLETA ====================
async function handleSyncCatalog(env, corsHeaders) {
  const startTime = Date.now();
  const logs = [];
  
  try {
    // 1. Obtener Access Token
    logs.push('🔐 Obteniendo access token...');
    const accessToken = await getAccessToken(env);
    logs.push('✅ Token obtenido');

    // 2. Obtener TODOS los IDs usando búsqueda paginada
    logs.push('📡 Iniciando búsqueda paginada de items (active + paused)...');
    const itemIds = await getAllItemIds(accessToken, logs);
    logs.push(`✅ Total IDs obtenidos: ${itemIds.length}`);

    if (itemIds.length === 0) {
      return new Response(
        JSON.stringify({ 
          status: 'WARNING',
          message: 'No se encontraron items',
          logs
        }),
        { headers: corsHeaders }
      );
    }

    // 3. Enriquecer con detalles completos (Multiget)
    logs.push('📚 Enriqueciendo items con detalles completos...');
    const fullCatalog = await enrichItems(itemIds, accessToken, logs);
    logs.push(`✅ Items enriquecidos: ${fullCatalog.length}`);

    // 4. Guardar en KV
    logs.push('💾 Guardando en KV...');
    const catalogData = {
      items: fullCatalog,
      total: fullCatalog.length,
      last_sync: new Date().toISOString(),
      sync_duration_ms: Date.now() - startTime,
      seller_id: SELLER_ID
    };

    await env.AMADO_KV.put(
      'books:full_catalog',
      JSON.stringify(catalogData),
      { expirationTtl: 86400 } // 24 horas
    );
    
    logs.push('✅ Catálogo guardado exitosamente');

    // 5. Guardar stats separadamente
    const stats = {
      total: fullCatalog.length,
      active: fullCatalog.filter(i => i.status === 'active').length,
      paused: fullCatalog.filter(i => i.status === 'paused').length,
      last_sync: catalogData.last_sync,
      duration_seconds: Math.round((Date.now() - startTime) / 1000)
    };

    await env.AMADO_KV.put('books:stats', JSON.stringify(stats));

    return new Response(
      JSON.stringify({ 
        status: 'SUCCESS',
        stats,
        logs,
        sample: fullCatalog.slice(0, 3) // Muestra de los primeros 3 libros
      }),
      { headers: corsHeaders }
    );

  } catch (error) {
    logs.push(`❌ ERROR: ${error.message}`);
    console.error('Error en sincronización:', error);
    
    return new Response(
      JSON.stringify({ 
        status: 'ERROR',
        error: error.message,
        stack: error.stack,
        logs
      }),
      { status: 500, headers: corsHeaders }
    );
  }
}

// ==================== OBTENER ACCESS TOKEN ====================
async function getAccessToken(env) {
  const { APP_ID, CLIENT_SECRET, REFRESH_TOKEN } = env;

  if (!APP_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error('Credenciales OAuth incompletas. Verifica APP_ID, CLIENT_SECRET y REFRESH_TOKEN');
  }

  const tokenUrl = 'https://api.mercadolibre.com/oauth/token';
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: APP_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`OAuth falló (${response.status}): ${errorData}`);
  }

  const data = await response.json();
  
  if (!data.access_token) {
    throw new Error('Token de acceso no recibido en la respuesta OAuth');
  }

  return data.access_token;
}

// ==================== OBTENER TODOS LOS IDs CON PAGINACIÓN ESTÁNDAR ====================
async function getAllItemIds(accessToken, logs) {
  const allIds = [];
  let offset = 0;
  const limit = 50; // Mercado Libre recomienda 50 por página
  let totalFetched = 0;

  while (true) {
    // Usar búsqueda estándar sin search_type=scan
    const url = `${ML_API_BASE}/users/${SELLER_ID}/items/search?offset=${offset}&limit=${limit}`;

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Búsqueda falló en offset ${offset}: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    // Agregar IDs de esta página
    if (data.results && data.results.length > 0) {
      allIds.push(...data.results);
      totalFetched += data.results.length;
      const page = Math.floor(offset / limit) + 1;
      logs.push(`  → Página ${page}: ${data.results.length} items (total acumulado: ${allIds.length})`);
    }

    // Verificar si hay más páginas
    // Si obtuvimos menos items que el límite, llegamos al final
    if (!data.results || data.results.length < limit) {
      logs.push(`  → Búsqueda completada: ${allIds.length} items totales`);
      break;
    }

    // Verificar si hay más resultados según paging
    if (data.paging && data.paging.total) {
      if (offset + limit >= data.paging.total) {
        logs.push(`  → Alcanzado total reportado: ${data.paging.total} items`);
        break;
      }
    }

    // Tope de seguridad
    if (allIds.length >= MAX_ITEMS) {
      logs.push(`  ⚠️ Alcanzado límite de seguridad (${MAX_ITEMS} items)`);
      break;
    }

    // Avanzar a la siguiente página
    offset += limit;

    // Pequeña pausa para no saturar la API
    await sleep(150);
  }

  // Ahora obtener los items pausados por separado
  logs.push(`  → Buscando items pausados...`);
  offset = 0;
  
  while (true) {
    const url = `${ML_API_BASE}/users/${SELLER_ID}/items/search?status=paused&offset=${offset}&limit=${limit}`;

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!response.ok) {
      logs.push(`  ⚠️ No se pudieron obtener items pausados (esto es opcional)`);
      break;
    }

    const data = await response.json();
    
    if (data.results && data.results.length > 0) {
      // Agregar solo los que no estén ya en allIds
      const newPausedIds = data.results.filter(id => !allIds.includes(id));
      allIds.push(...newPausedIds);
      logs.push(`  → Items pausados: +${newPausedIds.length} nuevos (total acumulado: ${allIds.length})`);
    }

    if (!data.results || data.results.length < limit) {
      break;
    }

    if (allIds.length >= MAX_ITEMS) {
      break;
    }

    offset += limit;
    await sleep(150);
  }

  return allIds;
}

// ==================== ENRIQUECER ITEMS CON MULTIGET ====================
async function enrichItems(itemIds, accessToken, logs) {
  const enrichedItems = [];
  const totalBatches = Math.ceil(itemIds.length / BATCH_SIZE);

  for (let i = 0; i < itemIds.length; i += BATCH_SIZE) {
    const batch = itemIds.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    
    const idsParam = batch.join(',');
    const url = `${ML_API_BASE}/items?ids=${idsParam}&attributes=id,title,price,currency_id,thumbnail,permalink,status,available_quantity,pictures,attributes,condition,shipping`;

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!response.ok) {
      logs.push(`  ⚠️ Error en lote ${batchNum}/${totalBatches}: ${response.status}`);
      continue; // Continuar con siguiente lote en caso de error
    }

    const batchData = await response.json();

    for (const itemData of batchData) {
      if (itemData.code === 200 && itemData.body) {
        const item = itemData.body;
        
        // Extraer atributos técnicos dinámicamente
        const attributes = {};
        if (item.attributes && Array.isArray(item.attributes)) {
          for (const attr of item.attributes) {
            if (attr.value_name) {
              attributes[attr.name] = attr.value_name;
            }
          }
        }

        // Obtener imagen de alta calidad
        const imageUrl = item.pictures && item.pictures.length > 0 
          ? item.pictures[0].url 
          : item.thumbnail;

        enrichedItems.push({
          id: item.id,
          title: item.title,
          price: item.price,
          currency: item.currency_id,
          status: item.status,
          condition: item.condition,
          available_quantity: item.available_quantity,
          thumbnail: item.thumbnail,
          image: imageUrl,
          permalink: item.permalink,
          shipping: item.shipping,
          attributes: attributes // Todos los atributos técnicos dinámicamente
        });
      }
    }

    if (batchNum % 10 === 0) {
      logs.push(`  → Procesados ${batchNum}/${totalBatches} lotes (${enrichedItems.length} items)`);
    }

    // Pausa entre lotes para respetar rate limits
    await sleep(150);
  }

  return enrichedItems;
}

// ==================== LEER CATÁLOGO DESDE KV ====================
async function handleGetCatalog(env, corsHeaders) {
  try {
    const catalogData = await env.AMADO_KV.get('books:full_catalog', 'json');
    
    if (!catalogData) {
      return new Response(
        JSON.stringify({ 
          error: 'Catálogo no encontrado',
          message: 'Ejecuta /api/sync-catalog primero'
        }),
        { status: 404, headers: corsHeaders }
      );
    }

    return new Response(
      JSON.stringify(catalogData),
      { headers: corsHeaders }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: corsHeaders }
    );
  }
}

// ==================== OBTENER ESTADÍSTICAS ====================
async function handleStats(env, corsHeaders) {
  try {
    const stats = await env.AMADO_KV.get('books:stats', 'json');
    
    if (!stats) {
      return new Response(
        JSON.stringify({ 
          error: 'Stats no disponibles',
          message: 'Ejecuta /api/sync-catalog primero'
        }),
        { status: 404, headers: corsHeaders }
      );
    }

    return new Response(
      JSON.stringify(stats),
      { headers: corsHeaders }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: corsHeaders }
    );
  }
}

// ==================== UTILIDADES ====================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
