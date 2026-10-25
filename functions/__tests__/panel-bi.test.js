import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { loadBi, abc } from '../_shared/panel-bi.js';
import { renderBi, createBiPanel } from '../panel/inteligencia.js';
import { SALES_SCHEMA } from '../../worker-sync/ml-sales.js';
import { importPurchases } from '../../worker-sync/purchases.js';
import { createSessionToken, deriveSessionSecret, sessionCookieHeader } from '../_shared/panel-auth.js';

function database(t) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  const statement = (sql, args = []) => ({ sql, args, bind(...values) { return statement(sql, values); }, async first() { return sqlite.prepare(sql).get(...args) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; }, async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; } });
  return { prepare: sql => statement(sql), async batch(items) { sqlite.exec('BEGIN'); try { const r = items.map(s => ({ results: sqlite.prepare(s.sql).all(...s.args) })); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }, sqlite };
}

const NOW = Date.parse('2026-10-24T12:00:00Z');
const A = '9780306406157', B = '9788420412146', C = '9781418599942', D = '9780997419900';
const catalog = { updated_at: '2026-10-24T10:00:00Z', items: [
  { id: 'MLU1', isbn: A, title: 'Libro A', publisher: 'Planeta', status: 'active', available_quantity: 0, start_time: '2025-01-01T00:00:00Z' },
  { id: 'MLU2', isbn: B, title: 'Libro B', publisher: 'Paidós', status: 'active', available_quantity: 1, start_time: '2025-01-01T00:00:00Z' },
  { id: 'MLU3', isbn: C, title: 'Libro C', publisher: 'Planeta', status: 'active', available_quantity: 5, start_time: '2025-01-01T00:00:00Z' },
  { id: 'MLU4', isbn: D, title: 'Libro D sin ventas', publisher: 'Otra', status: 'active', available_quantity: 3, start_time: '2025-01-01T00:00:00Z' },
] };

async function seed(t) {
  const db = database(t);
  await db.batch(SALES_SCHEMA.map(sql => db.prepare(sql)));
  let id = 0;
  const sale = (isbn, daysAgo, qty, price, sku = null) => {
    id++;
    db.sqlite.prepare('INSERT INTO ml_sales_orders(order_id,seller_id,status,date_created,date_created_ms,last_updated_ms,fetched_at) VALUES(?,?,?,?,?,?,0)').run(String(id), '440298103', 'paid', new Date(NOW - daysAgo * 864e5).toISOString(), NOW - daysAgo * 864e5, NOW);
    db.sqlite.prepare('INSERT INTO ml_sales_items(order_id,line_key,item_id,title,quantity,unit_price,currency_id,isbn,seller_sku,updated_at) VALUES(?,?,?,?,?,?,?,?,?,0)').run(String(id), 'a', 'MLU' + id, 'x', qty, price, 'UYU', isbn, sku);
  };
  // A: el más vendido (sin stock). B: vende y tiene 1. C: poco. Una venta por encargo.
  for (let d = 1; d <= 60; d += 3) sale(A, d, 2, 1000);
  sale(A, 200, 5, 1000);
  for (let d = 2; d <= 50; d += 10) sale(B, d, 1, 800);
  sale(C, 100, 1, 500);
  sale(B, 5, 1, 800, `AMADO-AR-${B}`);
  await importPurchases(db, { supplier: 'Celesa', document_type: 'invoice', document_number: 'F1', document_date: new Date(NOW - 40 * 864e5).toISOString().slice(0, 10), items: [{ isbn: A, title: 'Libro A', quantity: 4 }, { isbn: C, title: 'Libro C', quantity: 3 }] }, NOW);
  return db;
}

test('inteligencia: KPIs, tendencia, ABC, inventario, compras y editoriales con datos de prueba', async t => {
  const db = await seed(t);
  const bi = await loadBi(db, catalog, NOW);
  assert.ok(bi.kpis.ok, bi.kpis.error);
  assert.equal(bi.kpis.data.u7, 3 * 2 + 1 + 1); // A: días 1, 4 y 7 (2 c/u); B: día 2; encargo B: día 5
  assert.equal(bi.kpis.data.encargoPct30 > 0, true);
  assert.equal(bi.weekly.data.length, 26);
  assert.equal(bi.weekly.data.reduce((n, w) => n + w.units, 0) > 0, true);
  assert.equal(bi.abc.data.sorted[0].isbn, A);
  assert.equal(bi.abc.data.sorted[0].clase, 'A');
  assert.equal(bi.inventario.data.aSinStockCount, 1);
  assert.equal(bi.inventario.data.aSinStock[0].isbn, A);
  assert.equal(bi.inventario.data.muertoCount, 1, 'D: con stock y sin ventas (C vendió hace 100 días)');
  assert.equal(bi.inventario.data.muerto[0].isbn, D);
  const celesa = bi.compras.data.suppliers.find(s => s.supplier === 'CELESA');
  assert.equal(celesa.bought, 7);
  assert.equal(celesa.sold, 4, 'A vendió más de 4 desde la compra; C no vendió');
  assert.equal(celesa.sinVenta, 1);
  assert.equal(bi.editoriales.data[0].publisher, 'Planeta');
  assert.equal(bi.competencia.ok, false, 'sin tablas de competencia en el entorno de prueba el bloque falla solo');
  const html = renderBi(bi);
  for (const h of ['Cómo va el negocio', 'Tendencia semanal', 'Qué libros hacen la plata', 'Dónde se pierde plata', 'Cómo rinden las compras', 'Editoriales', 'competencia']) assert.match(html, new RegExp(h));
  assert.match(html, /No se pudo calcular este bloque/);
  assert.ok(!/<script/i.test(html));
});

test('ABC: el primero siempre es A y las clases suman el total', () => {
  const r = abc([{ isbn: 'x', rev365: 900 }, { isbn: 'y', rev365: 50 }, { isbn: 'z', rev365: 50 }]);
  assert.equal(r.A + r.B + r.C, 3);
  assert.equal(r.sorted[0].clase, 'A');
});

test('panel de inteligencia exige sesión y producción', async t => {
  const db = await seed(t);
  const env = { APP_ENV: 'production', PANEL_PASSWORD: 'una-clave-larga', ORDERS_DB: db };
  const panel = createBiPanel({ loader: (d) => loadBi(d, catalog, NOW) });
  assert.equal((await panel({ request: new Request('https://www.amadolibros.com/panel/inteligencia'), env })).status, 303);
  const cookie = sessionCookieHeader(await createSessionToken(await deriveSessionSecret(env.PANEL_PASSWORD))).split(';')[0];
  const res = await panel({ request: new Request('https://www.amadolibros.com/panel/inteligencia', { headers: { cookie } }), env });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Inteligencia del negocio/);
});
