import {
  createPreference as defaultCreatePreference,
  getPreference    as defaultGetPreference,
  searchPreferenceByRef as defaultSearchPreferenceByRef,
} from './_mp_client.js';
import { resolveConfig, checkoutDisabledResponse } from './_env_config.js';

const MAX_BODY_BYTES = 8192;
const MP_CLAIM_TTL   = 30;
const WEBHOOK_PATH    = '/api/webhooks/mercadopago';

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

function configErrorResponse() {
  return json({ error: 'Servicio no disponible.' }, 503);
}

async function clearClaim(db, orderId, claimValue, now) {
  try {
    await db
      .prepare('UPDATE orders SET payment_preference_id = NULL, updated_at = ? WHERE id = ? AND payment_preference_id = ?')
      .bind(now.toISOString(), orderId, claimValue)
      .run();
  } catch { /* best effort */ }
}

async function savePrefBatch(db, orderId, claimValue, prefId, now, appEnv) {
  const payload = JSON.stringify({ preference_id: prefId, environment: appEnv });
  return db.batch([
    db.prepare(
      "UPDATE orders SET payment_preference_id = ?, payment_provider = 'mercadopago', updated_at = ? WHERE id = ? AND payment_preference_id = ?"
    ).bind(prefId, now.toISOString(), orderId, claimValue),
    db.prepare(
      'INSERT INTO order_events (id, order_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), orderId, 'preference_created', payload, now.toISOString()),
  ]);
}

export function createPreferenceHandler({
  mpClient = {
    createPreference:      defaultCreatePreference,
    getPreference:         defaultGetPreference,
    searchPreferenceByRef: defaultSearchPreferenceByRef,
  },
} = {}) {
  return async function onRequest(context) {
    const { request, env } = context;

    if (request.method !== 'POST') {
      return json({ error: 'Método no permitido.' }, 405, { Allow: 'POST' });
    }

    const ct = request.headers.get('Content-Type') || '';
    if (!ct.toLowerCase().includes('application/json')) {
      return json({ error: 'Content-Type debe ser application/json.' }, 415);
    }

    const config = resolveConfig(env);
    if (!config.ok) return configErrorResponse();

    if (!config.checkoutEnabled) return checkoutDisabledResponse();

    const checkoutField = config.isProduction ? 'init_point' : 'sandbox_init_point';

    const token = env?.MP_ACCESS_TOKEN;
    if (!token) {
      return json({ error: 'Servicio de pago no configurado.', code: 'MP_NOT_CONFIGURED' }, 503);
    }

    const cl = Number.parseInt(request.headers.get('Content-Length') || '0', 10);
    if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) {
      return json({ error: 'Body demasiado grande.' }, 413);
    }
    let text;
    try { text = await request.text(); } catch { return json({ error: 'Error leyendo body.' }, 400); }
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      return json({ error: 'Body demasiado grande.' }, 413);
    }
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: 'JSON inválido.' }, 400); }

    if (!body || typeof body.public_code !== 'string' || !body.public_code.trim() || body.public_code.trim().length > 20) {
      return json({ error: 'public_code requerido.', code: 'MISSING_PUBLIC_CODE' }, 400);
    }
    if (!body || typeof body.idempotency_key !== 'string' || !body.idempotency_key.trim() || body.idempotency_key.trim().length > 128) {
      return json({ error: 'idempotency_key requerido.', code: 'MISSING_IDEMPOTENCY_KEY' }, 400);
    }

    const publicCode     = body.public_code.trim();
    const idempotencyKey = body.idempotency_key.trim();

    const reqUrl = new URL(request.url);
    if (!config.isAllowedRequestHost(reqUrl.hostname)) {
      return json({ error: 'Origen no permitido.', code: 'INVALID_ORIGIN' }, 400);
    }

    const db = env?.ORDERS_DB;
    if (!db) return json({ error: 'Servicio de órdenes no disponible.' }, 503);

    const order = await db
      .prepare(
        'SELECT id, status, payment_status, expires_at, payable_total_uyu, buyer_name, payment_preference_id ' +
        'FROM orders WHERE public_code = ? AND idempotency_key = ?'
      )
      .bind(publicCode, idempotencyKey)
      .first();

    if (!order) return json({ error: 'Pedido no encontrado.', code: 'ORDER_NOT_FOUND' }, 404);

    if (order.status === 'cancelled') {
      return json({ error: 'El pedido fue cancelado.', code: 'ORDER_CANCELLED' }, 410);
    }
    const now     = new Date();
    const expired =
      order.status === 'expired' ||
      (order.status === 'open' &&
       typeof order.expires_at === 'string' &&
       Number.isFinite(Date.parse(order.expires_at)) &&
       Date.parse(order.expires_at) <= now.getTime());
    if (expired) return json({ error: 'El pedido venció.', code: 'ORDER_EXPIRED' }, 410);
    if (order.payment_status === 'approved') {
      return json({ error: 'El pedido ya fue pagado.', code: 'ORDER_ALREADY_PAID' }, 409);
    }

    const mpOpts = { expectedCollectorId: config.mpCollectorId, checkoutField };

    const existingPref = order.payment_preference_id;
    if (existingPref && !existingPref.startsWith('creating:')) {
      const r = await mpClient.getPreference(existingPref, token, publicCode, mpOpts);
      if (r.ok) return json({ checkout_url: r.checkout_url });
      const s = r.code === 'MP_RATE_LIMIT' ? 503 : 502;
      return json({ error: 'Error al recuperar preferencia.', code: r.code }, s);
    }

    const epochNow       = Math.floor(now.getTime() / 1000);
    const staleThreshold = epochNow - MP_CLAIM_TTL;
    const claimValue     = 'creating:' + epochNow + ':' + crypto.randomUUID();

    const acquired = await db
      .prepare(
        "UPDATE orders SET payment_preference_id = ?, updated_at = ? " +
        "WHERE id = ? AND status = 'open' AND payment_status != 'approved' AND (" +
        "  payment_preference_id IS NULL " +
        "  OR (payment_preference_id LIKE 'creating:%' AND CAST(substr(payment_preference_id, 10, 10) AS INTEGER) <= ?)" +
        ")"
      )
      .bind(claimValue, now.toISOString(), order.id, staleThreshold)
      .run();

    if (acquired.meta.changes !== 1) {
      const current = await db
        .prepare('SELECT payment_preference_id FROM orders WHERE id = ?')
        .bind(order.id)
        .first();
      const curPref = current?.payment_preference_id;
      if (!curPref || curPref.startsWith('creating:')) {
        return json({ error: 'Pago en proceso. Intentá en unos segundos.', code: 'PREFERENCE_CREATING' }, 409);
      }
      const r = await mpClient.getPreference(curPref, token, publicCode, mpOpts);
      if (r.ok) return json({ checkout_url: r.checkout_url });
      return json({ error: 'Error al recuperar preferencia.', code: r.code }, 502);
    }

    const mpPayload = {
      items: [{
        title:      'Pedido Amado Libros ' + publicCode,
        quantity:    1,
        unit_price:  order.payable_total_uyu,
        currency_id: 'UYU',
      }],
      payer:              { name: order.buyer_name },
      external_reference: publicCode,
      expires:            true,
      expiration_date_to: order.expires_at,
      notification_url: config.canonicalOrigin + WEBHOOK_PATH,
      back_urls: {
        success: config.canonicalOrigin + '/pedido/?result=success&code=' + publicCode,
        pending: config.canonicalOrigin + '/pedido/?result=pending&code='  + publicCode,
        failure: config.canonicalOrigin + '/pedido/?result=failure&code='  + publicCode,
      },
      auto_return:          'approved',
      statement_descriptor: 'AMADO LIBROS',
    };

    const mpResult = await mpClient.createPreference(mpPayload, token, mpOpts);

    if (!mpResult.ok) {
      if (mpResult.code === 'MP_TIMEOUT') {
        const search = await mpClient.searchPreferenceByRef(publicCode, token, now, mpOpts);
        if (search.ok) {
          await savePrefBatch(db, order.id, claimValue, search.id, now, config.appEnv);
          return json({ checkout_url: search.checkout_url });
        }
        await clearClaim(db, order.id, claimValue, now);
        return json({ error: 'Servicio de pago no disponible.', code: 'MP_TIMEOUT' }, 503);
      }
      await clearClaim(db, order.id, claimValue, now);
      const s = mpResult.code === 'MP_RATE_LIMIT' ? 503 : 502;
      return json({ error: 'Error al crear preferencia de pago.', code: mpResult.code }, s);
    }

    const batchResult = await savePrefBatch(db, order.id, claimValue, mpResult.id, now, config.appEnv);

    if (batchResult[0].meta.changes !== 1) {
      const current2 = await db
        .prepare('SELECT payment_preference_id FROM orders WHERE id = ?')
        .bind(order.id)
        .first();
      const winner = current2?.payment_preference_id;
      if (winner && !winner.startsWith('creating:')) {
        const r = await mpClient.getPreference(winner, token, publicCode, mpOpts);
        if (r.ok) return json({ checkout_url: r.checkout_url });
      }
      return json({ error: 'Error al guardar preferencia.', code: 'PREFERENCE_WRITE_ERROR' }, 500);
    }

    return json({ checkout_url: mpResult.checkout_url });
  };
}
