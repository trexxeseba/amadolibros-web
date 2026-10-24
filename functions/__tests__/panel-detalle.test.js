import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  accountsAndSupplierSection,
  crawlDetailSection,
  loadDetalle,
  mlDetailSection,
  purchasesSection,
  webInsightsSection,
} from '../_shared/panel-detalle.js';
import { ga4Section, loadGoogle, searchConsoleSection } from '../_shared/panel-google.js';
import { SALES_SCHEMA } from '../../worker-sync/ml-sales.js';
import { PURCHASE_SCHEMA } from '../../worker-sync/purchases.js';
import { SBS_SCHEMA } from '../../worker-sync/sbs-supplier-stock.js';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const DAY = 86400000;
const iso = daysAgo => new Date(NOW - daysAgo * DAY).toISOString();

// D1 sobre SQLite real, con el esquema de verdad: así una consulta mal escrita
// falla acá y no recién en el panel de producción. Anota todo lo que se ejecuta.
function database(t, { schema = true } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  const seen = [];
  if (schema) {
    const dir = new URL('../../migrations/', import.meta.url);
    for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
      sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
    }
    for (const sql of [...SALES_SCHEMA, ...PURCHASE_SCHEMA, ...SBS_SCHEMA]) sqlite.exec(sql);
    for (const col of ['document_type', 'order_refs', 'superseded_by', 'purpose', 'received_date']) {
      sqlite.exec(`ALTER TABLE purchase_orders ADD COLUMN ${col} TEXT`);
    }
  }
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    all: async () => { seen.push(sql); return { results: sqlite.prepare(sql).all(...args) }; },
  });
  return { db: { prepare: sql => statement(sql) }, sqlite, seen };
}

function seed(sqlite) {
  const run = (sql, ...args) => sqlite.prepare(sql).run(...args);
  const venta = (id, daysAgo, status, itemId, qty, price, sku = null, isbn = '9780306406157', title = 'El libro') => {
    run(`INSERT INTO ml_sales_orders(order_id,seller_id,status,date_created,date_created_ms,last_updated_ms,fetched_at)
         VALUES(?, '440298103', ?, ?, ?, 0, 0)`, id, status, iso(daysAgo), NOW - daysAgo * DAY);
    run(`INSERT INTO ml_sales_items(order_id,line_key,item_id,title,title_key,seller_sku,quantity,unit_price,currency_id,isbn,updated_at)
         VALUES(?, '1', ?, ?, ?, ?, ?, ?, 'UYU', ?, 0)`, id, itemId, title, title.toLowerCase(), sku, qty, price, isbn);
  };
  venta('1', 2, 'paid', 'MLU1', 2, 500);
  venta('2', 10, 'paid', 'MLU1', 1, 500);
  venta('3', 20, 'paid', 'MLU4', 1, 900, 'AMADO-AR-9788420412146', '9788420412146', '<b>Encargo</b>');
  venta('4', 5, 'cancelled', 'MLU1', 3, 500);
  venta('5', 200, 'paid', 'MLU9', 4, 300, null, null, 'Sin ISBN');

  run(`INSERT INTO orders(id, public_code, idempotency_key, request_fingerprint, status, payment_status,
       buyer_name, buyer_phone, buyer_email, delivery_type, address, locality, department,
       requested_delivery_date, requested_delivery_from, requested_delivery_to,
       products_total_uyu, payable_total_uyu, created_at, expires_at, paid_at, updated_at)
       VALUES('o1','AL-000001-AAAAAA','k1','f1','fulfilled','approved','Ana','099','ana@x.uy','shipping',
       'Calle 1','Pando','Canelones','2026-10-22','10:00','12:00',1000,1000,?,?,?,?)`,
  iso(3), iso(2), iso(3), iso(3));
  run(`INSERT INTO order_items(order_id, product_id, title, quantity, unit_price_uyu, line_total_uyu, created_at)
       VALUES('o1','MLU1','El libro',1,1000,1000,?)`, iso(3));

  run(`INSERT INTO search_misses(date, query, count, first_seen, last_seen) VALUES(?, 'jung <rojo>', 4, ?, ?)`,
    iso(1).slice(0, 10), iso(1), iso(1));
  run(`INSERT INTO catalog_sync_log(id, synced_at, total_items, available_items, added, removed, price_up, samples_json)
       VALUES('a', ?, 100, 80, 1, 0, 1, ?)`, iso(1),
  JSON.stringify({ added: [{ id: 'MLU5', title: 'Nuevo', price: 700 }], removed: [], price_changes: [{ id: 'MLU1', title: 'El libro', from: 500, to: 600 }] }));
  run(`INSERT INTO purchase_orders(purchase_id, supplier, document_number, purchase_date, purchase_date_ms, currency, total_amount, created_at, updated_at, document_type, purpose)
       VALUES('SBS:INV:2026:1','SBS','1',?,?,'UYU',1500,0,0,'invoice','stock')`, iso(5).slice(0, 10), NOW - 5 * DAY);
  run(`INSERT INTO purchase_items(purchase_id, line_key, isbn, title, quantity, match_method, match_confidence, created_at, updated_at)
       VALUES('SBS:INV:2026:1','1',NULL,'Algo',3,'unresolved',0,0,0)`);
  run(`INSERT INTO crawl_stats_segmented(date, pattern, segment, status, verified, ua_googlebot, request_count, duration_ms_sum)
       VALUES(?, 'libro', 'active', 200, 1, 1, 90, 9000), (?, 'libro', 'paused_other', 404, 1, 1, 10, 100)`,
  iso(1).slice(0, 10), iso(1).slice(0, 10));
}

test('todas las consultas nuevas corren contra el esquema real y los números cierran', async t => {
  const { db, sqlite, seen } = database(t);
  seed(sqlite);
  const ins = await loadDetalle(db, { now: NOW });
  for (const [name, block] of Object.entries(ins)) assert.equal(block.ok, true, `${name}: ${block.error}`);

  const w = Object.fromEntries(ins.ml.data.windows.map(x => [x.days, x]));
  // La cancelada no suma; la de hace 200 días sólo entra en 365.
  assert.deepEqual([w[7].units, w[30].units, w[365].units], [2, 4, 8]);
  assert.equal(w[30].uyu, 2 * 500 + 500 + 900);
  assert.equal(w[30].encargo, 1);
  assert.equal(ins.ml.data.cancelled30, 1);
  assert.equal(ins.ml.data.top30[0].units, 3);
  assert.equal(ins.ml.data.daily.length, 30);
  assert.equal(ins.web.data.compradores.buyers, 1);
  assert.equal(ins.compras.data.unmatched, 1);
  assert.equal(ins.rastreo.data.patrones[0].requests, 100);

  // Sólo lectura: el panel observa.
  for (const sql of seen) assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i, sql);

  const html = [
    mlDetailSection(ins.ml.data), webInsightsSection(ins.web.data),
    purchasesSection(ins.compras.data), crawlDetailSection(ins.rastreo.data),
    accountsAndSupplierSection(ins.cuentas.data, ins.sbs.data),
  ].join('');
  // Lo que escribe gente de afuera (títulos, búsquedas) sale escapado.
  assert.doesNotMatch(html, /<b>Encargo<\/b>/);
  assert.match(html, /&lt;b&gt;Encargo&lt;\/b&gt;/);
  assert.match(html, /fichas de libro/);
});

test('un entorno donde worker-sync nunca corrió dice «sin datos», no un error', async t => {
  const { db } = database(t, { schema: false });
  const ins = await loadDetalle(db, { now: NOW });
  assert.equal(ins.ml.ok, false);
  assert.equal(ins.ml.empty, true);
  assert.match(ins.ml.error, /Sin datos todavía/);
});

test('GA4: sin resumen en KV lo dice; con resumen viejo avisa; los enlaces sólo van a rutas propias', async () => {
  assert.deepEqual(await loadGoogle(undefined), { missing: true });
  assert.match(ga4Section({ missing: true }), /Todavía no hay datos de GA4/);

  const resumen = {
    generatedAt: new Date(NOW - 20 * 3600000).toISOString(),
    ga4: {
      totals: { activeUsers: 120, sessions: 200, engagedSessions: 100, screenPageViews: 900, averageSessionDuration: 90 },
      previousTotals: { activeUsers: 100 },
      daily: [{ day: '2026-10-23', users: 10, sessions: 12 }],
      channels: [{ sessionDefaultChannelGroup: 'Organic Search', sessions: 150, engagedSessions: 90 }],
      landings: [{ landingPage: 'javascript:alert(1)', sessions: 3 }, { landingPage: '//malo.com', sessions: 2 }, { landingPage: '/libros', sessions: 9 }],
      events: { purchase: 2 },
    },
    gsc: { totals: { clicks: 50, impressions: 4000, ctr: 0.0125, position: 18.2 }, queries: [{ query: '<x>', clicks: 3 }] },
  };
  const kv = { get: async () => resumen };
  const g = await loadGoogle(kv, { now: NOW });
  assert.equal(g.stale, true);
  const html = ga4Section(g) + searchConsoleSection(g);
  assert.match(html, /no está actualizando/);
  assert.match(html, /\+20% vs 28 días antes/);
  assert.match(html, /Google y buscadores/);
  assert.match(html, /<a href="\/libros">/);
  assert.doesNotMatch(html, /href="javascript|href="\/\/malo/);
  assert.match(html, /&lt;x&gt;/);
});
