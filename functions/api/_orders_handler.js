import {
  validateBody,
  validateShippingDate,
  consolidateItems,
  buildSnapshot,
  calculateTotals,
  generateFingerprint,
  generatePublicCode,
  MAX_BODY_BYTES,
} from './_orders_logic.js';

export function createOrdersHandler({ fetchCatalog, getNow = () => new Date() }) {
  return async function onRequest(context) {
    const { request, env } = context;

    if (request.method !== 'POST') {
      return json({ error: 'Método no permitido.' }, 405);
    }

    const ct = request.headers.get('Content-Type') || '';
    if (!ct.includes('application/json')) {
      return json({ error: 'Content-Type debe ser application/json.' }, 415);
    }

    const clHeader = parseInt(request.headers.get('Content-Length') || '0', 10);
    if (clHeader > MAX_BODY_BYTES) {
      return json({ error: 'Body demasiado grande (máx. 32 KB).' }, 413);
    }

    let body;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) {
        return json({ error: 'Body demasiado grande (máx. 32 KB).' }, 413);
      }
      body = JSON.parse(text);
    } catch {
      return json({ error: 'JSON inválido.' }, 400);
    }

    const validationError = validateBody(body);
    if (validationError) return json({ error: validationError }, 400);

    const db = env?.ORDERS_DB;
    if (!db) return json({ error: 'Servicio de órdenes no disponible.' }, 503);

    const catalog = await fetchCatalog(context).catch(() => null);
    if (!catalog || !Array.isArray(catalog.items)) {
      return json({ error: 'Catálogo no disponible. Intentá de nuevo en unos segundos.' }, 503);
    }

    const consolidatedItems = consolidateItems(body.items);
    const { errors, snapshot } = buildSnapshot(consolidatedItems, catalog.items);
    if (errors.length > 0) {
      return json({ error: 'Productos con problemas.', details: errors }, 422);
    }

    const { productsTotal, pickupDiscount, shippingCost, payableTotal } =
      calculateTotals(snapshot, body.delivery_type);

    const now = getNow();

    if (body.delivery_type === 'shipping' && body.shipping) {
      const dateError = validateShippingDate(
        body.shipping.requested_date,
        body.shipping.requested_from,
        body.shipping.requested_to,
        now
      );
      if (dateError) return json({ error: dateError }, 400);
    }

    const fingerprint = generateFingerprint(body, consolidatedItems);

    const existingOrder = await db
      .prepare(
        'SELECT public_code, status, payment_status, delivery_type, ' +
        'products_total_uyu, pickup_discount_uyu, shipping_cost_uyu, ' +
        'payable_total_uyu, currency, expires_at, request_fingerprint ' +
        'FROM orders WHERE idempotency_key = ?'
      )
      .bind(body.idempotency_key)
      .first();

    if (existingOrder) {
      if (existingOrder.request_fingerprint === fingerprint) {
        return json({ order: formatOrder(existingOrder) }, 200);
      }
      return json(
        { error: 'Conflicto: el mismo idempotency_key fue usado con un pedido diferente.' },
        409
      );
    }

    let publicCode = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generatePublicCode(now);
      const codeExists = await db
        .prepare('SELECT id FROM orders WHERE public_code = ?')
        .bind(candidate)
        .first();
      if (!codeExists) { publicCode = candidate; break; }
    }
    if (!publicCode) return json({ error: 'Error interno. Intentá de nuevo.' }, 500);

    const orderId    = crypto.randomUUID();
    const createdAt  = now.toISOString();
    const expiresAt  = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const shipping   = body.shipping || {};

    const orderStmt = db.prepare(
      'INSERT INTO orders (' +
        'id, public_code, idempotency_key, request_fingerprint, ' +
        'status, payment_status, ' +
        'buyer_name, buyer_phone, ' +
        'delivery_type, ' +
        'address, locality, department, ' +
        'requested_delivery_date, requested_delivery_from, requested_delivery_to, delivery_notes, ' +
        'products_total_uyu, pickup_discount_uyu, shipping_cost_uyu, payable_total_uyu, ' +
        'currency, created_at, expires_at, updated_at' +
      ') VALUES (' +
        '?, ?, ?, ?, ' +
        "'open', 'not_started', " +
        '?, ?, ' +
        '?, ' +
        '?, ?, ?, ' +
        '?, ?, ?, ?, ' +
        '?, ?, ?, ?, ' +
        "'UYU', ?, ?, ?" +
      ')'
    ).bind(
      orderId, publicCode, body.idempotency_key, fingerprint,
      body.buyer.name.trim(), body.buyer.phone.trim(),
      body.delivery_type,
      shipping.address    || null,
      shipping.locality   || null,
      shipping.department || null,
      shipping.requested_date || null,
      shipping.requested_from || null,
      shipping.requested_to   || null,
      shipping.notes          || null,
      productsTotal, pickupDiscount, shippingCost, payableTotal,
      createdAt, expiresAt, createdAt
    );

    const itemStmts = snapshot.map(it =>
      db.prepare(
        'INSERT INTO order_items ' +
        '(id, order_id, product_id, title, quantity, unit_price_uyu, line_total_uyu, ' +
        'image_url, observed_available_quantity, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        crypto.randomUUID(), orderId,
        it.product_id, it.title, it.quantity,
        it.unit_price_uyu, it.line_total_uyu,
        it.image_url, it.observed_available_quantity,
        createdAt
      )
    );

    const eventStmt = db.prepare(
      'INSERT INTO order_events (id, order_id, event_type, payload_json, created_at) ' +
      'VALUES (?, ?, ?, ?, ?)'
    ).bind(
      crypto.randomUUID(), orderId,
      'created',
      JSON.stringify({
        delivery_type:   body.delivery_type,
        products_total:  productsTotal,
        payable_total:   payableTotal,
      }),
      createdAt
    );

    try {
      await db.batch([orderStmt, ...itemStmts, eventStmt]);
    } catch (batchErr) {
      const msg = String(batchErr);
      if (msg.includes('UNIQUE constraint failed') && msg.includes('idempotency_key')) {
        const raceOrder = await db
          .prepare(
            'SELECT public_code, status, payment_status, delivery_type, ' +
            'products_total_uyu, pickup_discount_uyu, shipping_cost_uyu, ' +
            'payable_total_uyu, currency, expires_at, request_fingerprint ' +
            'FROM orders WHERE idempotency_key = ?'
          )
          .bind(body.idempotency_key)
          .first();
        if (raceOrder) {
          if (raceOrder.request_fingerprint === fingerprint) {
            return json({ order: formatOrder(raceOrder) }, 200);
          }
          return json(
            { error: 'Conflicto: el mismo idempotency_key fue usado con un pedido diferente.' },
            409
          );
        }
      }
      console.error('[orders] batch error', msg);
      return json({ error: 'Error al guardar el pedido. Intentá de nuevo.' }, 500);
    }

    return json({
      order: {
        public_code:         publicCode,
        status:              'open',
        payment_status:      'not_started',
        delivery_type:       body.delivery_type,
        products_total_uyu:  productsTotal,
        pickup_discount_uyu: pickupDiscount,
        shipping_cost_uyu:   shippingCost,
        payable_total_uyu:   payableTotal,
        currency:            'UYU',
        expires_at:          expiresAt,
      },
    }, 201);
  };
}

function formatOrder(order) {
  return {
    public_code:         order.public_code,
    status:              order.status,
    payment_status:      order.payment_status,
    delivery_type:       order.delivery_type,
    products_total_uyu:  order.products_total_uyu,
    pickup_discount_uyu: order.pickup_discount_uyu,
    shipping_cost_uyu:   order.shipping_cost_uyu,
    payable_total_uyu:   order.payable_total_uyu,
    currency:            order.currency,
    expires_at:          order.expires_at,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
  });
}
