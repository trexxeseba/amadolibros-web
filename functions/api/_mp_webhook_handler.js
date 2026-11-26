import {
  getPayment      as defaultGetPayment,
  getMerchantOrder as defaultGetMerchantOrder,
} from './_mp_client.js';
import { resolveConfig } from './_env_config.js';
import { marcarPremioUsadoStmt } from '../_shared/premio-web.js';
import { sendSaleNotification as defaultSendSaleNotification } from './_sale_notification.js';
import { orderEmailService as defaultOrderEmailService } from './_order_email.js';
import { sendGa4Purchase as defaultSendGa4Purchase } from './_ga4_measurement.js';
import { sendMetaPurchase as defaultSendMetaPurchase } from '../_shared/purchase-tracking.js';
import { reportIncident as defaultReportIncident } from './_payment_incidents.js';

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

// Lo que se guarda de cada notificación: el id del pago y los códigos de
// Mercado Pago que explican el resultado. Sin datos del pagador.
function paymentPayload(payment, extra = {}) {
  return JSON.stringify({
    payment_id: payment.id,
    ...extra,
    status_detail: payment.status_detail ?? null,
    payment_method_id: payment.payment_method_id ?? null,
    payment_type_id: payment.payment_type_id ?? null,
  });
}

function approvalDate(payment, now) {
  const milliseconds = typeof payment.date_approved === 'string'
    ? Date.parse(payment.date_approved) : NaN;
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString() : now.toISOString();
}

async function applyApproved(db, order, payment, now, queueAnalytics = false) {
  const eventId  = `mp:${payment.id}:approved`;
  const paidAt   = approvalDate(payment, now);
  const payload  = paymentPayload(payment, { amount: payment.transaction_amount });
  const statements = [
    db.prepare(
      "INSERT OR IGNORE INTO order_events (id,order_id,event_type,payload_json,created_at) " +
      "SELECT ?,id,'payment_after_cancellation',?,? FROM orders WHERE id=? " +
      "AND (status='cancelled' OR cancelled_at IS NOT NULL) AND payment_status!='approved'"
    ).bind(`mp:${payment.id}:after-cancellation`, payload, now.toISOString(), order.id),
    db.prepare(
      "UPDATE orders SET payment_status='approved', status='paid', cancelled_at=NULL, payment_id=?, paid_at=?, " +
      "paid_amount_uyu=?, updated_at=? WHERE id=? AND payment_status!='approved'"
    ).bind(String(payment.id), paidAt, order.payable_total_uyu, now.toISOString(), order.id),
    db.prepare(
      "INSERT OR IGNORE INTO order_events (id,order_id,event_type,payload_json,created_at) VALUES (?,?,'payment_approved',?,?)"
    ).bind(eventId, order.id, payload, now.toISOString()),
  ];
  if (order.premio_code) statements.push(marcarPremioUsadoStmt(db, order.id, paidAt));
  if (queueAnalytics) {
    statements.push(db.prepare(
      "INSERT OR IGNORE INTO order_events (id,order_id,event_type,payload_json,created_at) VALUES (?,?,'ga4_purchase',?,?)"
    ).bind(
      `ga4-purchase:${order.id}`,
      order.id,
      JSON.stringify({
        status: 'pending',
        transaction_id: order.public_code,
        payment_id: String(payment.id),
        queued_at: now.toISOString(),
      }),
      now.toISOString(),
    ));
  }
  return db.batch(statements);
}

async function applyPending(db, order, payment, now) {
  const eventId = `mp:${payment.id}:pending`;
  const payload = paymentPayload(payment);
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
  const payload = paymentPayload(payment);
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
  const payload = paymentPayload(payment);
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
  const payload = paymentPayload(payment);
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

// Motivos por los que un pago aprobado de nuestra cuenta NO se aplica a un
// pedido, o se aplica pero necesita que una persona lo mire. Ninguno marca un
// pedido como pagado: quedan anotados en payment_incidents y se avisa por
// correo.
export const INCIDENT = Object.freeze({
  CURRENCY: 'moneda_distinta',
  ORDER_MISSING: 'pedido_inexistente',
  AMOUNT: 'importe_distinto',
  PREFERENCE: 'preferencia_distinta',
  REFERENCE: 'referencia_distinta',
  NOT_IN_MERCHANT_ORDER: 'pago_fuera_de_la_orden',
  DUPLICATE: 'pago_duplicado',
  REFUNDED: 'pago_devuelto',
});

// Las referencias de la web empiezan con "AL-". La misma cuenta de Mercado
// Pago cobra también las ventas de Mercado Libre, que no son pedidos web.
export function isWebOrderReference(value) {
  return typeof value === 'string' && /^AL-[A-Z0-9-]{1,17}$/.test(value);
}

/**
 * Procesa un pago de Mercado Pago ya identificado por su id. Es el único
 * camino que puede dejar un pedido como pagado y lo usan tanto el aviso
 * firmado (webhook) como la conciliación: las validaciones son las mismas.
 *
 * Devuelve { result, reason?, normalized? } con result:
 *   'retry'   no se pudo validar (Mercado Pago o la base no respondieron)
 *   'error'   falló la escritura en la base
 *   'ignored' no corresponde aplicarlo (reason dice por qué)
 *   'applied' el estado quedó escrito en el pedido
 */
export function createPaymentProcessor({
  mpClient = { getPayment: defaultGetPayment, getMerchantOrder: defaultGetMerchantOrder },
  getNow       = () => new Date(),
  saleNotifier = defaultSendSaleNotification,
  orderEmails  = defaultOrderEmailService,
  purchaseAnalytics = { sendPurchase: defaultSendGa4Purchase },
  metaPurchase = { sendPurchase: defaultSendMetaPurchase },
  incidents = { report: defaultReportIncident },
} = {}) {
  return async function processPayment({ context, env, config, db, accessToken, paymentId, source = 'webhook' }) {
    // Fetch payment from MP. Cualquier falla (timeout, red, 429, 5xx, y
    // también 401/403/404) es una imposibilidad de validar, no un "no
    // corresponde" — se pide reintento en vez de asumir silenciosamente que
    // el evento es irrelevante.
    const paymentResult = await mpClient.getPayment(paymentId, accessToken);
    if (!paymentResult.ok) return { result: 'retry', reason: 'mp_payment_unavailable' };
    const payment = paymentResult;

    const background = promise => {
      if (typeof context?.waitUntil === 'function') { context.waitUntil(promise); return Promise.resolve(); }
      return promise;
    };

    // Anota un incidente sin cambiar el resultado: sólo para pagos de la web
    // en los que hay plata de por medio (aprobados o devueltos).
    const report = (incident, order = null) => {
      if (!isWebOrderReference(payment.external_reference)) return Promise.resolve();
      if (payment.status !== 'approved' && incident !== INCIDENT.REFUNDED) return Promise.resolve();
      return background(Promise.resolve()
        .then(() => incidents.report({
          db, env, now: getNow(), source, notify: config.isProduction,
          incident: {
            reason: incident,
            payment_id: String(payment.id),
            public_code: payment.external_reference,
            order_id: order?.id ?? null,
            mp_status: payment.status,
            mp_amount_uyu: Number(payment.transaction_amount),
            order_amount_uyu: order ? order.payable_total_uyu : null,
          },
        }))
        .catch(error => {
          console.error('[mp_payment] no se pudo anotar el incidente', { reason: incident, error: error?.name || 'Error' });
        }));
    };
    const ignore = async (reason, incident = null, order = null) => {
      if (incident) await report(incident, order);
      return { result: 'ignored', reason };
    };

    // Validate ownership/identity — live_mode es solo diagnóstico, nunca gate
    // (un pago contra nuestro MP_COLLECTOR_ID configurado, con importe,
    // external_reference y merchant_order coincidentes, es nuestro sin
    // importar cómo Mercado Pago clasificó el modo de la transacción).
    if (payment.collector_id !== config.mpCollectorId) return ignore('collector');
    if (payment.currency_id !== 'UYU')                 return ignore('currency', INCIDENT.CURRENCY);

    // Find order by external_reference
    const publicCode = payment.external_reference;
    if (!publicCode || typeof publicCode !== 'string') return ignore('no_reference');

    const order = await db
      .prepare(
        'SELECT id,public_code,status,cancelled_at,payment_status,buyer_name,buyer_phone,buyer_email,delivery_type,' +
        'address,locality,department,requested_delivery_date,requested_delivery_from,' +
        'requested_delivery_to,delivery_notes,products_total_uyu,pickup_discount_uyu,' +
        'shipping_cost_uyu,payable_total_uyu,currency,payment_preference_id,' +
        'payment_id,paid_at,ga_client_id,ga_session_id,' +
        'premio_code,premio_discount_uyu,premio_transfer_discount_uyu ' +
        'FROM orders WHERE public_code=?'
      )
      .bind(publicCode)
      .first();
    if (!order) return ignore('order_missing', INCIDENT.ORDER_MISSING);

    // Validate exact amount
    if (Number(payment.transaction_amount) !== order.payable_total_uyu) return ignore('amount', INCIDENT.AMOUNT, order);

    // Validate via merchant order if available
    if (payment.order_id) {
      const moResult = await mpClient.getMerchantOrder(payment.order_id, accessToken);
      if (!moResult.ok) return { result: 'retry', reason: 'mp_merchant_order_unavailable' };

      const prefId = order.payment_preference_id;
      if (prefId && !prefId.startsWith('creating:') && moResult.preference_id !== prefId) {
        return ignore('preference', INCIDENT.PREFERENCE, order);
      }

      if (moResult.external_reference && moResult.external_reference !== publicCode) {
        return ignore('merchant_order_reference', INCIDENT.REFERENCE, order);
      }

      const pidStr = String(paymentId);
      const inPayments = moResult.payments.some(
        p => String(p.id) === pidStr || p.id === Number(paymentId)
      );
      if (!inPayments) return ignore('not_in_merchant_order', INCIDENT.NOT_IN_MERCHANT_ORDER, order);
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
    if (!normalized) return ignore('status');

    // Segundo cobro sobre un pedido que ya estaba pagado (por otro pago de
    // Mercado Pago o por transferencia): el pedido no cambia, pero hay plata
    // de más para devolver y alguien tiene que enterarse.
    const duplicate = normalized === 'approved' && order.payment_status === 'approved' &&
      String(order.payment_id ?? '') !== String(payment.id);
    const firstApproval = normalized === 'approved' && order.payment_status !== 'approved';

    const now = getNow();
    try {
      if (normalized === 'approved')   await applyApproved(db, order, payment, now, config.isProduction);
      else if (normalized === 'pending')   await applyPending(db, order, payment, now);
      else if (normalized === 'rejected')  await applyRejected(db, order, payment, now);
      else if (normalized === 'cancelled') await applyCancelled(db, order, payment, now);
      else if (normalized === 'refunded')  await applyRefunded(db, order, payment, now);
    } catch {
      return { result: 'error', reason: 'db_write' };
    }

    if (duplicate) await report(INCIDENT.DUPLICATE, order);
    if (normalized === 'refunded' && order.payment_status !== 'refunded') await report(INCIDENT.REFUNDED, order);

    // Rastro de que el aviso original no llegó y el pago entró por la
    // conciliación. Best effort: no cambia el resultado.
    if (source === 'conciliacion' && firstApproval) {
      try {
        await db.prepare(
          "INSERT OR IGNORE INTO order_events (id,order_id,event_type,payload_json,created_at) VALUES (?,?,'payment_reconciled',?,?)"
        ).bind(`reconciled:${payment.id}`, order.id, JSON.stringify({ payment_id: String(payment.id) }), now.toISOString()).run();
      } catch { /* el pago ya quedó aplicado */ }
    }

    // La notificación interna nunca forma parte de la confirmación del pago:
    // primero D1 queda en paid/approved y después se envía en segundo plano.
    // Un fallo de Resend se registra en order_events, pero Mercado Pago recibe
    // 200 para no degradar una venta ya validada.
    if (normalized === 'approved' && config.isProduction) {
      const notification = Promise.all([
        Promise.resolve(saleNotifier({ db, env, order, payment, now })),
        Promise.resolve(orderEmails.sendPaidCustomer({
          db,
          env,
          order,
          payment: { method: 'mercado_pago', total_uyu: order.payable_total_uyu },
          now,
        })),
        Promise.resolve(purchaseAnalytics.sendPurchase({
          db,
          env,
          order: {
            ...order,
            payment_id: String(payment.id),
            paid_at: approvalDate(payment, now),
          },
          now,
        })),
      ]).catch(error => {
        console.error('[mp_webhook] falló la tarea de notificación', {
          order_id: order.id,
          error: error?.name || 'Error',
        });
      });

      await background(notification);
    }

    // Meta (API de conversiones): sólo después de que D1 quedó en approved, y
    // fuera de la respuesta a Mercado Pago. El envío decide solo si corre
    // (flag META_TRACKING_ENABLED + consentimiento del comprador) y es
    // idempotente por pedido, así que un webhook repetido no duplica la compra.
    if (normalized === 'approved') {
      const meta = Promise.resolve()
        .then(() => metaPurchase.sendPurchase({ db, env, orderId: order.id, now }))
        .catch(error => {
          console.error('[mp_webhook] falló el envío de la compra a Meta', {
            order_id: order.id,
            error: error?.name || 'Error',
          });
        });
      await background(meta);
    }

    return { result: 'applied', normalized };
  };
}

export function createMpWebhookHandler(deps = {}) {
  const processPayment = createPaymentProcessor(deps);
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

    const outcome = await processPayment({ context, env, config, db, accessToken, paymentId: queryDataId, source: 'webhook' });
    if (outcome.result === 'retry') return noContent(503);
    if (outcome.result === 'error') return json({ error: 'Error temporal.' }, 500);
    return json({ ok: true });
  };
}
