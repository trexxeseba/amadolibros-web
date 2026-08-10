import {
  MAX_BODY_BYTES,
  validateCartAgainstCatalog,
  validateCartBody,
} from './_orders_logic.js';

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      ...extraHeaders,
    },
  });
}

export function createCartValidationHandler({ fetchCatalog }) {
  return async function onRequest(context) {
    const { request } = context;
    if (request.method !== 'POST') {
      return json({ error: 'Método no permitido.' }, 405, { Allow: 'POST' });
    }

    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
      return json({ error: 'Content-Type debe ser application/json.' }, 415);
    }

    const contentLength = Number.parseInt(request.headers.get('Content-Length') || '0', 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return json({ error: 'Body demasiado grande (máx. 32 KB).' }, 413);
    }

    let body;
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
        return json({ error: 'Body demasiado grande (máx. 32 KB).' }, 413);
      }
      body = JSON.parse(text);
    } catch {
      return json({ error: 'JSON inválido.' }, 400);
    }

    const validationError = validateCartBody(body);
    if (validationError) return json({ error: validationError }, 400);

    let catalog;
    try {
      catalog = await fetchCatalog(context);
    } catch {
      catalog = null;
    }
    if (!catalog || !Array.isArray(catalog.items)) {
      return json({
        error: 'No pudimos verificar la disponibilidad. Probá de nuevo en unos minutos.',
        code: 'CATALOG_UNAVAILABLE',
      }, 503);
    }

    const items = validateCartAgainstCatalog(body.items, catalog.items);
    return json({
      items,
      has_blocking_items: items.some(item => item.status === 'sin_stock' || item.status === 'no_existe'),
      has_changes: items.some(item => item.status !== 'ok'),
    });
  };
}
