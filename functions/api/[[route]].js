// functions/api/[[route]].js
// VERSIÓN 7.0 - PAGES SOLO LECTURA
// El catálogo vive en R2. El Worker (worker-sync/) es la única fuente de escritura.
// Pages ya no sincroniza, no resetea, y no escribe datos de catálogo en KV.

// Fuente canónica del catálogo — idéntica a catalogo.js, sitemap.xml.js, feed.xml.js
const CATALOG_R2_URL = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json';
const META_R2_URL    = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/meta.json';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── Helpers de entorno ──────────────────────────────────────────────────────

/**
 * Devuelve un prefijo corto y estable según el hostname.
 * Prod → "prod" | Preview → primer segmento del hostname (ej. "fix-sync-v2")
 */
function getEnvPrefix(url) {
  const host = url.hostname;
  if (host === 'www.amadolibros.com' || host === 'amadolibros.com') return 'prod';
  const firstSegment = host.split('.')[0].replace(/[^a-z0-9-]/gi, '').slice(0, 24);
  return firstSegment || 'preview';
}

// ─── Router principal ────────────────────────────────────────────────────────

export async function onRequest(context) {
  const { request, env } = context;
  const url  = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '');

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (path === '/catalog' || path === '/home') {
    return handleGetCatalog(env, url);
  }
  if (path === '/status') {
    return handleStatus(env, url);
  }
  if (path === '/health') {
    return new Response(
      JSON.stringify({ status: 'OK', timestamp: new Date().toISOString(), version: '7.0', env: getEnvPrefix(url) }),
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  // POST /api/webhooks/mercadolibre es capturado por functions/api/webhooks/mercadolibre.js
  // (archivo específico tiene precedencia sobre [[route]].js en Pages Functions).

  return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
}

// ─── /api/catalog ────────────────────────────────────────────────────────────
// Lee R2 directamente. No usa KV. Soporta paginación y búsqueda.
// Campos disponibles en R2: id, title, author, price, status, available_quantity,
//                           thumbnail, pictures, permalink, start_time.

async function handleGetCatalog(env, url) {
  const page   = parseInt(url.searchParams.get('page')  || '0');
  const limit  = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  const search = (url.searchParams.get('q') || '').toLowerCase().trim();

  try {
    const r2Resp = await fetch(CATALOG_R2_URL);
    if (!r2Resp.ok) {
      return new Response(JSON.stringify({
        items: [], total: 0, page, limit, pages: 0,
        message: 'Catálogo temporalmente no disponible.'
      }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } });
    }

    const catalog  = await r2Resp.json();
    const allItems = (catalog && Array.isArray(catalog.items)) ? catalog.items : [];

    if (allItems.length === 0) {
      return new Response(JSON.stringify({
        items: [], total: 0, page, limit, pages: 0,
        message: 'Catálogo vacío o no disponible.'
      }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } });
    }

    if (search) {
      const filtered  = allItems.filter(item =>
        item.title?.toLowerCase().includes(search) ||
        item.author?.toLowerCase().includes(search)
      );
      const paginated = filtered.slice(page * limit, (page + 1) * limit);
      return new Response(JSON.stringify({
        items: paginated, total: filtered.length, page, limit,
        pages: Math.ceil(filtered.length / limit)
      }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } });
    }

    const paginated = allItems.slice(page * limit, (page + 1) * limit);
    return new Response(JSON.stringify({
      items: paginated, total: allItems.length, page, limit,
      pages: Math.ceil(allItems.length / limit),
      has_more: (page + 1) * limit < allItems.length
    }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } });

  } catch (error) {
    console.error('handleGetCatalog error:', error);
    return new Response(JSON.stringify({ error: error.message, items: [], total: 0 }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

// ─── /api/status ─────────────────────────────────────────────────────────────
// Lee sync:last_ok y sync:last_error del Worker desde KV.
// Lee metadata del catálogo desde R2 meta.json.
// No lee ni escribe datos de catálogo en KV.

async function handleStatus(env, url) {
  try {
    if (!env.AMADO_KV) {
      return new Response(
        JSON.stringify({ error: 'KV binding not available', hint: 'Configure AMADO_KV en CF Dashboard > Pages > Settings > Functions' }),
        { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // Estado del Worker (escrito por worker-sync/)
    const [lastOk, lastError] = await Promise.all([
      env.AMADO_KV.get('sync:last_ok'),
      env.AMADO_KV.get('sync:last_error'),
    ]);

    // Metadata del catálogo desde R2
    let catalogMeta = null;
    try {
      const metaResp = await fetch(META_R2_URL);
      if (metaResp.ok) {
        catalogMeta = await metaResp.json();
      }
    } catch (e) {
      catalogMeta = { fetch_error: e.message };
    }

    return new Response(
      JSON.stringify({
        env: getEnvPrefix(url),
        worker: {
          last_ok:    lastOk   || null,
          last_error: lastError || null,
        },
        catalog: catalogMeta,
      }),
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message, stack: (err.stack || '').slice(0, 600) }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
}
