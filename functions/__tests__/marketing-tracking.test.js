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
const ENV_ON = {
  MARKETING_TRACKING_ENABLED: 'true',
  META_PIXEL_ID: '123456789012345',
  META_CAPI_TOKEN: TOKEN,
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

test('apagado por defecto: sin MARKETING_TRACKING_ENABLED no hay Pixel ni CAPI', () => {
  const { MARKETING_TRACKING_ENABLED, ...rest } = ENV_ON;
  assert.deepEqual(publicTrackingConfig(rest), { enabled: false });
  assert.equal(metaConfig(rest), null);
  assert.deepEqual(publicTrackingConfig({ ...ENV_ON, MARKETING_TRACKING_ENABLED: 'false' }), { enabled: false });
});

test('la configuración pública nunca expone el token', async () => {
  const res = await createTrackingConfigHandler()({ request: new Request(`https://${HOST}/api/tracking/config`), env: ENV_ON });
  const body = await res.text();
  assert.deepEqual(JSON.parse(body), { enabled: true, pixel_id: '123456789012345' });
  assert.doesNotMatch(body, /EAAB|token/i);
});

test('producción no enciende la medición nueva desde wrangler.toml', () => {
  const toml = readFileSync('wrangler.toml', 'utf8');
  const production = toml.slice(toml.indexOf('[env.production.vars]'));
  assert.doesNotMatch(production, /MARKETING_TRACKING_ENABLED/);
  assert.doesNotMatch(toml, /META_CAPI_TOKEN\s*=/);
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
  assert.equal((await h({ request: metaRequest(VIEW_CONTENT), env: { ...ENV_ON, MARKETING_TRACKING_ENABLED: '' } })).status, 202);
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

test('transferencia confirmada: GA4 purchase y Meta Purchase, una sola vez cada uno', async () => {
  const db = createD1();
  await withConsent(db, 'o-tr');
  const fetchFn = graphFetch();
  await trackTransferPurchase({ db, env: ENV_ON, orderId: 'o-tr', now: NOW, fetchFn });
  await trackTransferPurchase({ db, env: ENV_ON, orderId: 'o-tr', now: NOW, fetchFn });
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
});

test('transferencia con el flag apagado: no se manda nada', async () => {
  const db = createD1();
  const fetchFn = graphFetch();
  const out = await trackTransferPurchase({ db, env: { GA4_MEASUREMENT_ID: 'G-SDX45VEPP3', GA4_API_SECRET: 'x' }, orderId: 'o-tr', now: NOW, fetchFn });
  assert.equal(out.reason, 'disabled');
  assert.equal(fetchFn.calls.length, 0);
  assert.equal(eventRow(db, 'ga4-purchase:o-tr'), null);
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

function browser({ config = { enabled: true, pixel_id: '123456789012345' }, consent = null, queue = [], cookie = `_fbp=${FBP}` } = {}) {
  const local = new Map(consent ? [['amado_marketing_consent', consent]] : []);
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
    location: { href: 'https://www.amadolibros.com/libro/MLU123456789/x', hostname: 'www.amadolibros.com' },
    crypto: { getRandomValues: arr => arr.fill(7) },
  };
  const document = {
    cookie,
    body: { appendChild: el => appended.push(el) },
    getElementById: id => appended.find(el => el.id === id) || null,
    createElement: () => ({ style: {}, setAttribute() {}, addEventListener(_t, fn) { this.onclick = fn; } }),
    getElementsByTagName: () => [{ parentNode: { insertBefore() {} } }],
    addEventListener() {},
  };
  const fetch = async (url, init) => {
    if (url === '/api/tracking/config') return { ok: true, json: async () => config };
    posts.push(JSON.parse(init.body));
    return { ok: true };
  };
  runInNewContext(metaScript, { window, document, fetch, URL, Uint8Array, Date, Math, JSON, Array, String, Number, RegExp, isFinite });
  return { window, fbqCalls, posts, appended, local };
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
