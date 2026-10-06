/**
 * functions/_shared/purchase-tracking.js
 *
 * La compra se informa desde el pago confirmado, no desde la página de
 * retorno: el webhook de Mercado Pago (pago aprobado y validado) o el botón
 * «Transferencia recibida» del panel.
 *
 * Idempotencia: cada envío tiene una fila propia en order_events, creada con
 * INSERT OR IGNORE y con id fijo por pedido (`meta-purchase:<order.id>`). Un
 * pedido no puede mandar dos compras aunque el webhook llegue repetido o el
 * botón se apriete dos veces: la segunda vez encuentra la fila en `sent`.
 *
 * Consentimiento: Meta sólo recibe la compra si el comprador aceptó las
 * cookies de marketing. Esa aceptación queda registrada en la fila
 * `meta-attr:<order.id>`, que escribe /api/tracking/meta al iniciar el
 * checkout, sólo cuando el navegador ya tiene el consentimiento. Si después
 * lo retira, la fila pasa a `revoked` y la compra ya no sale.
 *
 * Orden de llegada: si el webhook llega antes que la atribución, la compra
 * queda en espera (no_consent) y se recupera de dos formas: al llegar la
 * atribución, y en el cron de worker-sync (processPendingMetaPurchases), que
 * además reintenta los envíos fallidos hasta MAX_ATTEMPTS.
 */

import {
  buildCustomData,
  buildServerEvent,
  buildUserData,
  isProductionEnv,
  metaConfig,
  postMetaEvents,
} from './meta-capi.js';
import { sendGa4Purchase } from '../api/_ga4_measurement.js';

const CLAIM_STALE_MS = 5 * 60 * 1000;
const ATTRIBUTION_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_EVENT_AGE_S = 7 * 24 * 60 * 60;
export const MAX_ATTEMPTS = 8;
const DEFAULT_BATCH_LIMIT = 20;

export const META_ATTRIBUTION_EVENT = 'meta_attribution';
export const META_PURCHASE_EVENT = 'meta_purchase';

export function metaAttributionId(orderId) { return `meta-attr:${orderId}`; }
export function metaPurchaseId(orderId) { return `meta-purchase:${orderId}`; }

/** event_id de la compra: el mismo que arma /pedido para el Pixel. */
export function purchaseEventId(publicCode) {
  return `purchase_${String(publicCode || '').trim()}`;
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : 0;
}

/**
 * Valor de la compra, sin envío (igual que el purchase de GA4). Una
 * transferencia cobra el total con descuento, que queda en paid_amount_uyu.
 */
export function purchaseValue(order) {
  const shipping = money(order?.shipping_cost_uyu);
  const paid = order?.payment_provider === 'bank_transfer' && Number(order?.paid_amount_uyu) > 0
    ? money(order.paid_amount_uyu)
    : money(order?.payable_total_uyu);
  return Math.max(0, Math.round((paid - shipping) * 100) / 100);
}

// ─── Atribución (consentimiento + cookies de Meta) ───────────────────────────

/**
 * Guarda, para un pedido recién creado, que el comprador aceptó las cookies
 * de marketing y sus cookies _fbp/_fbc. Sólo pedidos de las últimas horas;
 * la primera escritura gana.
 */
export async function recordMetaAttribution({ db, publicCode, fbp, fbc, userAgent, now = new Date() }) {
  if (!db || !/^AL-[0-9]{6}-[A-Z0-9]{6}$/.test(String(publicCode || ''))) return { ok: false, reason: 'invalid' };
  const order = await db.prepare('SELECT id, created_at FROM orders WHERE public_code=?').bind(publicCode).first();
  if (!order) return { ok: false, reason: 'order_not_found' };
  const createdAt = Date.parse(order.created_at || '');
  if (!Number.isFinite(createdAt) || now.getTime() - createdAt > ATTRIBUTION_MAX_AGE_MS) {
    return { ok: false, reason: 'order_too_old' };
  }
  await db.prepare(
    'INSERT OR IGNORE INTO order_events (id,order_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?)'
  ).bind(
    metaAttributionId(order.id),
    order.id,
    META_ATTRIBUTION_EVENT,
    JSON.stringify({
      consent: 'granted',
      fbp: fbp || null,
      fbc: fbc || null,
      user_agent: String(userAgent || '').slice(0, 500) || null,
    }),
    now.toISOString(),
  ).run();
  return { ok: true, orderId: order.id };
}

/**
 * El comprador retiró el consentimiento: sus pedidos recientes dejan de
 * poder mandar la compra a Meta. Lo ya enviado no se puede deshacer.
 */
export async function revokeMetaAttribution({ db, publicCodes, now = new Date() }) {
  if (!db || !Array.isArray(publicCodes)) return { ok: false, revoked: 0 };
  const codes = publicCodes.filter(code => /^AL-[0-9]{6}-[A-Z0-9]{6}$/.test(String(code))).slice(0, 20);
  let revoked = 0;
  for (const code of codes) {
    const order = await db.prepare('SELECT id FROM orders WHERE public_code=?').bind(code).first();
    if (!order) continue;
    const payload = JSON.stringify({ consent: 'revoked', revoked_at: now.toISOString() });
    // Si no había fila (el checkout no llegó a registrarla), se crea revocada
    // para que una atribución tardía no la vuelva a habilitar.
    await db.prepare(
      'INSERT OR IGNORE INTO order_events (id,order_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?)'
    ).bind(metaAttributionId(order.id), order.id, META_ATTRIBUTION_EVENT, payload, now.toISOString()).run();
    const updated = await db.prepare(
      'UPDATE order_events SET payload_json=? WHERE id=? AND event_type=?'
    ).bind(payload, metaAttributionId(order.id), META_ATTRIBUTION_EVENT).run();
    if (Number(updated?.meta?.changes) > 0) revoked += 1;
  }
  return { ok: true, revoked };
}

async function readAttribution(db, orderId) {
  const row = await db.prepare(
    'SELECT payload_json FROM order_events WHERE id=? AND event_type=?'
  ).bind(metaAttributionId(orderId), META_ATTRIBUTION_EVENT).first();
  const state = parseJson(row?.payload_json);
  return state?.consent === 'granted' ? state : null;
}

// ─── Outbox con reclamo, igual que el de GA4 ─────────────────────────────────

async function claimOutbox(db, eventId, orderId, eventType, now) {
  await db.prepare(
    'INSERT OR IGNORE INTO order_events (id,order_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?)'
  ).bind(eventId, orderId, eventType, JSON.stringify({ status: 'pending' }), now.toISOString()).run();

  const row = await db.prepare('SELECT payload_json FROM order_events WHERE id=?').bind(eventId).first();
  const state = parseJson(row?.payload_json);
  if (!state) return { ok: false, reason: 'outbox_missing' };
  if (state.status === 'sent') return { ok: false, reason: 'already_sent' };
  if (state.status === 'failed' && Number(state.attempt) >= MAX_ATTEMPTS) return { ok: false, reason: 'max_attempts' };
  const attemptedAt = Date.parse(state.attempted_at || '');
  if (state.status === 'sending' && Number.isFinite(attemptedAt) &&
      now.getTime() - attemptedAt < CLAIM_STALE_MS) {
    return { ok: false, reason: 'in_progress' };
  }
  const attempt = Number.isInteger(state.attempt) && state.attempt > 0 ? state.attempt + 1 : 1;
  const next = JSON.stringify({ ...state, status: 'sending', attempt, attempted_at: now.toISOString() });
  const updated = await db.prepare(
    'UPDATE order_events SET payload_json=? WHERE id=? AND payload_json=?'
  ).bind(next, eventId, row.payload_json).run();
  return Number(updated?.meta?.changes) > 0
    ? { ok: true, previous: next, attempt }
    : { ok: false, reason: 'claim_lost' };
}

async function settleOutbox(db, eventId, previous, state) {
  await db.prepare('UPDATE order_events SET payload_json=? WHERE id=? AND payload_json=?')
    .bind(JSON.stringify(state), eventId, previous).run();
}

async function readOrder(db, orderId) {
  return db.prepare(
    'SELECT id,public_code,payment_status,payment_provider,buyer_email,buyer_phone,' +
    'products_total_uyu,pickup_discount_uyu,shipping_cost_uyu,payable_total_uyu,paid_amount_uyu,' +
    'paid_at,ga_client_id,ga_session_id FROM orders WHERE id=?'
  ).bind(orderId).first();
}

async function readItems(db, orderId) {
  const result = await db.prepare(
    'SELECT product_id,title,quantity,unit_price_uyu FROM order_items WHERE order_id=? ORDER BY created_at,id'
  ).bind(orderId).all();
  return Array.isArray(result?.results) ? result.results : [];
}

// ─── Purchase a Meta ─────────────────────────────────────────────────────────

export async function buildMetaPurchaseEvent({ order, items, attribution, canonicalOrigin, now = new Date() }) {
  const customData = buildCustomData({
    items: items.map(item => ({ id: item.product_id, quantity: item.quantity, price: item.unit_price_uyu })),
    value: purchaseValue(order),
  });
  if (!customData) throw new Error('META_ITEMS_UNAVAILABLE');
  customData.order_id = order.public_code;

  const nowS = Math.floor(now.getTime() / 1000);
  const paidS = Math.floor(Date.parse(order.paid_at || '') / 1000);
  const eventTime = Number.isFinite(paidS) && paidS <= nowS && nowS - paidS < MAX_EVENT_AGE_S ? paidS : nowS;

  return buildServerEvent({
    eventName: 'Purchase',
    eventId: purchaseEventId(order.public_code),
    eventTime,
    eventSourceUrl: `${canonicalOrigin || 'https://www.amadolibros.com'}/pedido/`,
    userData: await buildUserData({
      email: order.buyer_email,
      phone: order.buyer_phone,
      fbp: attribution?.fbp,
      fbc: attribution?.fbc,
      userAgent: attribution?.user_agent,
    }),
    customData,
  });
}

export async function sendMetaPurchase({ db, env, orderId, now = new Date(), fetchFn = globalThis.fetch }) {
  const config = metaConfig(env);
  if (!config) return { ok: true, skipped: true, reason: 'disabled' };
  if (!db || !orderId) return { ok: false, skipped: true, reason: 'order_unavailable' };

  const order = await readOrder(db, orderId);
  if (!order || order.payment_status !== 'approved') return { ok: true, skipped: true, reason: 'not_paid' };
  const attribution = await readAttribution(db, order.id);
  if (!attribution) return { ok: true, skipped: true, reason: 'no_consent' };

  const eventId = metaPurchaseId(order.id);
  const claimed = await claimOutbox(db, eventId, order.id, META_PURCHASE_EVENT, now);
  if (!claimed.ok) return { ok: true, skipped: true, reason: claimed.reason };

  try {
    const items = await readItems(db, order.id);
    const event = await buildMetaPurchaseEvent({
      order, items, attribution, canonicalOrigin: env?.CANONICAL_ORIGIN, now,
    });
    const sent = await postMetaEvents(config, [event], { fetchFn });
    await settleOutbox(db, eventId, claimed.previous, sent.ok
      ? { status: 'sent', attempt: claimed.attempt, sent_at: now.toISOString(), event_id: event.event_id }
      : { status: 'failed', attempt: claimed.attempt, attempted_at: now.toISOString(), code: sent.code });
    return sent.ok ? { ok: true, eventId: event.event_id } : { ok: false, retryable: true, code: sent.code };
  } catch (error) {
    const code = String(error?.message || 'META_UNEXPECTED_ERROR').slice(0, 80);
    await settleOutbox(db, eventId, claimed.previous, {
      status: 'failed', attempt: claimed.attempt, attempted_at: now.toISOString(), code,
    });
    return { ok: false, retryable: true, code };
  }
}

// ─── Transferencia confirmada en el panel ────────────────────────────────────

/**
 * GA4 server-side de una transferencia: sólo en producción y con
 * GA4_TRANSFER_PURCHASE_ENABLED. Independiente de Meta. Un Preview nunca
 * manda compras al GA4 productivo aunque tenga sus credenciales.
 */
export function ga4TransferEnabled(env) {
  return isProductionEnv(env) && String(env?.GA4_TRANSFER_PURCHASE_ENABLED || '').trim() === 'true';
}

/**
 * Lo que se dispara cuando el panel marca «Transferencia recibida»: GA4
 * (Measurement Protocol, mismo outbox que usa Mercado Pago) y Meta, cada uno
 * con su propio interruptor.
 */
export async function trackTransferPurchase({ db, env, orderId, now = new Date(), fetchFn = globalThis.fetch }) {
  const order = db ? await readOrder(db, orderId) : null;
  if (!order || order.payment_status !== 'approved' || order.payment_provider !== 'bank_transfer') {
    return { ok: true, skipped: true, reason: 'not_paid_by_transfer' };
  }

  let ga4 = { ok: true, skipped: true, reason: 'disabled' };
  if (ga4TransferEnabled(env)) {
    await db.prepare(
      "INSERT OR IGNORE INTO order_events (id,order_id,event_type,payload_json,created_at) VALUES (?,?,'ga4_purchase',?,?)"
    ).bind(
      `ga4-purchase:${order.id}`,
      order.id,
      JSON.stringify({ status: 'pending', transaction_id: order.public_code, queued_at: now.toISOString() }),
      now.toISOString(),
    ).run();
    ga4 = await sendGa4Purchase({ db, env, order, now, fetchFn });
  }

  const meta = await sendMetaPurchase({ db, env, orderId: order.id, now, fetchFn });
  return { ok: true, ga4, meta };
}

/**
 * Cron (worker-sync): compras pagadas en los últimos 7 días, con
 * consentimiento, que todavía no llegaron a Meta — porque el webhook llegó
 * antes que la atribución o porque el envío falló. Tope de MAX_ATTEMPTS.
 */
export async function processPendingMetaPurchases(env, {
  limit = DEFAULT_BATCH_LIMIT,
  now = new Date(),
  fetchFn = globalThis.fetch,
} = {}) {
  const db = env?.ORDERS_DB;
  if (!db || !metaConfig(env)) return { status: 'skipped', reason: 'disabled', processed: 0 };
  const since = new Date(now.getTime() - MAX_EVENT_AGE_S * 1000).toISOString();
  const safeLimit = Math.min(50, Math.max(1, Math.floor(Number(limit) || DEFAULT_BATCH_LIMIT)));
  const result = await db.prepare(
    "SELECT o.id FROM orders o JOIN order_events a ON a.id = 'meta-attr:' || o.id " +
    "WHERE o.payment_status='approved' AND o.paid_at >= ? " +
    "AND json_extract(a.payload_json,'$.consent')='granted' " +
    "AND NOT EXISTS (SELECT 1 FROM order_events p WHERE p.id = 'meta-purchase:' || o.id " +
    "AND (json_extract(p.payload_json,'$.status')='sent' OR " +
    "(json_extract(p.payload_json,'$.status')='failed' AND json_extract(p.payload_json,'$.attempt') >= ?))) " +
    'ORDER BY o.paid_at LIMIT ?'
  ).bind(since, MAX_ATTEMPTS, safeLimit).all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  const summary = { status: 'completed', processed: 0, sent: 0, skipped: 0, failed: 0 };
  for (const row of rows) {
    const outcome = await sendMetaPurchase({ db, env, orderId: row.id, now, fetchFn });
    summary.processed += 1;
    if (outcome.ok && !outcome.skipped) summary.sent += 1;
    else if (outcome.skipped) summary.skipped += 1;
    else summary.failed += 1;
  }
  return summary;
}
