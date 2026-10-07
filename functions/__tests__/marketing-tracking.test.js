import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import {
  buildCustomData,
  buildUserData,
  metaConfig,
  normalizeEmail,
  normalizePhone,
  postMetaEvents,
  publicTrackingConfig,
  sha256Hex,
} from '../_shared/meta-capi.js';
import {
  MAX_ATTEMPTS,
  processPendingMetaPurchases,
  purchaseEventId,
  purchaseValue,
  recordMetaAttribution,
  sendMetaPurchase,
  trackTransferPurchase,
} from '../_shared/purchase-tracking.js';
import { buildGa4PurchasePayload } from '../api/_ga4_measurement.js';
import { createTrackingConfigHandler, createTrackingMetaHandler } from '../api/_tracking_handler.js';

const NOW = new Date('2026-10-06T15:00:00.000Z');
const TOKEN = 'EAAB-secret-token-never-log';
// Preview con código de eventos de prueba: el único modo en que un entorno
// que no es producción manda algo a Meta.
const PROD_PIXEL = '555555555555555';
const PROD_TOKEN = 'EAAB-PRODUCTION-token';
const ENV_ON = {
  META_TRACKING_ENABLED: 'true',
  META_TEST_EVENT_CODE: 'TEST12345',
  // Pixel de pruebas separado: lo único que usa un Preview.
  META_TEST_PIXEL_ID: '123456789012345',
  META_TEST_CAPI_TOKEN: TOKEN,
  // Credenciales productivas cargadas por error en Preview: deben ignorarse.
  META_PIXEL_ID: PROD_PIXEL,
  META_CAPI_TOKEN: PROD_TOKEN,
  APP_ENV: 'preview',
  MP_COLLECTOR_ID: '3559407834',
  CANONICAL_ORIGIN: 'https://pr-1.amadolibros-web.pages.dev',
  GA4_MEASUREMENT_ID: 'G-SDX45VEPP3',
  GA4_API_SECRET: 'ga4-secret',
};
const HOST = 'pr-1.amadolibros-web.pages.dev';
const FBP = 'fb.1.1759700000000.1234567890';
const FBC = 'fb.1.1759700000000.IwAR0abc';

function graphFetch() {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  fn.calls = calls;
  return fn;
}

function createD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE orders (
      id TEXT PRIMARY KEY, public_code TEXT NOT NULL, status TEXT, payment_status TEXT NOT NULL,
      payment_provider TEXT, buyer_email TEXT, buyer_phone TEXT,
      products_total_uyu INTEGER, pickup_discount_uyu INTEGER, shipping_cost_uyu INTEGER,
      payable_total_uyu INTEGER, paid_amount_uyu INTEGER, currency TEXT, payment_id TEXT, paid_at TEXT,
      ga_client_id TEXT, ga_session_id INTEGER, created_at TEXT
    );
    CREATE TABLE order_items (
      id TEXT PRIMARY KEY, order_id TEXT, product_id TEXT, title TEXT, quantity INTEGER,
      unit_price_uyu INTEGER, line_total_uyu INTEGER, created_at TEXT
    );
    CREATE TABLE order_events (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT, created_at TEXT NOT NULL
    );
  `);
  const insert = (o) => sqlite.prepare(
    'INSERT INTO orders (id,public_code,status,payment_status,payment_provider,buyer_email,buyer_phone,' +
    'products_total_uyu,pickup_discount_uyu,shipping_cost_uyu,payable_total_uyu,paid_amount_uyu,currency,' +
    'paid_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(o.id, o.code, o.status, o.payment_status, o.provider ?? null, ' Ana@Example.COM ', '099 123 456',
    1600, 0, 250, 1850, o.paid ?? null, 'UYU', o.paid_at ?? '2026-10-06T14:59:00.000Z', '2026-10-06T14:50:00.000Z');
  insert({ id: 'o-mp', code: 'AL-261006-MPMPMP', status: 'paid', payment_status: 'approved', provider: 'mercado_pago', paid: 1850 });
  insert({ id: 'o-tr', code: 'AL-261006-TRTRTR', status: 'paid', payment_status: 'approved', provider: 'bank_transfer', paid: 1658 });
  insert({ id: 'o-open', code: 'AL-261006-OPENOP', status: 'open', payment_status: 'pending' });
  for (const id of ['o-mp', 'o-tr', 'o-open']) {
    sqlite.prepare('INSERT INTO order_items VALUES (?,?,?,?,?,?,?,?)')
      .run(`i-${id}`, id, 'MLU123456789', 'Libro', 2, 800, 1600, NOW.toISOString());
  }
  return {
    sqlite,
    prepare(sql) {
      const st = sqlite.prepare(sql);
      return {
        bind(...args) {
          return {
            async first() { return st.get(...args) || null; },
            async all() { return { results: st.all(...args) }; },
            async run() { return { success: true, meta: { changes: Number(st.run(...args).changes) } }; },
          };
        },
      };
    },
    async batch(stmts) { return Promise.all(stmts.map(s => s.run())); },
  };
}

function eventRow(db, id) {
  const row = db.sqlite.prepare('SELECT payload_json FROM order_events WHERE id=?').get(id);
  return row ? JSON.parse(row.payload_json) : null;
}

// ─── Flag y configuración ────────────────────────────────────────────────────

test('apagado por defecto: sin META_TRACKING_ENABLED no hay Pixel ni CAPI', () => {
  const { META_TRACKING_ENABLED, ...rest } = ENV_ON;
  assert.deepEqual(publicTrackingConfig(rest), { enabled: false });
  assert.equal(metaConfig(rest), null);
  assert.deepEqual(publicTrackingConfig({ ...ENV_ON, META_TRACKING_ENABLED: 'false' }), { enabled: false });
});

test('la configuración pública nunca expone el token', async () => {
  const res = await createTrackingConfigHandler()({ request: new Request(`https://${HOST}/api/tracking/config`), env: ENV_ON });
  const body = await res.text();
  assert.deepEqual(JSON.parse(body), { enabled: true, pixel_id: '123456789012345' });
  assert.doesNotMatch(body, /EAAB|token/i);
});

test('producción enciende Meta con el Pixel de amado; GA4 de transferencias sigue apagado; el token nunca está en el repo', () => {
  const toml = readFileSync('wrangler.toml', 'utf8');
  const production = toml.slice(toml.indexOf('[env.production.vars]'));
  assert.match(production, /META_TRACKING_ENABLED\s*=\s*"true"/);
  assert.match(production, /META_PIXEL_ID\s*=\s*"262579181286891"/);
  assert.doesNotMatch(production, /GA4_TRANSFER_PURCHASE_ENABLED/);
  assert.doesNotMatch(production, /META_TEST_/);
  assert.doesNotMatch(toml, /META_CAPI_TOKEN\s*=/);
  const worker = readFileSync('worker-sync/wrangler.toml', 'utf8');
  assert.match(worker, /META_PIXEL_ID\s*=\s*"262579181286891"/);
  assert.doesNotMatch(worker, /META_CAPI_TOKEN\s*=/);
});

// ─── Datos personales ────────────────────────────────────────────────────────

test('email y teléfono se normalizan y salen sólo como SHA-256', async () => {
  assert.equal(normalizeEmail(' Ana@Example.COM '), 'ana@example.com');
  assert.equal(normalizePhone('099 123 456'), '59899123456');
  assert.equal(normalizePhone('+598 99 123 456'), '59899123456');
  assert.equal(normalizePhone('12'), '');
  const userData = await buildUserData({ email: ' Ana@Example.COM ', phone: '099 123 456', fbp: FBP, fbc: FBC });
  assert.deepEqual(userData.em, [await sha256Hex('ana@example.com')]);
  assert.deepEqual(userData.ph, [await sha256Hex('59899123456')]);
  assert.match(userData.em[0], /^[a-f0-9]{64}$/);
  const raw = JSON.stringify(userData);
  assert.doesNotMatch(raw, /ana@example|099 ?123|59899123456/);
  assert.equal(userData.fbp, FBP);
  assert.equal(userData.client_ip_address, undefined);
});

test('custom_data: UYU, content_ids = ID de la ficha, content_type product', () => {
  const data = buildCustomData({ items: [{ id: 'mlu123456789', quantity: 2, price: 800 }, { id: 'no-es-ficha' }] });
  assert.deepEqual(data, {
    currency: 'UYU',
    value: 1600,
    content_ids: ['MLU123456789'],
    content_type: 'product',
    contents: [{ id: 'MLU123456789', quantity: 2, item_price: 800 }],
    num_items: 2,
  });
  assert.equal(buildCustomData({ items: [] }), null);
});

test('el token viaja en el cuerpo, nunca en la URL, y un error no lo devuelve', async () => {
  const fetchFn = graphFetch();
  await postMetaEvents(metaConfig(ENV_ON), [{ event_name: 'PageView' }], { fetchFn });
  assert.doesNotMatch(fetchFn.calls[0].url, /access_token|EAAB/);
  assert.equal(fetchFn.calls[0].body.access_token, TOKEN);
  const failed = await postMetaEvents(metaConfig(ENV_ON), [], { fetchFn: async () => ({ ok: false, status: 400 }) });
  assert.deepEqual(failed, { ok: false, code: 'META_HTTP_400' });
});

// ─── Endpoint del navegador → CAPI ───────────────────────────────────────────

function metaRequest(body, { origin = `https://${HOST}` } = {}) {
  return new Request(`https://${HOST}/api/tracking/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'User-Agent': 'TestUA/1.0' },
    body: JSON.stringify(body),
  });
}

const VIEW_CONTENT = {
  consent: 'granted',
  event_name: 'ViewContent',
  event_id: 'view_content_abcdef1234',
  event_source_url: `https://${HOST}/libro/MLU123456789/x`,
  items: [{ id: 'MLU123456789', quantity: 1, price: 800 }],
  value: 800,
  fbp: FBP,
};

for (const [name, eventName] of [
  ['ViewContent', 'ViewContent'], ['AddToCart', 'AddToCart'], ['InitiateCheckout', 'InitiateCheckout'],
]) {
  test(`CAPI ${name}: mismo event_id que el Pixel, UYU y content_ids`, async () => {
    const fetchFn = graphFetch();
    const res = await createTrackingMetaHandler({ fetchFn, getNow: () => NOW })({
      request: metaRequest({ ...VIEW_CONTENT, event_name: eventName, event_id: `${name.toLowerCase()}_abcdef1234` }),
      env: ENV_ON,
    });
    assert.equal(res.status, 202);
    const [event] = fetchFn.calls[0].body.data;
    assert.equal(event.event_name, eventName);
    assert.equal(event.event_id, `${name.toLowerCase()}_abcdef1234`);
    assert.equal(event.action_source, 'website');
    assert.equal(event.custom_data.currency, 'UYU');
    assert.deepEqual(event.custom_data.content_ids, ['MLU123456789']);
    assert.equal(event.custom_data.content_type, 'product');
    assert.equal(event.user_data.client_user_agent, 'TestUA/1.0');
  });
}

test('CAPI PageView sin custom_data', async () => {
  const fetchFn = graphFetch();
  await createTrackingMetaHandler({ fetchFn, getNow: () => NOW })({
    request: metaRequest({ consent: 'granted', event_name: 'PageView', event_id: 'page_view_abcdef1234', event_source_url: `https://${HOST}/` }),
    env: ENV_ON,
  });
  const [event] = fetchFn.calls[0].body.data;
  assert.equal(event.event_name, 'PageView');
  assert.equal(event.custom_data, undefined);
});

test('sin consentimiento, apagado u origen ajeno no se manda nada', async () => {
  const fetchFn = graphFetch();
  const h = createTrackingMetaHandler({ fetchFn, getNow: () => NOW });
  assert.equal((await h({ request: metaRequest({ ...VIEW_CONTENT, consent: 'denied' }), env: ENV_ON })).status, 202);
  assert.equal((await h({ request: metaRequest(VIEW_CONTENT), env: { ...ENV_ON, META_TRACKING_ENABLED: '' } })).status, 202);
  assert.equal((await h({ request: metaRequest(VIEW_CONTENT, { origin: 'https://evil.example' }), env: ENV_ON })).status, 403);
  assert.equal(fetchFn.calls.length, 0);
});

test('Purchase no se acepta desde el navegador: sólo lo manda el servidor', async () => {
  const fetchFn = graphFetch();
  const res = await createTrackingMetaHandler({ fetchFn })({
    request: metaRequest({ ...VIEW_CONTENT, event_name: 'Purchase' }), env: ENV_ON,
  });
  assert.equal(res.status, 400);
  assert.equal(fetchFn.calls.length, 0);
});

test('InitiateCheckout con public_code guarda el consentimiento ligado al pedido', async () => {
  const db = createD1();
  await createTrackingMetaHandler({ fetchFn: graphFetch(), getNow: () => NOW })({
    request: metaRequest({ ...VIEW_CONTENT, event_name: 'InitiateCheckout', event_id: 'initiate_checkout_AL-261006-OPENOP', public_code: 'AL-261006-OPENOP', fbc: FBC }),
    env: { ...ENV_ON, ORDERS_DB: db },
  });
  const attr = eventRow(db, 'meta-attr:o-open');
  assert.equal(attr.consent, 'granted');
  assert.equal(attr.fbp, FBP);
  assert.equal(attr.fbc, FBC);
});

test('la atribución no se acepta para pedidos viejos', async () => {
  const db = createD1();
  const res = await recordMetaAttribution({ db, publicCode: 'AL-261006-OPENOP', now: new Date('2026-10-07T15:00:00Z') });
  assert.equal(res.reason, 'order_too_old');
});

// ─── Purchase server-side ────────────────────────────────────────────────────

async function withConsent(db, orderId) {
  db.sqlite.prepare("INSERT INTO order_events VALUES (?,?,'meta_attribution',?,?)")
    .run(`meta-attr:${orderId}`, orderId, JSON.stringify({ consent: 'granted', fbp: FBP, fbc: FBC, user_agent: 'UA' }), NOW.toISOString());
}

test('Purchase (Mercado Pago): event_id purchase_<código>, valor sin envío, datos hasheados', async () => {
  const db = createD1();
  await withConsent(db, 'o-mp');
  const fetchFn = graphFetch();
  const out = await sendMetaPurchase({ db, env: ENV_ON, orderId: 'o-mp', now: NOW, fetchFn });
  assert.equal(out.ok, true);
  const [event] = fetchFn.calls[0].body.data;
  assert.equal(event.event_name, 'Purchase');
  assert.equal(event.event_id, 'purchase_AL-261006-MPMPMP');
  assert.equal(event.event_id, purchaseEventId('AL-261006-MPMPMP'));
  assert.equal(event.custom_data.value, 1600);
  assert.equal(event.custom_data.currency, 'UYU');
  assert.deepEqual(event.custom_data.content_ids, ['MLU123456789']);
  assert.equal(event.custom_data.order_id, 'AL-261006-MPMPMP');
  assert.match(event.user_data.em[0], /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(event), /ana@example|099 123/i);
  assert.equal(eventRow(db, 'meta-purchase:o-mp').status, 'sent');
});

test('Purchase es idempotente: el mismo pedido no manda dos compras', async () => {
  const db = createD1();
  await withConsent(db, 'o-mp');
  const fetchFn = graphFetch();
  await sendMetaPurchase({ db, env: ENV_ON, orderId: 'o-mp', now: NOW, fetchFn });
  const second = await sendMetaPurchase({ db, env: ENV_ON, orderId: 'o-mp', now: NOW, fetchFn });
  assert.equal(second.reason, 'already_sent');
  assert.equal(fetchFn.calls.length, 1);
});

test('un envío fallido se puede reintentar y sigue siendo uno solo', async () => {
  const db = createD1();
  await withConsent(db, 'o-mp');
  const failing = await sendMetaPurchase({ db, env: ENV_ON, orderId: 'o-mp', now: NOW, fetchFn: async () => ({ ok: false, status: 500 }) });
  assert.equal(failing.ok, false);
  const fetchFn = graphFetch();
  await sendMetaPurchase({ db, env: ENV_ON, orderId: 'o-mp', now: NOW, fetchFn });
  await sendMetaPurchase({ db, env: ENV_ON, orderId: 'o-mp', now: NOW, fetchFn });
  assert.equal(fetchFn.calls.length, 1);
});

test('Purchase sin consentimiento, sin pago o con el flag apagado no sale', async () => {
  const db = createD1();
  const fetchFn = graphFetch();
  assert.equal((await sendMetaPurchase({ db, env: ENV_ON, orderId: 'o-mp', now: NOW, fetchFn })).reason, 'no_consent');
  await withConsent(db, 'o-open');
  assert.equal((await sendMetaPurchase({ db, env: ENV_ON, orderId: 'o-open', now: NOW, fetchFn })).reason, 'not_paid');
  assert.equal((await sendMetaPurchase({ db, env: {}, orderId: 'o-mp', now: NOW, fetchFn })).reason, 'disabled');
  assert.equal(fetchFn.calls.length, 0);
});

test('transferencia: value = cobrado con descuento menos envío', () => {
  assert.equal(purchaseValue({ payment_provider: 'bank_transfer', paid_amount_uyu: 1658, payable_total_uyu: 1850, shipping_cost_uyu: 250 }), 1408);
  assert.equal(purchaseValue({ payment_provider: 'mercado_pago', paid_amount_uyu: 1850, payable_total_uyu: 1850, shipping_cost_uyu: 250 }), 1600);
});

const ENV_PROD = {
  ...ENV_ON,
  APP_ENV: 'production',
  META_TEST_EVENT_CODE: '',
  META_PIXEL_ID: '123456789012345',
  META_CAPI_TOKEN: TOKEN,
  GA4_TRANSFER_PURCHASE_ENABLED: 'true',
};

test('transferencia confirmada en producción: GA4 purchase y Meta Purchase, una sola vez cada uno', async () => {
  const db = createD1();
  await withConsent(db, 'o-tr');
  const fetchFn = graphFetch();
  await trackTransferPurchase({ db, env: ENV_PROD, orderId: 'o-tr', now: NOW, fetchFn });
  await trackTransferPurchase({ db, env: ENV_PROD, orderId: 'o-tr', now: NOW, fetchFn });
  const ga4 = fetchFn.calls.filter(c => c.url.includes('google-analytics.com'));
  const meta = fetchFn.calls.filter(c => c.url.includes('graph.facebook.com'));
  assert.equal(ga4.length, 1);
  assert.equal(meta.length, 1);
  const purchase = ga4[0].body.events[0];
  assert.equal(purchase.name, 'purchase');
  assert.equal(purchase.params.transaction_id, 'AL-261006-TRTRTR');
  assert.equal(purchase.params.payment_type, 'bank_transfer');
  assert.equal(purchase.params.value, 1408);
  assert.equal(purchase.params.currency, 'UYU');
  assert.equal(purchase.params.items[0].item_id, 'MLU123456789');
  assert.equal(meta[0].body.data[0].custom_data.value, 1408);
  assert.equal(meta[0].body.test_event_code, undefined);
});

test('auditoría: un Preview con credenciales productivas no manda la transferencia al GA4 productivo', async () => {
  const db = createD1();
  const fetchFn = graphFetch();
  // Mismas credenciales de GA4 que producción y el interruptor encendido,
  // pero APP_ENV=preview.
  const out = await trackTransferPurchase({
    db, env: { ...ENV_ON, GA4_TRANSFER_PURCHASE_ENABLED: 'true' }, orderId: 'o-tr', now: NOW, fetchFn,
  });
  assert.equal(out.ga4.reason, 'disabled');
  assert.equal(fetchFn.calls.filter(c => c.url.includes('google-analytics.com')).length, 0);
  assert.equal(eventRow(db, 'ga4-purchase:o-tr'), null);
});

test('auditoría: un Preview sin código de prueba no manda nada a Meta, aunque tenga el token', async () => {
  assert.equal(metaConfig({ ...ENV_ON, META_TEST_EVENT_CODE: '' }), null);
  const fetchFn = graphFetch();
  await postMetaEvents(metaConfig(ENV_ON), [{ event_name: 'PageView' }], { fetchFn });
  assert.equal(fetchFn.calls[0].body.test_event_code, 'TEST12345');
});

test('auditoría: GA4 de transferencias no depende del flag de Meta', async () => {
  const db = createD1();
  await withConsent(db, 'o-tr');
  const fetchFn = graphFetch();
  await trackTransferPurchase({ db, env: { ...ENV_PROD, META_TRACKING_ENABLED: '' }, orderId: 'o-tr', now: NOW, fetchFn });
  assert.equal(fetchFn.calls.filter(c => c.url.includes('google-analytics.com')).length, 1);
  assert.equal(fetchFn.calls.filter(c => c.url.includes('graph.facebook.com')).length, 0);

  const db2 = createD1();
  await withConsent(db2, 'o-tr');
  const fetch2 = graphFetch();
  await trackTransferPurchase({ db: db2, env: { ...ENV_PROD, GA4_TRANSFER_PURCHASE_ENABLED: '' }, orderId: 'o-tr', now: NOW, fetchFn: fetch2 });
  assert.equal(fetch2.calls.filter(c => c.url.includes('google-analytics.com')).length, 0);
  assert.equal(fetch2.calls.filter(c => c.url.includes('graph.facebook.com')).length, 1);
});

test('transferencia con todo apagado: no se manda nada', async () => {
  const db = createD1();
  const fetchFn = graphFetch();
  const out = await trackTransferPurchase({ db, env: { GA4_MEASUREMENT_ID: 'G-SDX45VEPP3', GA4_API_SECRET: 'x', APP_ENV: 'production' }, orderId: 'o-tr', now: NOW, fetchFn });
  assert.equal(out.ga4.reason, 'disabled');
  assert.equal(out.meta.reason, 'disabled');
  assert.equal(fetchFn.calls.length, 0);
  assert.equal(eventRow(db, 'ga4-purchase:o-tr'), null);
});

// ─── Auditoría: orden de llegada, reintentos, consentimiento retirado ────────

test('auditoría: webhook antes que la atribución → la compra se recupera al llegar InitiateCheckout', async () => {
  const db = createD1();
  const fetchFn = graphFetch();
  // 1) Llega el webhook: todavía no hay consentimiento registrado.
  assert.equal((await sendMetaPurchase({ db, env: ENV_ON, orderId: 'o-mp', now: NOW, fetchFn })).reason, 'no_consent');
  // 2) Llega la atribución del checkout (mismo pedido, ya pagado).
  db.sqlite.prepare("UPDATE orders SET created_at=? WHERE id='o-mp'").run('2026-10-06T14:50:00.000Z');
  await createTrackingMetaHandler({ fetchFn, getNow: () => NOW })({
    request: metaRequest({ ...VIEW_CONTENT, event_name: 'InitiateCheckout', event_id: 'initiate_checkout_AL-261006-MPMPMP', public_code: 'AL-261006-MPMPMP' }),
    env: { ...ENV_ON, ORDERS_DB: db },
  });
  const purchases = fetchFn.calls.filter(c => c.body.data[0].event_name === 'Purchase');
  assert.equal(purchases.length, 1);
  assert.equal(purchases[0].body.data[0].event_id, 'purchase_AL-261006-MPMPMP');
  assert.equal(eventRow(db, 'meta-purchase:o-mp').status, 'sent');
});

test('auditoría: el cron recupera compras con atribución tardía y no las duplica', async () => {
  const db = createD1();
  const fetchFn = graphFetch();
  await sendMetaPurchase({ db, env: ENV_ON, orderId: 'o-mp', now: NOW, fetchFn });
  await withConsent(db, 'o-mp');
  const env = { ...ENV_ON, ORDERS_DB: db };
  const first = await processPendingMetaPurchases(env, { now: NOW, fetchFn });
  const second = await processPendingMetaPurchases(env, { now: NOW, fetchFn });
  assert.equal(first.sent, 1);
  assert.equal(second.processed, 0);
  assert.equal(fetchFn.calls.length, 1);
});

test('auditoría: el cron reintenta los envíos fallidos hasta MAX_ATTEMPTS', async () => {
  const db = createD1();
  await withConsent(db, 'o-mp');
  const env = { ...ENV_ON, ORDERS_DB: db };
  let calls = 0;
  const failing = async () => { calls += 1; return { ok: false, status: 503 }; };
  for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
    await processPendingMetaPurchases(env, { now: new Date(NOW.getTime() + i * 10 * 60 * 1000), fetchFn: failing });
  }
  assert.equal(calls, MAX_ATTEMPTS);
  assert.equal(eventRow(db, 'meta-purchase:o-mp').status, 'failed');
});

test('auditoría: retirar el consentimiento en el servidor bloquea la compra de ese pedido', async () => {
  const db = createD1();
  await withConsent(db, 'o-mp');
  const fetchFn = graphFetch();
  const res = await createTrackingMetaHandler({ fetchFn, getNow: () => NOW })({
    request: metaRequest({ consent: 'denied', revoke_codes: ['AL-261006-MPMPMP'] }),
    env: { ...ENV_ON, ORDERS_DB: db },
  });
  assert.equal((await res.json()).revoked, 1);
  assert.equal(eventRow(db, 'meta-attr:o-mp').consent, 'revoked');
  assert.equal((await sendMetaPurchase({ db, env: ENV_ON, orderId: 'o-mp', now: NOW, fetchFn })).reason, 'no_consent');
  assert.equal((await processPendingMetaPurchases({ ...ENV_ON, ORDERS_DB: db }, { now: NOW, fetchFn })).processed, 0);
  assert.equal(fetchFn.calls.length, 0);
});

test('auditoría: una atribución tardía no rehabilita un pedido revocado', async () => {
  const db = createD1();
  const h = createTrackingMetaHandler({ fetchFn: graphFetch(), getNow: () => NOW });
  await h({ request: metaRequest({ consent: 'denied', revoke_codes: ['AL-261006-OPENOP'] }), env: { ...ENV_ON, ORDERS_DB: db } });
  await recordMetaAttribution({ db, publicCode: 'AL-261006-OPENOP', fbp: FBP, now: NOW });
  assert.equal(eventRow(db, 'meta-attr:o-open').consent, 'revoked');
});

test('auditoría: la URL que llega a Meta sólo conserva parámetros de campaña', async () => {
  const fetchFn = graphFetch();
  await createTrackingMetaHandler({ fetchFn, getNow: () => NOW })({
    request: metaRequest({
      ...VIEW_CONTENT,
      event_source_url: `https://${HOST}/catalogo?q=ana%40mail.com&tel=099123456&token=abc&utm_source=fb&fbclid=XYZ#frag`,
    }),
    env: ENV_ON,
  });
  const url = new URL(fetchFn.calls[0].body.data[0].event_source_url);
  assert.deepEqual([...url.searchParams.keys()].sort(), ['fbclid', 'utm_source']);
  assert.equal(url.hash, '');
  assert.doesNotMatch(url.toString(), /ana|099123456|token/);
});

test('auditoría: límite de solicitudes por visitante', async () => {
  const fetchFn = graphFetch();
  const h = createTrackingMetaHandler({ fetchFn, getNow: () => NOW });
  const statuses = [];
  for (let i = 0; i < 62; i++) {
    const req = metaRequest({ consent: 'granted', event_name: 'PageView', event_id: `page_view_${String(i).padStart(8, '0')}`, event_source_url: `https://${HOST}/` });
    req.headers.set('CF-Connecting-IP', '203.0.113.7');
    statuses.push((await h({ request: req, env: ENV_ON })).status);
  }
  assert.equal(statuses.filter(code => code === 202).length, 60);
  assert.equal(statuses.at(-1), 429);
});

test('Contact sin productos se acepta; con ficha lleva content_ids', async () => {
  const fetchFn = graphFetch();
  const h = createTrackingMetaHandler({ fetchFn, getNow: () => NOW });
  await h({ request: metaRequest({ consent: 'granted', event_name: 'Contact', event_id: 'contact_abcdef1234', event_source_url: `https://${HOST}/contacto/` }), env: ENV_ON });
  await h({ request: metaRequest({ ...VIEW_CONTENT, event_name: 'Contact', event_id: 'contact_abcdef5678' }), env: ENV_ON });
  assert.equal(fetchFn.calls[0].body.data[0].event_name, 'Contact');
  assert.equal(fetchFn.calls[0].body.data[0].custom_data, undefined);
  assert.deepEqual(fetchFn.calls[1].body.data[0].custom_data.content_ids, ['MLU123456789']);
});

test('GA4 purchase de Mercado Pago no cambia', async () => {
  const payload = await buildGa4PurchasePayload({
    order: { id: 'x', public_code: 'AL-1', payable_total_uyu: 1850, shipping_cost_uyu: 250, payment_provider: 'mercado_pago' },
    items: [{ product_id: 'MLU1', title: 'L', quantity: 1, unit_price_uyu: 1600 }],
    now: NOW,
  });
  assert.equal(payload.events[0].params.value, 1600);
  assert.equal(payload.events[0].params.payment_type, 'mercado_pago');
});

// ─── Navegador: meta-tracking.js ─────────────────────────────────────────────

const metaScript = readFileSync('astro-front/public/meta-tracking.js', 'utf8');

function browser({
  config = { enabled: true, pixel_id: '123456789012345' },
  consent = null,
  queue = [],
  cookie = `_fbp=${FBP}`,
  revokeAnswers = [],
  storage: initial = [],
} = {}) {
  const local = new Map([...(consent ? [['amado_marketing_consent', consent]] : []), ...initial]);
  const storage = map => ({ getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) });
  const fbqCalls = [];
  const posts = [];
  const appended = [];
  const fbq = (...args) => fbqCalls.push(args);
  const window = {
    AmadoMetaQueue: queue,
    fbq,
    localStorage: storage(local),
    sessionStorage: storage(new Map()),
    location: {
      href: 'https://www.amadolibros.com/libro/MLU123456789/x?q=ana%40mail.com&utm_source=ig&code=AL-1',
      hostname: 'www.amadolibros.com',
      pathname: '/libro/MLU123456789/x',
    },
    crypto: { getRandomValues: arr => arr.fill(7) },
  };
  const listeners = {};
  const footerList = { children: [], appendChild(el) { this.children.push(el); } };
  const document = {
    cookie,
    body: { appendChild: el => appended.push(el) },
    getElementById: id => appended.find(el => el.id === id) || null,
    createElement: () => ({
      style: {}, attrs: {}, children: [],
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(el) { this.children.push(el); },
      addEventListener(_t, fn) { this.onclick = fn; },
    }),
    querySelector: sel => (sel === '.site-footer .footer-list' ? footerList : null),
    getElementsByTagName: () => [{ parentNode: { insertBefore() {} } }],
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };
  const fetch = async (url, init) => {
    if (url === '/api/tracking/config') return { ok: true, json: async () => config };
    const body = JSON.parse(init.body);
    posts.push(body);
    if (body.revoke_codes) {
      const answer = revokeAnswers.length ? revokeAnswers.shift() : { status: 200, confirmed: true };
      return { ok: answer.status < 300, status: answer.status, json: async () => ({ confirmed: answer.confirmed }) };
    }
    return { ok: true, status: 202, json: async () => ({ ok: true }) };
  };
  runInNewContext(metaScript, { window, document, fetch, URL, Uint8Array, Date, Math, JSON, Array, String, Number, RegExp, isFinite });
  const click = target => (listeners.click || []).forEach(fn => fn({ target, preventDefault() {} }));
  return { window, fbqCalls, posts, appended, local, click, footerList };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('navegador: apagado, no carga el Pixel ni muestra banner', async () => {
  const b = browser({ config: { enabled: false } });
  await tick(); await tick();
  assert.equal(b.fbqCalls.length, 0);
  assert.equal(b.appended.length, 0);
});

test('navegador: sin consentimiento muestra el banner y no dispara nada', async () => {
  const b = browser({ queue: [['ViewContent', { items: [{ id: 'MLU123456789', price: 800 }] }]] });
  await tick(); await tick();
  assert.equal(b.appended[0].id, 'amado-consent');
  assert.equal(b.fbqCalls.length, 0);
  assert.equal(b.posts.length, 0);
});

test('navegador: al aceptar dispara PageView y lo encolado, con el mismo event_id en Pixel y CAPI', async () => {
  const b = browser({ queue: [['AddToCart', { value: 800, items: [{ id: 'MLU123456789', price: 800 }] }]] });
  await tick(); await tick();
  b.window.AmadoMeta.choose('granted');
  assert.equal(b.local.get('amado_marketing_consent'), 'granted');
  const tracks = b.fbqCalls.filter(c => c[0] === 'track');
  assert.deepEqual(tracks.map(c => c[1]), ['PageView', 'AddToCart']);
  const addToCart = tracks[1];
  assert.equal(addToCart[2].currency, 'UYU');
  assert.deepEqual(addToCart[2].content_ids, ['MLU123456789']);
  assert.equal(addToCart[2].content_type, 'product');
  const post = b.posts.find(p => p.event_name === 'AddToCart');
  assert.equal(post.event_id, addToCart[3].eventID);
  assert.equal(post.consent, 'granted');
  assert.equal(post.fbp, FBP);
});

test('navegador: InitiateCheckout lleva el public_code al servidor', async () => {
  const b = browser({ consent: 'granted' });
  await tick(); await tick();
  b.window.AmadoMetaQueue.push(['InitiateCheckout', { eventId: 'initiate_checkout_AL-261006-OPENOP', publicCode: 'AL-261006-OPENOP', value: 1600, items: [{ id: 'MLU123456789', quantity: 2, price: 800 }] }]);
  const post = b.posts.find(p => p.event_name === 'InitiateCheckout');
  assert.equal(post.public_code, 'AL-261006-OPENOP');
  assert.equal(post.event_id, 'initiate_checkout_AL-261006-OPENOP');
});

test('navegador: Purchase usa purchase_<código>, no pasa por el servidor y no se repite al recargar', async () => {
  const b = browser({ consent: 'granted' });
  await tick(); await tick();
  const purchase = ['Purchase', { publicCode: 'AL-261006-MPMPMP', value: 1600, items: [{ id: 'MLU123456789', quantity: 2, price: 800 }] }];
  b.window.AmadoMetaQueue.push(purchase);
  b.window.AmadoMetaQueue.push(purchase);
  const tracks = b.fbqCalls.filter(c => c[0] === 'track' && c[1] === 'Purchase');
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0][3].eventID, 'purchase_AL-261006-MPMPMP');
  assert.equal(tracks[0][2].value, 1600);
  assert.equal(b.posts.filter(p => p.event_name === 'Purchase').length, 0);
});

test('navegador: rechazado, no carga nada', async () => {
  const b = browser({ consent: 'denied', queue: [['ViewContent', { items: [{ id: 'MLU123456789' }] }]] });
  await tick(); await tick();
  assert.equal(b.fbqCalls.length, 0);
  assert.equal(b.posts.length, 0);
  assert.equal(b.appended.length, 0);
});

test('auditoría navegador: aceptar y después rechazar corta Pixel y CAPI', async () => {
  const b = browser({ consent: 'granted' });
  await tick(); await tick();
  b.window.AmadoMetaQueue.push(['InitiateCheckout', { eventId: 'initiate_checkout_AL-261006-OPENOP', publicCode: 'AL-261006-OPENOP', items: [{ id: 'MLU123456789', price: 800 }] }]);
  const tracksBefore = b.fbqCalls.filter(c => c[0] === 'track').length;
  const postsBefore = b.posts.length;

  b.window.AmadoMeta.choose('denied');
  b.window.AmadoMetaQueue.push(['AddToCart', { value: 800, items: [{ id: 'MLU123456789', price: 800 }] }]);
  b.window.AmadoMetaQueue.push(['Purchase', { publicCode: 'AL-261006-OPENOP', items: [{ id: 'MLU123456789', price: 800 }] }]);

  assert.equal(b.fbqCalls.filter(c => c[0] === 'track').length, tracksBefore);
  assert.ok(b.fbqCalls.some(c => c[0] === 'consent' && c[1] === 'revoke'));
  const newPosts = b.posts.slice(postsBefore);
  assert.equal(newPosts.length, 1, 'sólo la revocación');
  assert.deepEqual(newPosts[0], { consent: 'denied', revoke_codes: ['AL-261006-OPENOP'] });
});

test('auditoría navegador: el pie ofrece cambiar la elección de cookies', async () => {
  const b = browser({ consent: 'granted' });
  await tick(); await tick();
  const li = b.footerList.children[0];
  assert.ok(li, 'se agregó el enlace');
  const link = li.children[0];
  assert.equal(link.textContent, 'Cookies');
  b.click({ closest: sel => (sel === '[data-cookie-preferences]' ? link : null) });
  assert.equal(b.appended.at(-1).id, 'amado-consent');
});

test('auditoría navegador: clic en WhatsApp dispara Contact por Pixel y CAPI', async () => {
  const b = browser({ consent: 'granted' });
  await tick(); await tick();
  const anchor = { href: 'https://wa.me/59899841325?text=hola' };
  b.click({ closest: sel => (sel === 'a[href]' ? anchor : null) });
  const contact = b.fbqCalls.find(c => c[0] === 'track' && c[1] === 'Contact');
  assert.ok(contact);
  assert.equal(JSON.stringify(contact[2].content_ids), '["MLU123456789"]');
  const post = b.posts.find(p => p.event_name === 'Contact');
  assert.equal(post.event_id, contact[3].eventID);
});

test('auditoría navegador: el botón de WhatsApp del carrito (window.open) también encola Contact', async () => {
  const carrito = readFileSync('astro-front/src/pages/carrito.astro', 'utf8');
  assert.match(carrito, /AmadoMetaQueue[\s\S]{0,80}\['Contact', \{\}\][\s\S]{0,40}window\.open\(/);
  const b = browser({ consent: 'granted' });
  await tick(); await tick();
  b.window.AmadoMetaQueue.push(['Contact', {}]);
  const contact = b.fbqCalls.find(c => c[0] === 'track' && c[1] === 'Contact');
  assert.ok(contact);
  const post = b.posts.find(p => p.event_name === 'Contact');
  assert.equal(post.event_id, contact[3].eventID);
});

test('auditoría navegador: PageView sale como evento estándar (sin objeto vacío)', async () => {
  const b = browser({ consent: 'granted' });
  await tick(); await tick();
  const pageView = b.fbqCalls.find(c => c[0] === 'track' && c[1] === 'PageView');
  assert.ok(pageView);
  assert.equal(pageView[2], undefined);
  assert.match(pageView[3].eventID, /^page_view_/);
});

test('auditoría navegador: la URL enviada al servidor sólo lleva parámetros de campaña', async () => {
  const b = browser({ consent: 'granted' });
  await tick(); await tick();
  const pageView = b.posts.find(p => p.event_name === 'PageView');
  const url = new URL(pageView.event_source_url);
  assert.deepEqual([...url.searchParams.keys()], ['utm_source']);
});

test('auditoría navegador: el Pixel no usa configuración automática', async () => {
  const b = browser({ consent: 'granted' });
  await tick(); await tick();
  assert.ok(b.fbqCalls.some(c => c[0] === 'set' && c[1] === 'autoConfig' && c[2] === false));
});

// ─── Segunda auditoría ───────────────────────────────────────────────────────

test('auditoría 2: Preview sin código de prueba no entrega ningún Pixel al navegador', () => {
  assert.deepEqual(publicTrackingConfig({ ...ENV_ON, META_TEST_EVENT_CODE: '' }), { enabled: false });
  assert.equal(metaConfig({ ...ENV_ON, META_TEST_EVENT_CODE: '' }), null);
});

test('auditoría 2: Preview usa sólo el Pixel de pruebas, nunca el productivo', async () => {
  assert.deepEqual(publicTrackingConfig(ENV_ON), { enabled: true, pixel_id: '123456789012345' });
  const config = metaConfig(ENV_ON);
  assert.equal(config.pixelId, '123456789012345');
  assert.equal(config.token, TOKEN);
  // Sin Pixel de pruebas, aunque estén el productivo y el código: apagado.
  const { META_TEST_PIXEL_ID, ...withoutTestPixel } = ENV_ON;
  assert.deepEqual(publicTrackingConfig(withoutTestPixel), { enabled: false });
  const res = await createTrackingConfigHandler()({ request: new Request(`https://${HOST}/api/tracking/config`), env: ENV_ON });
  assert.doesNotMatch(await res.text(), new RegExp(PROD_PIXEL));
  const fetchFn = graphFetch();
  await postMetaEvents(config, [{ event_name: 'PageView' }], { fetchFn });
  assert.doesNotMatch(fetchFn.calls[0].url, new RegExp(PROD_PIXEL));
  assert.notEqual(fetchFn.calls[0].body.access_token, PROD_TOKEN);
});

test('auditoría 2: producción usa el Pixel productivo y no necesita código de prueba', () => {
  assert.deepEqual(publicTrackingConfig(ENV_PROD), { enabled: true, pixel_id: '123456789012345' });
  assert.equal(metaConfig(ENV_PROD).testEventCode, undefined);
  assert.deepEqual(publicTrackingConfig({ ...ENV_PROD, META_TRACKING_ENABLED: '' }), { enabled: false });
});

test('auditoría 2: la revocación no comparte el límite de los eventos', async () => {
  const db = createD1();
  await withConsent(db, 'o-mp');
  const h = createTrackingMetaHandler({ fetchFn: graphFetch(), getNow: () => NOW });
  const env = { ...ENV_ON, ORDERS_DB: db };
  for (let i = 0; i < 61; i++) {
    const req = metaRequest({ consent: 'granted', event_name: 'PageView', event_id: `page_view_${String(i).padStart(8, '0')}`, event_source_url: `https://${HOST}/` });
    req.headers.set('CF-Connecting-IP', '203.0.113.9');
    await h({ request: req, env });
  }
  const revoke = metaRequest({ consent: 'denied', revoke_codes: ['AL-261006-MPMPMP'] });
  revoke.headers.set('CF-Connecting-IP', '203.0.113.9');
  const res = await h({ request: revoke, env });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, confirmed: true, revoked: 1 });
  assert.equal(eventRow(db, 'meta-attr:o-mp').consent, 'revoked');
});

test('auditoría 2: la revocación se registra aunque Meta esté apagado', async () => {
  const db = createD1();
  await withConsent(db, 'o-mp');
  const res = await createTrackingMetaHandler({ fetchFn: graphFetch(), getNow: () => NOW })({
    request: metaRequest({ consent: 'denied', revoke_codes: ['AL-261006-MPMPMP'] }),
    env: { ...ENV_ON, META_TRACKING_ENABLED: '', ORDERS_DB: db },
  });
  assert.equal((await res.json()).confirmed, true);
  assert.equal(eventRow(db, 'meta-attr:o-mp').consent, 'revoked');
});

test('auditoría 2: si la base falla, la revocación no se confirma', async () => {
  const broken = { prepare() { throw new Error('D1 caída'); } };
  const res = await createTrackingMetaHandler({ fetchFn: graphFetch(), getNow: () => NOW })({
    request: metaRequest({ consent: 'denied', revoke_codes: ['AL-261006-MPMPMP'] }),
    env: { ...ENV_ON, ORDERS_DB: broken },
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).confirmed, false);
});

test('auditoría 2 navegador: una revocación rechazada (429) queda guardada y se reintenta hasta confirmarse', async () => {
  const b = browser({
    consent: 'granted',
    storage: [['amado_meta_orders', JSON.stringify(['AL-261006-OPENOP'])]],
    revokeAnswers: [{ status: 429 }, { status: 503, confirmed: false }, { status: 200, confirmed: true }],
  });
  await tick(); await tick();
  b.window.AmadoMeta.choose('denied');
  await tick(); await tick();
  assert.equal(b.local.get('amado_meta_revoke_pending'), JSON.stringify(['AL-261006-OPENOP']), 'sigue pendiente tras el 429');
  await b.window.AmadoMeta.flushRevocations();
  assert.equal(b.local.get('amado_meta_revoke_pending'), JSON.stringify(['AL-261006-OPENOP']), 'sigue pendiente tras el 503');
  await b.window.AmadoMeta.flushRevocations();
  assert.equal(b.local.get('amado_meta_revoke_pending'), '[]', 'se borra sólo con confirmación');
  assert.equal(b.posts.filter(p => p.revoke_codes).length, 3);
});

test('auditoría 2 navegador: una revocación pendiente se reenvía al cargar cualquier página', async () => {
  const b = browser({
    consent: 'denied',
    config: { enabled: false },
    storage: [['amado_meta_revoke_pending', JSON.stringify(['AL-261006-OPENOP'])]],
  });
  await tick(); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(b.posts[0])), { consent: 'denied', revoke_codes: ['AL-261006-OPENOP'] });
  assert.equal(b.local.get('amado_meta_revoke_pending'), '[]');
});

// ─── Las páginas emiten, sin tocar la lógica ─────────────────────────────────

test('cada página encola su evento de Meta junto al de GA4', () => {
  const ficha = readFileSync('functions/libro/[[path]].js', 'utf8');
  const cart = readFileSync('astro-front/public/cart.js', 'utf8');
  const carrito = readFileSync('astro-front/src/pages/carrito.astro', 'utf8');
  const pedido = readFileSync('astro-front/src/pages/pedido.astro', 'utf8');
  const layout = readFileSync('astro-front/src/layouts/BaseLayout.astro', 'utf8');
  const brand = readFileSync('functions/_shared/brand.js', 'utf8');
  assert.match(ficha, /\['ViewContent',/);
  assert.match(cart, /\['AddToCart',/);
  assert.match(carrito, /\['InitiateCheckout',[\s\S]*publicCode: order\.public_code/);
  assert.match(pedido, /\['Purchase',[\s\S]*publicCode:/);
  assert.match(layout, /<script src="\/meta-tracking\.js" defer><\/script>/);
  assert.match(brand, /<script src="\/meta-tracking\.js" defer><\/script>/);
});
