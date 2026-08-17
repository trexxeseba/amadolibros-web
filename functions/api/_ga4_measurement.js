const GA4_ENDPOINT = 'https://www.google-analytics.com/mp/collect';
const REQUEST_TIMEOUT_MS = 5000;
const CLAIM_STALE_MS = 5 * 60 * 1000;
const DEFAULT_BATCH_LIMIT = 20;
const MAX_BATCH_LIMIT = 50;

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseState(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function analyticsConfig(env) {
  const measurementId = cleanString(env?.GA4_MEASUREMENT_ID);
  const apiSecret = cleanString(env?.GA4_API_SECRET);
  if (!/^G-[A-Z0-9]{6,20}$/.test(measurementId) || !apiSecret) return null;
  return { measurementId, apiSecret };
}

function positiveMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 100) / 100
    : 0;
}

function validClientId(value) {
  const clientId = cleanString(value);
  return /^\d{1,20}\.\d{1,20}$/.test(clientId) ? clientId : '';
}

function validSessionId(value) {
  const sessionId = Number(value);
  return Number.isSafeInteger(sessionId) && sessionId > 0 ? sessionId : null;
}

async function fallbackClientId(orderId) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`amado-order:${cleanString(orderId)}`),
  );
  const view = new DataView(digest);
  return `${view.getUint32(0)}.${view.getUint32(4)}`;
}

function eventTimestampMicros(paidAt, now) {
  const timestamp = Date.parse(paidAt || '');
  const age = now.getTime() - timestamp;
  if (!Number.isFinite(timestamp) || age < 0 || age > 72 * 60 * 60 * 1000) return undefined;
  return String(timestamp * 1000);
}

function ga4Items(items) {
  return items.map(item => ({
    item_id: cleanString(item.product_id).slice(0, 100),
    item_name: cleanString(item.title).slice(0, 200) || 'Libro',
    item_brand: 'Amado Libros',
    item_category: 'Libros',
    price: positiveMoney(item.unit_price_uyu),
    quantity: Math.max(1, Math.floor(Number(item.quantity) || 1)),
  })).filter(item => item.item_id && item.price > 0);
}

export async function buildGa4PurchasePayload({ order, items, now = new Date() }) {
  const normalizedItems = ga4Items(items);
  if (normalizedItems.length === 0) throw new Error('GA4_ITEMS_UNAVAILABLE');

  const clientId = validClientId(order.ga_client_id) || await fallbackClientId(order.id);
  const sessionId = validSessionId(order.ga_session_id);
  const shipping = positiveMoney(order.shipping_cost_uyu);
  const value = Math.max(0, positiveMoney(order.payable_total_uyu) - shipping);
  const params = {
    transaction_id: cleanString(order.public_code).slice(0, 100),
    currency: 'UYU',
    value,
    shipping,
    payment_type: 'mercado_pago',
    engagement_time_msec: 1,
    items: normalizedItems,
  };
  if (!params.transaction_id) throw new Error('GA4_TRANSACTION_ID_UNAVAILABLE');
  if (sessionId !== null) params.session_id = sessionId;

  const payload = {
    client_id: clientId,
    events: [{ name: 'purchase', params }],
  };
  const timestampMicros = eventTimestampMicros(order.paid_at, now);
  if (timestampMicros) payload.timestamp_micros = timestampMicros;
  return payload;
}

async function readItems(db, orderId) {
  const result = await db.prepare(
    'SELECT product_id,title,quantity,unit_price_uyu,line_total_uyu ' +
    'FROM order_items WHERE order_id=? ORDER BY created_at,id'
  ).bind(orderId).all();
  return Array.isArray(result?.results) ? result.results : [];
}

async function claim(db, eventId, now) {
  const row = await db.prepare(
    'SELECT payload_json FROM order_events WHERE id=? AND event_type=?'
  ).bind(eventId, 'ga4_purchase').first();
  const state = parseState(row?.payload_json);
  if (!state) return { ok: false, reason: 'outbox_missing' };
  if (state.status === 'sent') return { ok: false, reason: 'already_sent' };

  const attemptedAt = Date.parse(state.attempted_at || '');
  if (state.status === 'sending' && Number.isFinite(attemptedAt) &&
      now.getTime() - attemptedAt < CLAIM_STALE_MS) {
    return { ok: false, reason: 'in_progress' };
  }

  const attempt = Number.isInteger(state.attempt) && state.attempt > 0
    ? state.attempt + 1
    : 1;
  const next = JSON.stringify({
    ...state,
    status: 'sending',
    attempt,
    attempted_at: now.toISOString(),
  });
  const updated = await db.prepare(
    'UPDATE order_events SET payload_json=? WHERE id=? AND payload_json=?'
  ).bind(next, eventId, row.payload_json).run();
  return Number(updated?.meta?.changes) > 0
    ? { ok: true, previous: next, attempt }
    : { ok: false, reason: 'claim_lost' };
}

async function updateClaim(db, eventId, previous, state) {
  await db.prepare(
    'UPDATE order_events SET payload_json=? WHERE id=? AND payload_json=?'
  ).bind(JSON.stringify(state), eventId, previous).run();
}

async function postPurchase(config, payload, fetchFn, timeoutMs) {
  const endpoint = new URL(GA4_ENDPOINT);
  endpoint.searchParams.set('measurement_id', config.measurementId);
  endpoint.searchParams.set('api_secret', config.apiSecret);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(endpoint.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return response.ok
      ? { ok: true, status: response.status }
      : { ok: false, code: `GA4_HTTP_${response.status}` };
  } catch (error) {
    return {
      ok: false,
      code: error?.name === 'AbortError' ? 'GA4_TIMEOUT' : 'GA4_NETWORK_ERROR',
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function sendGa4Purchase({
  db,
  env,
  order,
  now = new Date(),
  fetchFn = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  if (!db || !order?.id) return { ok: false, skipped: true, reason: 'order_unavailable' };
  const config = analyticsConfig(env);
  if (!config) return { ok: false, skipped: true, reason: 'config_missing' };

  const eventId = `ga4-purchase:${order.id}`;
  const claimed = await claim(db, eventId, now);
  if (!claimed.ok) return { ok: true, skipped: true, reason: claimed.reason };

  try {
    const items = await readItems(db, order.id);
    const payload = await buildGa4PurchasePayload({ order, items, now });
    const sent = await postPurchase(config, payload, fetchFn, timeoutMs);
    if (!sent.ok) {
      await updateClaim(db, eventId, claimed.previous, {
        status: 'failed',
        attempt: claimed.attempt,
        attempted_at: now.toISOString(),
        code: sent.code,
        transaction_id: order.public_code,
      });
      return { ok: false, retryable: true, code: sent.code };
    }

    await updateClaim(db, eventId, claimed.previous, {
      status: 'sent',
      attempt: claimed.attempt,
      sent_at: now.toISOString(),
      http_status: sent.status,
      transaction_id: order.public_code,
    });
    return { ok: true, transactionId: order.public_code };
  } catch (error) {
    const code = cleanString(error?.message).slice(0, 80) || 'GA4_UNEXPECTED_ERROR';
    await updateClaim(db, eventId, claimed.previous, {
      status: 'failed',
      attempt: claimed.attempt,
      attempted_at: now.toISOString(),
      code,
      transaction_id: order.public_code,
    });
    return { ok: false, retryable: true, code };
  }
}

export async function processPendingGa4Purchases(env, {
  limit = DEFAULT_BATCH_LIMIT,
  now = new Date(),
  fetchFn = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const db = env?.ORDERS_DB;
  if (!db || !analyticsConfig(env)) {
    return { status: 'skipped', reason: 'config_missing', processed: 0 };
  }
  const safeLimit = Math.min(MAX_BATCH_LIMIT, Math.max(1, Math.floor(Number(limit) || DEFAULT_BATCH_LIMIT)));
  const result = await db.prepare(
    "SELECT e.id AS event_id,e.payload_json,o.id,o.public_code,o.ga_client_id,o.ga_session_id," +
    "o.products_total_uyu,o.pickup_discount_uyu,o.shipping_cost_uyu,o.payable_total_uyu," +
    "o.currency,o.payment_id,o.paid_at " +
    "FROM order_events e JOIN orders o ON o.id=e.order_id " +
    "WHERE e.event_type='ga4_purchase' AND o.payment_status='approved' " +
    "AND COALESCE(json_extract(e.payload_json,'$.status'),'pending')!='sent' " +
    'ORDER BY e.created_at LIMIT ?'
  ).bind(safeLimit).all();
  const orders = Array.isArray(result?.results) ? result.results : [];
  const summary = { status: 'completed', processed: 0, sent: 0, skipped: 0, failed: 0 };

  for (const order of orders) {
    const outcome = await sendGa4Purchase({ db, env, order, now, fetchFn, timeoutMs });
    summary.processed += 1;
    if (outcome.ok && !outcome.skipped) summary.sent += 1;
    else if (outcome.skipped) summary.skipped += 1;
    else summary.failed += 1;
  }
  return summary;
}
