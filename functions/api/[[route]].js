// functions/api/[[route]].js
// VERSIÓN 7.0 - PAGES SOLO LECTURA
// El catálogo vive en R2. El Worker (worker-sync/) es la única fuente de escritura.
// Pages ya no sincroniza, no resetea, y no escribe datos de catálogo en KV.

import { STATUS_SYNC_STALE_MS, STATUS_SYNC_STUCK_MS } from '../_shared/status-policy.js';

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

// ─── fetchWithTimeout ────────────────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── /api/status ─────────────────────────────────────────────────────────────
// Observabilidad mínima: KV (sync state) + R2 (meta HEAD + catalog HEAD).
// No devuelve información interna ni mensajes de error crudos.

async function handleStatus(env, url) {
  const checkedAt = new Date().toISOString();

  if (!env.AMADO_KV) {
    return new Response(
      JSON.stringify({ status: 'degraded', healthy: false, code: 'kv_unavailable', checked_at: checkedAt }),
      { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }
    );
  }

  try {
    // KV: leer sync state en paralelo
    const [lastStarted, lastOk, lastError] = await Promise.all([
      env.AMADO_KV.get('sync:last_started'),
      env.AMADO_KV.get('sync:last_ok'),
      env.AMADO_KV.get('sync:last_error'),
    ]);

    // Frescura del sync — umbrales definidos una sola vez en _shared/status-policy.js.
    const lastOkDate = lastOk ? new Date(lastOk) : null;
    const lastOkValid = lastOkDate !== null && !isNaN(lastOkDate.getTime());

    let sync_fresh = false;
    let age_hours  = null;
    if (lastOkValid) {
      const ageMs = Date.now() - lastOkDate.getTime();
      age_hours   = Math.round((ageMs / 3_600_000) * 10) / 10;
      sync_fresh  = ageMs <= STATUS_SYNC_STALE_MS;
    }

    // Sync en progreso / trabado
    const lastStartedDate = lastStarted ? new Date(lastStarted) : null;
    const startedValid    = lastStartedDate !== null && !isNaN(lastStartedDate.getTime());
    const in_progress     = startedValid && (!lastOkValid || lastStartedDate > lastOkDate);
    const possibly_stuck  = in_progress && (Date.now() - lastStartedDate.getTime()) > STATUS_SYNC_STUCK_MS;

    // R2: verificar meta.json (GET) y catalog.json (HEAD) en paralelo
    const probeStarted = Date.now();
    const [metaResult, catalogResult] = await Promise.allSettled([
      (async () => {
        const resp = await fetchWithTimeout(META_R2_URL);
        if (!resp.ok) { console.error('[status] meta probe failed'); return null; }
        const data = await resp.json();
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          console.error('[status] meta probe failed');
          return null;
        }
        return data;
      })(),
      (async () => {
        const resp = await fetchWithTimeout(CATALOG_R2_URL, { method: 'HEAD' });
        if (!resp.ok) { console.error('[status] catalog probe failed'); return false; }
        return true;
      })(),
    ]);
    const r2_probe_ms = Date.now() - probeStarted;

    if (metaResult.status   === 'rejected') console.error('[status] meta probe failed');
    if (catalogResult.status === 'rejected') console.error('[status] catalog probe failed');

    const meta      = (metaResult.status === 'fulfilled')   ? metaResult.value   : null;
    const metaOk    = meta !== null;
    const catalogOk = (catalogResult.status === 'fulfilled') && catalogResult.value === true;

    // Warnings
    const warnings = [];
    if (!metaOk)                     warnings.push('meta_unavailable');
    if (!catalogOk)                  warnings.push('catalog_unavailable');
    if (!lastOk)                     warnings.push('sync_missing');
    else if (!sync_fresh)            warnings.push('sync_stale');
    if (Boolean(lastError))          warnings.push('sync_error');
    if (possibly_stuck)              warnings.push('sync_possibly_stuck');

    // Salud general
    const healthy = metaOk && catalogOk && sync_fresh && !Boolean(lastError) && !possibly_stuck;

    const total_items  = (metaOk && typeof meta.total === 'number' && isFinite(meta.total))
      ? meta.total : null;
    const last_updated = metaOk ? (meta.last_full_sync || meta.updated_at || null) : null;

    const body = {
      status:     healthy ? 'ok' : 'degraded',
      healthy,
      env:        getEnvPrefix(url),
      checked_at: checkedAt,
      worker: {
        last_started:  lastStarted    || null,
        last_ok:       lastOk         || null,
        has_error:     Boolean(lastError),
        sync_fresh,
        age_hours,
        in_progress,
        possibly_stuck,
      },
      catalog: {
        available:      catalogOk,
        meta_available: metaOk,
        total_items,
        last_updated,
      },
      performance: {
        r2_probe_ms,
      },
    };
    if (warnings.length > 0) body.warnings = warnings;

    return new Response(
      JSON.stringify(body),
      { status: healthy ? 200 : 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }
    );

  } catch (err) {
    console.error('[status] unexpected error', { name: err && err.name ? err.name : 'Error' });
    return new Response(
      JSON.stringify({ status: 'error', healthy: false, code: 'status_internal_error', checked_at: checkedAt }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }
    );
  }
}
