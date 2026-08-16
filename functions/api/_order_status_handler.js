import { resolveConfig } from './_env_config.js';

const MAX_BODY_BYTES = 8192;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store' },
  });
}

export function createOrderStatusHandler() {
  return async function onRequest(context) {
    const { request, env } = context;

    if (request.method !== 'POST') {
      return json({ error: 'Método no permitido.' }, 405);
    }

    const config = resolveConfig(env);
    if (!config.ok) return json({ error: 'Servicio no disponible.' }, 503);

    const reqUrl = new URL(request.url);
    if (!config.isAllowedRequestHost(reqUrl.hostname)) {
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
      .prepare(
        'SELECT id,public_code,payment_status,status,delivery_type,products_total_uyu,' +
        'pickup_discount_uyu,shipping_cost_uyu,payable_total_uyu,currency ' +
        'FROM orders WHERE public_code=? AND idempotency_key=?'
      )
      .bind(publicCode, idempotencyKey)
      .first();

    if (!order) return json({ error: 'No encontrado.' }, 404);

    const itemsResult = await db
      .prepare(
        'SELECT product_id,title,quantity,unit_price_uyu,line_total_uyu ' +
        'FROM order_items WHERE order_id=? ORDER BY created_at,id'
      )
      .bind(order.id)
      .all();
    const items = Array.isArray(itemsResult?.results) ? itemsResult.results : [];

    return json({
      payment_status: order.payment_status,
      status: order.status,
      order: {
        public_code: order.public_code,
        delivery_type: order.delivery_type,
        products_total_uyu: Number(order.products_total_uyu) || 0,
        pickup_discount_uyu: Number(order.pickup_discount_uyu) || 0,
        shipping_cost_uyu: Number(order.shipping_cost_uyu) || 0,
        payable_total_uyu: Number(order.payable_total_uyu) || 0,
        currency: order.currency === 'UYU' ? 'UYU' : '',
      },
      items: items.map(item => ({
        product_id: String(item.product_id || ''),
        title: String(item.title || '').slice(0, 200),
        quantity: Math.max(1, Math.floor(Number(item.quantity) || 1)),
        unit_price_uyu: Number(item.unit_price_uyu) || 0,
        line_total_uyu: Number(item.line_total_uyu) || 0,
      })),
    });
  };
}
