import {
  validateBody,
  validateShippingDate,
  consolidateItems,
  buildSnapshot,
  calculateTotals,
  generateFingerprint,
  generatePublicCode,
  EXPIRY_MINUTES,
  MAX_BODY_BYTES,
} from './_orders_logic.js';
import { verifyTurnstile } from './_turnstile.js';
import { resolveConfig, checkoutDisabledResponse } from './_env_config.js';

const EXISTING_ORDER_SELECT =
  'SELECT id, public_code, status, payment_status, delivery_type, ' +
  'products_total_uyu, pickup_discount_uyu, shipping_cost_uyu, ' +
  'payable_total_uyu, currency, expires_at, request_fingerprint ' +
  'FROM orders WHERE idempotency_key = ?';

export function createOrdersHandler({ fetchCatalog, getNow = () => new Date(), verifyTurnstileToken = verifyTurnstile }) {
  return async function onRequest(context) {
    const { request, env } = context;

    if (request.method !== 'POST') {
      return json({ error: 'Método no permitido.' }, 405, { Allow: 'POST' });
    }

    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
      return json({ error: 'Content-Type debe ser application/json.' }, 415);
    }

    const config = resolveConfig(env);
    if (!config.ok) return json({ error: 'Servicio no disponible.' }, 503);
    if (!config.checkoutEnabled) return checkoutDisabledResponse();

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

    const validationError = validateBody(body);
    if (validationError) return json({ error: validationError }, 400);

    // Fail-closed: ORDERS_DB y TURNSTILE_SECRET_KEY deben estar presentes juntos.
    const db = env?.ORDERS_DB;
    if (!db) return json({ error: 'Servicio de órdenes no disponible.' }, 503);

    const tsSecret = env?.TURNSTILE_SECRET_KEY;
    if (!tsSecret) {
      return json({ error: 'Servicio de verificación no configurado.', code: 'TS_NOT_CONFIGURED' }, 503);
    }

    const tsRaw = typeof body.cf_turnstile_response === 'string' ? body.cf_turnstile_response.trim() : '';
    if (!tsRaw) {
      return json({ error: 'Verificación requerida.', code: 'TOKEN_MISSING' }, 403);
    }
    if (tsRaw.length > 2048) {
      return json({ error: 'Token inválido.', code: 'TOKEN_INVALID' }, 403);
    }
    const tsResult = await verifyTurnstileToken(tsRaw, tsSecret, request.headers.get('CF-Connecting-IP') ?? '', {
      isAllowedHostname: config.isExpectedTurnstileHostname,
    });
    if (!tsResult.ok) {
      const svcErr = tsResult.code === 'SITEVERIFY_ERROR' || tsResult.code === 'SITEVERIFY_TIMEOUT';
      return json(
        { error: svcErr ? 'Servicio de verificación no disponible.' : 'Verificación fallida.', code: tsResult.code },
        svcErr ? 503 : 403
      );
    }

    const now = getNow();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      console.error('[orders] invalid clock');
      return json({ error: 'Error interno. Intentá de nuevo.' }, 500);
    }

    if (body.delivery_type === 'shipping') {
      const dateError = validateShippingDate(
        body.shipping.requested_date,
        body.shipping.requested_from,
        body.shipping.requested_to,
        now
      );
      if (dateError) return json({ error: dateError }, 400);
    }

    const consolidatedItems = consolidateItems(body.items);
    const fingerprint = generateFingerprint(body, consolidatedItems);
    const idempotencyKey = body.idempotency_key.trim();

    let existingOrder;
    try {
      existingOrder = await findOrderByIdempotencyKey(db, idempotencyKey);
    } catch (error) {
      console.error('[orders] idempotency lookup error', safeErrorName(error));
      return json({ error: 'Servicio de órdenes no disponible.' }, 503);
    }

    if (existingOrder) {
      return handleExistingOrder({ db, order: existingOrder, fingerprint, now });
    }

    const catalog = await fetchCatalog(context).catch(() => null);
    if (!catalog || !Array.isArray(catalog.items)) {
      return json({ error: 'Catálogo no disponible. Intentá de nuevo en unos segundos.' }, 503);
    }

    const { errors, snapshot } = buildSnapshot(consolidatedItems, catalog.items);
    if (errors.length > 0) {
      return json({ error: 'Productos con problemas.', details: errors }, 422);
    }

    const { productsTotal, pickupDiscount, shippingCost, payableTotal } =
      calculateTotals(snapshot, body.delivery_type, body.shipping?.department || '');

    let publicCode = null;
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = generatePublicCode(now);
        const codeExists = await db
          .prepare('SELECT id FROM orders WHERE public_code = ?')
          .bind(candidate)
          .first();
        if (!codeExists) {
          publicCode = candidate;
          break;
        }
      }
    } catch (error) {
      console.error('[orders] public code lookup error', safeErrorName(error));
      return json({ error: 'Servicio de órdenes no disponible.' }, 503);
    }

    if (!publicCode) return json({ error: 'Error interno. Intentá de nuevo.' }, 500);

    const orderId = crypto.randomUUID();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + EXPIRY_MINUTES * 60 * 1000).toISOString();
    const shipping = body.shipping || {};

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
      orderId,
      publicCode,
      idempotencyKey,
      fingerprint,
      body.buyer.name.trim(),
      body.buyer.phone.trim(),
      body.delivery_type,
      typeof shipping.address === 'string' ? shipping.address.trim() : null,
      typeof shipping.locality === 'string' ? shipping.locality.trim() : null,
      typeof shipping.department === 'string' ? shipping.department.trim() : null,
      shipping.requested_date || null,
      shipping.requested_from || null,
      shipping.requested_to || null,
      typeof shipping.notes === 'string' && shipping.notes.trim() ? shipping.notes.trim() : null,
      productsTotal,
      pickupDiscount,
      shippingCost,
      payableTotal,
      createdAt,
      expiresAt,
      createdAt
    );

    const itemStmts = snapshot.map(item =>
      db.prepare(
        'INSERT INTO order_items ' +
        '(id, order_id, product_id, title, quantity, unit_price_uyu, line_total_uyu, ' +
        'image_url, observed_available_quantity, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        crypto.randomUUID(),
        orderId,
        item.product_id,
        item.title,
        item.quantity,
        item.unit_price_uyu,
        item.line_total_uyu,
        item.image_url,
        item.observed_available_quantity,
        createdAt
      )
    );

    const eventStmt = db.prepare(
      'INSERT INTO order_events (id, order_id, event_type, payload_json, created_at) ' +
      'VALUES (?, ?, ?, ?, ?)'
    ).bind(
      crypto.randomUUID(),
      orderId,
      'created',
      JSON.stringify({
        delivery_type: body.delivery_type,
        products_total: productsTotal,
        payable_total: payableTotal,
      }),
      createdAt
    );

    try {
      await db.batch([orderStmt, ...itemStmts, eventStmt]);
    } catch (batchError) {
      // Ante una carrera, otra request pudo crear la orden entre el SELECT y el batch.
      try {
        const raceOrder = await findOrderByIdempotencyKey(db, idempotencyKey);
        if (raceOrder) {
          return handleExistingOrder({ db, order: raceOrder, fingerprint, now });
        }
      } catch {
        // Se conserva el error genérico de escritura; no se expone detalle interno.
      }

      console.error('[orders] batch error', safeErrorName(batchError));
      return json({ error: 'Error al guardar el pedido. Intentá de nuevo.' }, 500);
    }

    return json({
      order: {
        public_code: publicCode,
        status: 'open',
        payment_status: 'not_started',
        delivery_type: body.delivery_type,
        products_total_uyu: productsTotal,
        pickup_discount_uyu: pickupDiscount,
        shipping_cost_uyu: shippingCost,
        payable_total_uyu: payableTotal,
        currency: 'UYU',
        expires_at: expiresAt,
      },
    }, 201);
  };
}

async function findOrderByIdempotencyKey(db, idempotencyKey) {
  return db.prepare(EXISTING_ORDER_SELECT).bind(idempotencyKey).first();
}

async function handleExistingOrder({ db, order, fingerprint, now }) {
  if (order.request_fingerprint !== fingerprint) {
    return json(
      { error: 'Conflicto: el mismo idempotency_key fue usado con un pedido diferente.' },
      409
    );
  }

  const expired = order.status === 'expired' || (
    order.status === 'open' &&
    typeof order.expires_at === 'string' &&
    Number.isFinite(Date.parse(order.expires_at)) &&
    Date.parse(order.expires_at) <= now.getTime()
  );

  if (expired) {
    if (order.status === 'open' && order.id) {
      try {
        await db
          .prepare("UPDATE orders SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'open'")
          .bind(now.toISOString(), order.id)
          .run();
      } catch (error) {
        console.error('[orders] expire update error', safeErrorName(error));
      }
    }

    return json({
      error: 'La orden anterior venció. Volvé a preparar el pedido.',
      code: 'ORDER_EXPIRED',
    }, 410);
  }

  return json({ order: formatOrder(order) }, 200);
}

function formatOrder(order) {
  return {
    public_code: order.public_code,
    status: order.status,
    payment_status: order.payment_status,
    delivery_type: order.delivery_type,
    products_total_uyu: order.products_total_uyu,
    pickup_discount_uyu: order.pickup_discount_uyu,
    shipping_cost_uyu: order.shipping_cost_uyu,
    payable_total_uyu: order.payable_total_uyu,
    currency: order.currency,
    expires_at: order.expires_at,
  };
}

function safeErrorName(error) {
  return error && typeof error === 'object' && typeof error.name === 'string'
    ? error.name
    : 'Error';
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}
