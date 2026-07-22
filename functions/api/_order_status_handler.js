const MAX_BODY_BYTES    = 8192;
const MP_ALLOWED_SUFFIX = '.amadolibros-web.pages.dev';
const MP_ALLOWED_APEX   = 'amadolibros-web.pages.dev';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store' },
  });
}

function isAllowedHost(hostname) {
  return hostname === MP_ALLOWED_APEX || hostname.endsWith(MP_ALLOWED_SUFFIX);
}

export function createOrderStatusHandler() {
  return async function onRequest(context) {
    const { request, env } = context;

    if (request.method !== 'POST') {
      return json({ error: 'Método no permitido.' }, 405);
    }

    const reqUrl = new URL(request.url);
    if (!isAllowedHost(reqUrl.hostname)) {
      return json({ error: 'Origen no permitido.' }, 400);
    }

    const ct = request.headers.get('Content-Type') || '';
    if (!ct.toLowerCase().includes('application/json')) {
      return json({ error: 'Content-Type debe ser application/json.' }, 415);
    }

    const cl = Number.parseInt(request.headers.get('Content-Length') || '0', 10);
    if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) return json({ error: 'Body demasiado grande.' }, 413);
    let text;
    try { text = await request.text(); } catch { return json({ error: 'Error leyendo body.' }, 400); }
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return json({ error: 'Body demasiado grande.' }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: 'JSON inválido.' }, 400); }

    if (!body || typeof body.public_code !== 'string' || !body.public_code.trim()) {
      return json({ error: 'public_code requerido.' }, 400);
    }
    if (!body || typeof body.idempotency_key !== 'string' || !body.idempotency_key.trim()) {
      return json({ error: 'idempotency_key requerido.' }, 400);
    }

    const publicCode     = body.public_code.trim();
    const idempotencyKey = body.idempotency_key.trim();

    const db = env?.ORDERS_DB;
    if (!db) return json({ error: 'Servicio no disponible.' }, 503);

    const order = await db
      .prepare('SELECT payment_status,status FROM orders WHERE public_code=? AND idempotency_key=?')
      .bind(publicCode, idempotencyKey)
      .first();

    if (!order) return json({ error: 'No encontrado.' }, 404);

    return json({ payment_status: order.payment_status, status: order.status });
  };
}
