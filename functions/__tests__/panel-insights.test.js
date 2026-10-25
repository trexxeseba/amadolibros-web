import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { createSessionToken, deriveSessionSecret } from '../_shared/panel-auth.js';
import {
  VINTAGE_RUN_ID,
  VINTAGE_SELLER_ID,
  loadCatalogChanges,
  loadMlSales,
  loadSearchMisses,
  loadVintage,
  markWhatsappContacted,
  mergeRevenue,
  whatsappRestockLink,
} from '../_shared/panel-insights.js';
import { revenueChart, revenueTable } from '../_shared/panel-chart.js';
import { onRequest } from '../panel/[[path]].js';

// Todo lo de acá es inventado: el repo es público y no lleva datos del negocio.
const NOW = Date.parse('2026-10-24T15:00:00.000Z');
const DAY = 86_400_000;
const PASSWORD = 'contraseña-larga-del-panel';

function migration(name) {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

/** D1 sobre SQLite en memoria: lo mínimo que usa el panel. */
function d1(db) {
  return {
    prepare(sql) {
      let args = [];
      const statement = {
        bind: (...values) => { args = values; return statement; },
        all: async () => ({ results: db.prepare(sql).all(...args) }),
        first: async () => db.prepare(sql).get(...args) ?? null,
        run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
      };
      return statement;
    },
  };
}

function seed() {
  const db = new DatabaseSync(':memory:');
  for (const name of ['0001_orders.sql', '0002_orders_shipping_date_montevideo.sql', '0003_stock_waitlist.sql',
    '0004_crawl_stats.sql', '0005_orders_delivery_coordination.sql', '0006_orders_buyer_email.sql',
    '0007_stock_waitlist_customer_notification.sql', '0008_orders_ga4_attribution.sql',
    '0010_orders_paid_amount.sql', '0011_search_misses.sql', '0012_catalog_sync_log.sql',
    '0013_stock_waitlist_whatsapp.sql', '0014_orders_archived.sql']) {
    db.exec(migration(name));
  }
  db.exec(`
    CREATE TABLE ml_sales_orders(order_id TEXT PRIMARY KEY,seller_id TEXT NOT NULL,status TEXT NOT NULL,date_created TEXT NOT NULL,date_created_ms INTEGER NOT NULL,date_closed TEXT,last_updated TEXT,last_updated_ms INTEGER NOT NULL,total_amount REAL,currency_id TEXT,pack_id TEXT,tags_json TEXT,fetched_at INTEGER NOT NULL);
    CREATE TABLE ml_sales_items(order_id TEXT NOT NULL,line_key TEXT NOT NULL,item_id TEXT NOT NULL,variation_id TEXT,title TEXT,title_key TEXT,seller_sku TEXT,quantity INTEGER NOT NULL,unit_price REAL,currency_id TEXT,isbn TEXT,gtin_raw TEXT,identity_source TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(order_id,line_key));
    CREATE TABLE ml_vintage_pub_receipts(seller_id TEXT NOT NULL,isbn TEXT NOT NULL,state TEXT NOT NULL,item_id TEXT,run_id TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(seller_id,isbn));
    CREATE TABLE ml_vintage_pub_run_targets(run_id TEXT PRIMARY KEY,target_published INTEGER NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE ml_vintage_pub_runs(id TEXT PRIMARY KEY,state TEXT);
    CREATE TABLE ml_vintage_pub_jobs(run_id TEXT NOT NULL,isbn TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(run_id,isbn));
    CREATE TABLE sbs_supplier_feeds(id TEXT PRIMARY KEY,source_date TEXT NOT NULL,source_sha256 TEXT NOT NULL,state TEXT NOT NULL,expected_rows INTEGER NOT NULL,created_at INTEGER NOT NULL,checked_at INTEGER NOT NULL);
  `);

  const order = db.prepare('INSERT INTO ml_sales_orders VALUES (?,?,?,?,?,NULL,NULL,0,?,?,NULL,NULL,0)');
  const item = db.prepare('INSERT INTO ml_sales_items VALUES (?,?,?,NULL,?,NULL,NULL,?,NULL,NULL,NULL,NULL,NULL,0)');
  const iso = ms => new Date(ms - 3 * 3600_000).toISOString().replace('Z', '-03:00');
  order.run('1', '440298103', 'paid', iso(NOW - 2 * DAY), NOW - 2 * DAY, 1000, 'UYU');
  item.run('1', 'a', 'MLU1', 'Libro A', 2);
  order.run('2', '440298103', 'cancelled', iso(NOW - 3 * DAY), NOW - 3 * DAY, 9999, 'UYU');
  item.run('2', 'a', 'MLU2', 'Libro B', 5);
  order.run('3', '440298103', 'paid', iso(NOW - 40 * DAY), NOW - 40 * DAY, 500, 'UYU');
  order.run('4', '440298103', 'paid', iso(NOW - 5 * DAY), NOW - 5 * DAY, 30, 'USD');
  // Otro vendedor: nunca se suma a Amado Libros.
  order.run('5', VINTAGE_SELLER_ID, 'paid', iso(NOW - 1 * DAY), NOW - 1 * DAY, 7777, 'UYU');

  const miss = db.prepare('INSERT INTO search_misses VALUES (?,?,?,?,?)');
  miss.run('2026-10-20', 'borges', 3, '2026-10-20T10:00:00Z', '2026-10-20T11:00:00Z');
  miss.run('2026-10-22', 'borges', 2, '2026-10-22T10:00:00Z', '2026-10-22T12:00:00Z');
  miss.run('2026-10-23', '<b>raro</b>', 1, '2026-10-23T10:00:00Z', '2026-10-23T10:00:00Z');
  miss.run('2026-08-01', 'viejo', 50, '2026-08-01T10:00:00Z', '2026-08-01T10:00:00Z');

  const sync = db.prepare(`INSERT INTO catalog_sync_log (id, synced_at, total_items, available_items, previous_total,
    added, removed, price_up, price_down, out_of_stock, back_in_stock, baseline, samples_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  sync.run('s1', new Date(NOW - DAY).toISOString(), 100, 80, 99, 2, 1, 3, 0, 4, 1, 1,
    JSON.stringify({ added: [{ id: 'MLU10', title: 'Nuevo' }], removed: [], price_changes: [{ id: 'MLU11', title: 'Caro', from: 100, to: 200 }] }));
  sync.run('s2', new Date(NOW - 2 * DAY).toISOString(), 99, 80, null, 99, 0, 0, 0, 0, 0, 0, '{}');

  const wa = db.prepare(`INSERT INTO stock_waitlist_whatsapp (id, product_id, product_title, whatsapp, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?)`);
  wa.run('w1', 'MLU1', 'Libro con stock', '099 123 456', 'waiting', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z');
  wa.run('w2', 'MLU2', 'Libro sin stock', '099 765 432', 'waiting', '2026-10-02T10:00:00Z', '2026-10-02T10:00:00Z');

  const receipt = db.prepare('INSERT INTO ml_vintage_pub_receipts VALUES (?,?,?,?,?,?,?)');
  receipt.run(VINTAGE_SELLER_ID, '1', 'published', 'MLU900', VINTAGE_RUN_ID, NOW - 600_000, NOW - 600_000);
  receipt.run(VINTAGE_SELLER_ID, '2', 'published', 'MLU901', VINTAGE_RUN_ID, NOW - 3 * DAY, NOW - 3 * DAY);
  receipt.run(VINTAGE_SELLER_ID, '3', 'uncertain', null, VINTAGE_RUN_ID, NOW - 600_000, NOW - 600_000);
  db.prepare('INSERT INTO ml_vintage_pub_run_targets VALUES (?,?,?)').run(VINTAGE_RUN_ID, 100, 0);
  db.prepare('INSERT INTO ml_vintage_pub_runs VALUES (?,?)').run(VINTAGE_RUN_ID, 'publishing');
  db.prepare('INSERT INTO ml_vintage_pub_jobs VALUES (?,?,?)').run(VINTAGE_RUN_ID, '3', 'uncertain');
  db.prepare('INSERT INTO sbs_supplier_feeds VALUES (?,?,?,?,?,?,?)')
    .run('f1', new Date(NOW - 5 * 3600_000).toISOString(), 'x', 'ready', 1, NOW - 4 * 3600_000, NOW);
  return db;
}

test('ventas ML: suma solo lo cobrado en pesos de Amado Libros y separa otra moneda', async () => {
  const ml = await loadMlSales(d1(seed()), { now: NOW });
  assert.deepEqual(ml.last30, { orders: 1, total_uyu: 1000, units: 2, otherCurrencyOrders: 1 });
  assert.equal(ml.byMonth.get('2026-10').total_uyu, 1000);
  assert.equal(ml.byMonth.get('2026-09').total_uyu, 500);
  // La carga empezó hace 40 días: los meses anteriores no son cero, no hay dato.
  assert.equal(ml.partial, true);
});

test('el gráfico apila ML y web, y la tabla los muestra por separado', async () => {
  const ml = await loadMlSales(d1(seed()), { now: NOW });
  const web = { months: [{ month: '2026-09', orders: 1, total_uyu: 200 }, { month: '2026-10', orders: 0, total_uyu: 0 }] };
  const merged = mergeRevenue(web, ml);
  assert.equal(merged.max, 1000);
  assert.deepEqual(merged.months.map(m => m.ml_uyu), [500, 1000]);
  assert.match(revenueChart(merged), /class="barra-ml"/);
  assert.match(revenueTable(merged), /Mercado Libre/);
});

test('búsquedas sin resultado: agrupa los últimos 30 días y deja afuera lo viejo', async () => {
  const misses = await loadSearchMisses(d1(seed()), { now: NOW });
  assert.equal(misses.top[0].query, 'borges');
  assert.equal(misses.top[0].total, 5);
  assert.equal(misses.top[0].days, 2);
  assert.ok(!misses.top.some(row => row.query === 'viejo'));
  assert.equal(misses.searches, 6);
});

test('cambios de catálogo: no cuenta como altas un sync sin catálogo anterior', async () => {
  const cambios = await loadCatalogChanges(d1(seed()), { now: NOW });
  assert.equal(cambios.syncs, 2);
  assert.equal(cambios.totals.added, 2);
  assert.equal(cambios.totals.out_of_stock, 4);
  assert.equal(cambios.samples.price_changes[0].to, 200);
});

test('Vintage: publicadas, de hoy, objetivo y casos para revisar, solo del vendedor de Vintage', async () => {
  const v = await loadVintage(d1(seed()), { now: NOW });
  assert.equal(v.published, 2);
  assert.equal(v.today, 1);
  assert.equal(v.week, 2);
  assert.equal(v.target, 100);
  assert.equal(v.review, 1);
  assert.equal(v.feedFresh, true);
  assert.equal(v.verdict, 'ok');
});

test('el mensaje de WhatsApp lleva el número con prefijo y el título del libro', () => {
  const link = whatsappRestockLink({ whatsapp: '099 123 456', product_title: 'Rayuela' });
  assert.match(link, /^https:\/\/wa\.me\/59899123456\?text=/);
  assert.match(decodeURIComponent(link), /«Rayuela»/);
  assert.equal(whatsappRestockLink({ whatsapp: 'no', product_title: 'x' }), '');
});

test('«ya le escribí» solo pasa un aviso de esperando a contactado, una vez', async () => {
  const db = seed();
  assert.deepEqual(await markWhatsappContacted(d1(db), 'w1'), { ok: true });
  assert.deepEqual(await markWhatsappContacted(d1(db), 'w1'), { ok: false });
  assert.equal(db.prepare("SELECT status FROM stock_waitlist_whatsapp WHERE id = 'w1'").get().status, 'contacted');
});

function env(db) {
  return {
    APP_ENV: 'test',
    ALLOWED_HOSTS: 'amadolibros.com,www.amadolibros.com',
    PANEL_PASSWORD: PASSWORD,
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    STOCK_WAITLIST_TURNSTILE_SITE_KEY: '0x4AAAAAAD_sitekey',
    ORDERS_DB: d1(db),
  };
}

async function cookie() {
  return `amado_panel_session=${await createSessionToken(await deriveSessionSecret(PASSWORD))}`;
}

async function withCatalog(run) {
  const original = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  globalThis.fetch = async () => new Response(JSON.stringify({
    updated_at: '2026-10-24T10:00:00Z',
    items: [
      { id: 'MLU1', title: 'Libro con stock', status: 'active', available_quantity: 2, pictures: [{}] },
      { id: 'MLU2', title: 'Libro sin stock', status: 'active', available_quantity: 0, pictures: [{}] },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try { return await run(); } finally { globalThis.fetch = original; globalThis.caches = originalCaches; }
}

test('el tablero muestra ventas ML, Vintage, búsquedas escapadas y el aviso de WhatsApp con stock', async () => {
  const db = seed();
  const html = await withCatalog(async () => (await onRequest({
    request: new Request('https://www.amadolibros.com/panel', { headers: { cookie: await cookie() } }),
    env: env(db),
  })).text());

  assert.match(html, /Vendido · 30 días/);
  assert.match(html, /ML \$ 1/);
  assert.match(html, /Amado Vintage/);
  assert.match(html, /Lo que buscan y no tenemos/);
  assert.match(html, /&lt;b&gt;raro&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>raro<\/b>/);
  assert.match(html, /Qué cambió en el catálogo/);
  // Solo el libro que hoy tiene stock aparece para avisar.
  assert.match(html, /aviso-whatsapp\/w1\/contactado/);
  assert.doesNotMatch(html, /aviso-whatsapp\/w2\/contactado/);
  assert.match(html, /wa\.me\/59899123456/);
});

test('el tablero no escribe nada en D1 al abrirse', async () => {
  const db = seed();
  const antes = db.prepare("SELECT COUNT(*) AS n FROM stock_waitlist_whatsapp WHERE status = 'waiting'").get().n;
  await withCatalog(async () => onRequest({
    request: new Request('https://www.amadolibros.com/panel', { headers: { cookie: await cookie() } }),
    env: env(db),
  }));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM stock_waitlist_whatsapp WHERE status = 'waiting'").get().n, antes);
});

test('POST «ya le escribí»: con sesión marca y vuelve al tablero; sin sesión o desde otro sitio no', async () => {
  const db = seed();
  const post = async headers => onRequest({
    request: new Request('https://www.amadolibros.com/panel/aviso-whatsapp/w1/contactado', { method: 'POST', headers }),
    env: env(db),
  });
  const estado = () => db.prepare("SELECT status FROM stock_waitlist_whatsapp WHERE id = 'w1'").get().status;

  await post({});
  assert.equal(estado(), 'waiting');
  const ajeno = await post({ cookie: await cookie(), origin: 'https://otro.example' });
  assert.equal(ajeno.status, 403);
  assert.equal(estado(), 'waiting');

  const ok = await post({ cookie: await cookie(), origin: 'https://www.amadolibros.com' });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/panel#pendientes');
  assert.equal(estado(), 'contacted');
});
