import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  buildGa4PurchasePayload,
  processPendingGa4Purchases,
  sendGa4Purchase,
} from '../_ga4_measurement.js';

const NOW = new Date('2026-08-16T23:00:00.000Z');
const ENV = {
  GA4_MEASUREMENT_ID: 'G-SDX45VEPP3',
  GA4_API_SECRET: 'secret-value-never-log',
};

function createD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE orders (
      id TEXT PRIMARY KEY,
      public_code TEXT NOT NULL,
      payment_status TEXT NOT NULL,
      products_total_uyu INTEGER NOT NULL,
      pickup_discount_uyu INTEGER NOT NULL,
      shipping_cost_uyu INTEGER NOT NULL,
      payable_total_uyu INTEGER NOT NULL,
      currency TEXT NOT NULL,
      payment_id TEXT,
      paid_at TEXT,
      ga_client_id TEXT,
      ga_session_id INTEGER
    );
    CREATE TABLE order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      title TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price_uyu INTEGER NOT NULL,
      line_total_uyu INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE order_events (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
  sqlite.prepare(
    'INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    'order-1', 'AL-260816-TEST', 'approved', 1600, 0, 250, 1850, 'UYU', '123',
    '2026-08-16T22:59:00.000Z', '123456789.987654321', 1786921140,
  );
  sqlite.prepare('INSERT INTO order_items VALUES (?,?,?,?,?,?,?,?)')
    .run('item-1', 'order-1', 'MLU123', 'Libro de prueba', 2, 800, 1600, NOW.toISOString());
  sqlite.prepare('INSERT INTO order_events VALUES (?,?,?,?,?)').run(
    'ga4-purchase:order-1',
    'order-1',
    'ga4_purchase',
    JSON.stringify({ status: 'pending', transaction_id: 'AL-260816-TEST' }),
    NOW.toISOString(),
  );

  return {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...args) {
          return {
            async first() { return statement.get(...args) || null; },
            async all() { return { results: statement.all(...args) }; },
            async run() {
              const result = statement.run(...args);
              return { success: true, meta: { changes: Number(result.changes) } };
            },
          };
        },
      };
    },
  };
}

function order(patch = {}) {
  return {
    id: 'order-1',
    public_code: 'AL-260816-TEST',
    products_total_uyu: 1600,
    pickup_discount_uyu: 0,
    shipping_cost_uyu: 250,
    payable_total_uyu: 1850,
    currency: 'UYU',
    payment_id: '123',
    paid_at: '2026-08-16T22:59:00.000Z',
    ga_client_id: '123456789.987654321',
    ga_session_id: 1786921140,
    ...patch,
  };
}

test('ga4-mp-1: construye purchase UYU sin PII y con atribución de sesión', async () => {
  const payload = await buildGa4PurchasePayload({
    order: order(),
    items: [{ product_id: 'MLU123', title: 'Libro', quantity: 2, unit_price_uyu: 800 }],
    now: NOW,
  });
  assert.equal(payload.client_id, '123456789.987654321');
  assert.equal(payload.timestamp_micros, '1786921140000000');
  assert.equal(payload.events[0].name, 'purchase');
  assert.deepEqual(payload.events[0].params, {
    transaction_id: 'AL-260816-TEST',
    currency: 'UYU',
    value: 1600,
    shipping: 250,
    payment_type: 'mercado_pago',
    engagement_time_msec: 1,
    items: [{
      item_id: 'MLU123',
      item_name: 'Libro',
      item_brand: 'Amado Libros',
      item_category: 'Libros',
      price: 800,
      quantity: 2,
    }],
    session_id: 1786921140,
  });
  assert.equal(JSON.stringify(payload).includes('ana@example.com'), false);
});

test('ga4-mp-2: envía una sola vez y marca el outbox como sent', async () => {
  const db = createD1();
  const requests = [];
  const fetchFn = async (url, options) => {
    requests.push({ url, options });
    return new Response(null, { status: 204 });
  };

  const first = await sendGa4Purchase({ db, env: ENV, order: order(), now: NOW, fetchFn });
  const duplicate = await sendGa4Purchase({ db, env: ENV, order: order(), now: NOW, fetchFn });
  assert.equal(first.ok, true);
  assert.equal(duplicate.reason, 'already_sent');
  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(url.origin + url.pathname, 'https://www.google-analytics.com/mp/collect');
  assert.equal(url.searchParams.get('measurement_id'), 'G-SDX45VEPP3');
  assert.equal(url.searchParams.get('api_secret'), ENV.GA4_API_SECRET);
  assert.equal(requests[0].options.body.includes(ENV.GA4_API_SECRET), false);
  const state = JSON.parse(db.sqlite.prepare(
    "SELECT payload_json FROM order_events WHERE id='ga4-purchase:order-1'"
  ).get().payload_json);
  assert.equal(state.status, 'sent');
  assert.equal(state.transaction_id, 'AL-260816-TEST');
});

test('ga4-mp-3: una falla queda reintentable y el cron la recupera', async () => {
  const db = createD1();
  let attempts = 0;
  const fetchFn = async () => {
    attempts += 1;
    return new Response(null, { status: attempts === 1 ? 503 : 204 });
  };
  const failed = await sendGa4Purchase({ db, env: ENV, order: order(), now: NOW, fetchFn });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'GA4_HTTP_503');

  const later = new Date(NOW.getTime() + 6 * 60 * 1000);
  const summary = await processPendingGa4Purchases(
    { ...ENV, ORDERS_DB: db },
    { now: later, fetchFn },
  );
  assert.deepEqual(summary, { status: 'completed', processed: 1, sent: 1, skipped: 0, failed: 0 });
  assert.equal(attempts, 2);
});

test('ga4-mp-4: sin secret no consume el outbox ni llama a Google', async () => {
  const db = createD1();
  let calls = 0;
  const result = await sendGa4Purchase({
    db,
    env: { GA4_MEASUREMENT_ID: ENV.GA4_MEASUREMENT_ID },
    order: order(),
    now: NOW,
    fetchFn: async () => { calls += 1; return new Response(null, { status: 204 }); },
  });
  assert.equal(result.reason, 'config_missing');
  assert.equal(calls, 0);
  const state = JSON.parse(db.sqlite.prepare(
    "SELECT payload_json FROM order_events WHERE id='ga4-purchase:order-1'"
  ).get().payload_json);
  assert.equal(state.status, 'pending');
});

test('ga4-mp-5: genera client_id anónimo de respaldo y no falsea fechas de más de 72 h', async () => {
  const payload = await buildGa4PurchasePayload({
    order: order({ ga_client_id: null, ga_session_id: null, paid_at: '2026-06-05T12:00:00.000Z' }),
    items: [{ product_id: 'MLU123', title: 'Libro', quantity: 1, unit_price_uyu: 800 }],
    now: NOW,
  });
  assert.match(payload.client_id, /^\d+\.\d+$/);
  assert.equal(Object.hasOwn(payload, 'timestamp_micros'), false);
  assert.equal(Object.hasOwn(payload.events[0].params, 'session_id'), false);
});
