import {
  getPayment      as defaultGetPayment,
  getMerchantOrder as defaultGetMerchantOrder,
} from './_mp_client.js';
import { resolveConfig } from './_env_config.js';
import { sendSaleNotification as defaultSendSaleNotification } from './_sale_notification.js';

const MAX_BODY_BYTES = 32768;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store' },
  });
}

function noContent(status) {
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function verifyHmac(secret, message, hexSignature) {
  try {
    const keyMaterial = new TextEncoder().encode(secret);
    const key = await crypto.subtle.importKey(
      'raw', keyMaterial, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    if (hexSignature.length % 2 !== 0) return false;
    const sigBytes = new Uint8Array(hexSignature.length / 2);
    for (let i = 0; i < hexSignature.length; i += 2) {
      const byte = parseInt(hexSignature.slice(i, i + 2), 16);
      if (isNaN(byte)) return false;
      sigBytes[i / 2] = byte;
    }
    return await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

function normalizeStatus(mpStatus) {
  if (mpStatus === 'approved')                               return 'approved';
  if (mpStatus === 'pending' || mpStatus === 'in_process' ||
      mpStatus === 'authorized')                             return 'pending';
  if (mpStatus === 'rejected')                              return 'rejected';
  if (mpStatus === 'cancelled')                             return 'cancelled';
  if (mpStatus === 'refunded' || mpStatus === 'charged_back') return 'refunded';
  return null;
}

async function applyApproved(db, order, payment, now) {
  const eventId  = `mp:${payment.id}:approved`;
  const paidAt   = payment.date_approved || now.toISOString();
  const payload  = JSON.stringify({ payment_id: payment.id, amount: payment.transaction_amount });
  return db.batch([
    db.prepare(
      "UPDATE orders SET payment_status='approved', status='paid', payment_id=?, paid_at=?, updated_at=? " +
      "WHERE id=? AND payment_status!='approved'"
    ).bind(String(payment.id), paidAt, now.toISOString(), order.id),
    db.prepare(
      "INSERT OR IGNORE INTO order_events (id,order_id,event_type,payload_json,created_at) VALUES (?,?,'payment_approved',?,?)"
    ).bind(eventId, order.id, payload, now.toISOString()),
  ]);
}

async function applyPending(db, order, payment, now) {
  const eventId = `mp:${payment.id}:pending`;
  const payload = JSON.stringify({ payment_id: payment.id });
  return db.batch([
    db.prepare(
      "UPDATE orders SET payment_status='pending', payment_id=?, updated_at=? " +
      "WHERE id=? AND payment_status NOT IN ('approved','pending')"
    ).bind(String(payment.id), now.toISOString(), order.id),
    db.prepare(
      "INSERT OR IGNORE INTO order_events (id,order_id,event_type,payload_json,created_at) VALUES (?,?,'payment_pending',?,?)"
    ).bind(eventId, order.id, payload, now.toISOString()),
  ]);
}

async function applyRejected(db, order, payment, now) {
  const eventId = `mp:${payment.id}:rejected`;
  const payload = JSON.stringify({ payment_id: payment.id });
  return db.batch([
    db.prepare(
      "UPDATE orders SET payment_status='rejected', payment_id=?, updated_at=? " +
      "WHERE id=? AND payment_status NOT IN ('approved','rejected')"
    ).bind(String(payment.id), now.toISOString(), order.id),
    db.prepare(
      "INSERT OR IGNORE INTO order_events (id,order_id,event_type,payload_json,created_at) VALUES (?,?,'payment_rejected',?,?)"
    ).bind(eventId, order.id, payload, now.toISOString()),
  ]);
}

async function applyCancelled(db, order, payment, now) {
  const eventId = `mp:${payment.id}:cancelled`;
  const payload = JSON.stringify({ payment_id: payment.id });
  return db.batch([
    db.prepare(
      "UPDATE orders SET payment_status='cancelled', payment_id=?, updated_at=? " +
      "WHERE id=? AND payment_status NOT IN ('approved','cancelled')"
    ).bind(String(payment.id), now.toISOString(), order.id),
    db.prepare(
      "INSERT OR IGNORE INTO order_events (id,order_id,event_type,payload_json,created_at) VALUES (?,?,'payment_cancelled',?,?)"
    ).bind(eventId, order.id, payload, now.toISOString()),
  ]);
}

async function applyRefunded(db, order, payment, now) {
  const eventId = `mp:${payment.id}:refunded`;
  const payload = JSON.stringify({ payment_id: payment.id });
  return db.batch([
    db.prepare(
      "UPDATE orders SET payment_status='refunded', payment_id=?, updated_at=? " +
      "WHERE id=? AND payment_status!='refunded'"
    ).bind(String(payment.id), now.toISOString(), order.id),
    db.prepare(
      "INSERT OR IGNORE INTO order_events (id,order_id,event_type,payload_json,created_at) VALUES (?,?,'payment_refunded',?,?)"
    ).bind(eventId, order.id, payload, now.toISOString()),
  ]);
}

export function createMpWebhookHandler({
  mpClient = { getPayment: defaultGetPayment, getMerchantOrder: defaultGetMerchantOrder },
  getNow       = () => new Date(),
  saleNotifier = defaultSendSaleNotification,
} = {}) {
  return async function onRequest(context) {
    const { request, env } = context;

    if (request.method !== 'POST') {
      return json({ error: 'Método no permitido.' }, 405);
    }

    // Config falla cerrada antes de tocar cualquier otra cosa. Mercado Pago
    // no es un navegador: este endpoint nunca exige encabezado Origin.
    const config = resolveConfig(env);
    if (!config.ok) return noContent(503);

    const reqUrl = new URL(request.url);
    if (!config.isAllowedRequestHost(reqUrl.hostname)) {
      return json({ error: 'Origen no permitido.' }, 400);
    }

    const webhookSecret = env?.MP_WEBHOOK_SECRET;
    const accessToken   = env?.MP_ACCESS_TOKEN;
    if (!webhookSecret || !accessToken) return noContent(503);

    // Size check
    const cl = Number.parseInt(request.headers.get('Content-Length') || '0', 10);
    if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) return json({ error: 'Body demasiado grande.' }, 400);
    let text;
    try { text = await request.text(); } catch { return json({ error: 'Error leyendo body.' }, 400); }
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      return json({ error: 'Body demasiado grande.' }, 400);
    }

    // Parse body
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: 'Payload inválido.' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json({ error: 'Payload inválido.' }, 400);
    }

    // Signature headers
    const xSig   = request.headers.get('x-signature');
    const xReqId = request.headers.get('x-request-id');
    if (!xSig || !xReqId) return json({ error: 'Firma inválida.' }, 401);

    // Parse x-signature: ts=<ts>,v1=<hex>
    let ts = null, v1 = null;
    for (const part of xSig.split(',')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      if (k === 'ts') ts = v;
      if (k === 'v1') v1 = v;
    }
    if (!ts || !v1) return json({ error: 'Firma inválida.' }, 401);

    // data.id from query param (MP's official signed field)
    const queryDataId = reqUrl.searchParams.get('data.id');
    if (!queryDataId) return json({ error: 'Firma inválida.' }, 401);

    // body.data.id must exist and match
    const bodyDataId = body?.data?.id;
    if (bodyDataId === undefined || bodyDataId === null) return json({ error: 'Payload inválido.' }, 400);
    if (String(bodyDataId) !== String(queryDataId)) return json({ error: 'Payload inválido.' }, 400);

    // HMAC verification — constant time via Web Crypto
    const signedString = `id:${queryDataId};request-id:${xReqId};ts:${ts};`;
    const valid = await verifyHmac(webhookSecret, signedString, v1);
    if (!valid) return json({ error: 'Firma inválida.' }, 401);

    // Only process payment type
    if (body.type !== 'payment') return json({ ok: true });

    const db = env?.ORDERS_DB;
    if (!db) return noContent(503);

    // Fetch payment from MP. Cualquier falla (timeout, red, 429, 5xx, y
    // también 401/403/404) es una imposibilidad de validar, no un "no
    // corresponde" — se devuelve 503 para que Mercado Pago reintente en vez
    // de asumir silenciosamente que el evento es irrelevante.
    const paymentResult = await mpClient.getPayment(queryDataId, accessToken);
    if (!paymentResult.ok) return noContent(503);
    const payment = paymentResult;

    // Validate ownership/identity — live_mode es solo diagnóstico, nunca gate
    // (un pago contra nuestro MP_COLLECTOR_ID configurado, con importe,
    // external_reference y merchant_order coincidentes, es nuestro sin
    // importar cómo Mercado Pago clasificó el modo de la transacción).
    if (payment.collector_id !== config.mpCollectorId) return json({ ok: true });
    if (payment.currency_id !== 'UYU')                 return json({ ok: true });

    // Find order by external_reference
    const publicCode = payment.external_reference;
    if (!publicCode || typeof publicCode !== 'string') return json({ ok: true });

    const order = await db
      .prepare(
        'SELECT id,public_code,status,payment_status,buyer_name,buyer_phone,delivery_type,' +
        'address,locality,department,requested_delivery_date,requested_delivery_from,' +
        'requested_delivery_to,delivery_notes,products_total_uyu,pickup_discount_uyu,' +
        'shipping_cost_uyu,payable_total_uyu,currency,payment_preference_id ' +
        'FROM orders WHERE public_code=?'
      )
      .bind(publicCode)
      .first();
    if (!order) return json({ ok: true });

    // Validate exact amount
    if (Number(payment.transaction_amount) !== order.payable_total_uyu) return json({ ok: true });

    // Validate via merchant order if available
    if (payment.order_id) {
      const moResult = await mpClient.getMerchantOrder(payment.order_id, accessToken);
      if (!moResult.ok) return noContent(503);

      const prefId = order.payment_preference_id;
      if (prefId && !prefId.startsWith('creating:') && moResult.preference_id !== prefId) {
        return json({ ok: true });
      }

      if (moResult.external_reference && moResult.external_reference !== publicCode) {
        return json({ ok: true });
      }

      const pidStr = String(queryDataId);
      const inPayments = moResult.payments.some(
        p => String(p.id) === pidStr || p.id === Number(queryDataId)
      );
      if (!inPayments) return json({ ok: true });
    }

    if (payment.live_mode !== config.expectedLiveMode) {
      console.warn('mp_webhook: live_mode inesperado', {
        payment_id: payment.id,
        app_env: config.appEnv,
        expected: config.expectedLiveMode,
        observed: payment.live_mode,
      });
    }

    const normalized = normalizeStatus(payment.status);
    if (!normalized) return json({ ok: true });

    const now = getNow();
    try {
      if (normalized === 'approved')   await applyApproved(db, order, payment, now);
      else if (normalized === 'pending')   await applyPending(db, order, payment, now);
      else if (normalized === 'rejected')  await applyRejected(db, order, payment, now);
      else if (normalized === 'cancelled') await applyCancelled(db, order, payment, now);
      else if (normalized === 'refunded')  await applyRefunded(db, order, payment, now);
    } catch {
      return json({ error: 'Error temporal.' }, 500);
    }

    // La notificación interna nunca forma parte de la confirmación del pago:
    // primero D1 queda en paid/approved y después se envía en segundo plano.
    // Un fallo de Resend se registra en order_events, pero Mercado Pago recibe
    // 200 para no degradar una venta ya validada.
    if (normalized === 'approved' && config.isProduction) {
      const notification = Promise.resolve(
        saleNotifier({ db, env, order, payment, now })
      ).catch(error => {
        console.error('[mp_webhook] falló la tarea de notificación', {
          order_id: order.id,
          error: error?.name || 'Error',
        });
      });

      if (typeof context.waitUntil === 'function') context.waitUntil(notification);
      else await notification;
    }

    return json({ ok: true });
  };
}
