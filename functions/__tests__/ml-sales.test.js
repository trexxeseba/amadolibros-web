import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createMlSales, bookIsbn, resolveIdentity, salesByIsbn, salesByTitle, salesStatus, handleSalesRoute } from '../../worker-sync/ml-sales.js';

function database(t) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  const statement = (sql, args = []) => ({ sql, args, bind(...values) { return statement(sql, values); }, async first() { return sqlite.prepare(sql).get(...args) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; }, async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; } });
  return { prepare: sql => statement(sql), async batch(items) { sqlite.exec('BEGIN'); try { const r = items.map(s => ({ results: sqlite.prepare(s.sql).all(...s.args) })); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }, sqlite };
}

const NOW = Date.parse('2026-10-24T12:00:00Z');
const ISBN = '9780306406157', ISBN2 = '9788420412146';
const day = n => new Date(NOW - n * 86400000).toISOString().replace('Z', '-00:00');
const order = (id, daysAgo, status, items, extra = {}) => ({ id, status, date_created: day(daysAgo), last_updated: day(daysAgo), seller: { id: 440298103 }, currency_id: 'UYU', total_amount: 100,
  order_items: items.map(([itemId, qty, title = 'El libro', sku = null]) => ({ item: { id: itemId, title, seller_sku: sku, variation_id: null }, quantity: qty, unit_price: 50, currency_id: 'UYU' })), ...extra });

const ITEMS = {
  MLU1: { id: 'MLU1', seller_id: 440298103, title: 'El libro', attributes: [{ id: 'GTIN', value_name: ISBN }, { id: 'AUTHOR', value_name: 'Autor' }] },
  MLU2: { id: 'MLU2', seller_id: 440298103, title: 'Libro: El libro', catalog_product_id: 'MLU999', attributes: [] },
  MLU3: { id: 'MLU3', seller_id: 440298103, title: 'Sin código', attributes: [] },
};

function fakeMl(pages, calls = []) {
  return async (url) => {
    const u = new URL(String(url)); calls.push(u.pathname + u.search);
    if (u.pathname === '/orders/search') {
      assert.equal(u.searchParams.get('seller'), '440298103');
      const key = u.searchParams.has('order.last_updated.from') ? 'incremental' : `${u.searchParams.get('order.date_created.from')}|${u.searchParams.get('offset')}`;
      const results = pages[key] ?? pages.default ?? [];
      return Response.json({ results, paging: { total: results.length } });
    }
    if (u.pathname === '/items/bulk') return Response.json(u.searchParams.get('ids').split(',').map(id => ITEMS[id] ? { status_code: 200, body: ITEMS[id] } : { status_code: 404 }));
    if (u.pathname === '/products/MLU999') return Response.json({ id: 'MLU999', attributes: [{ id: 'GTIN', value_name: ISBN }] });
    return new Response('nope', { status: 404 });
  };
}

test('bookIsbn exige 978/979 válido y convierte ISBN-10', () => {
  assert.equal(bookIsbn('0-306-40615-2'), ISBN);
  assert.equal(bookIsbn('978-0-306-40615-7'), ISBN);
  assert.equal(bookIsbn('9780306406158'), null);
  assert.equal(bookIsbn('7790001000010'), null);
});

test('identidad: SKU AMADO-AR primero, luego atributos y producto de catálogo', () => {
  assert.equal(resolveIdentity({ itemId: 'MLU9', sellerSku: `AMADO-AR-${ISBN2}`, item: ITEMS.MLU1 }).source, 'sku');
  assert.equal(resolveIdentity({ itemId: 'MLU1', item: ITEMS.MLU1 }).isbn, ISBN);
  assert.equal(resolveIdentity({ itemId: 'MLU1', item: { attributes: [{ id: 'EAN', value_name: `123, ${ISBN}` }] } }).isbn, ISBN);
  assert.equal(resolveIdentity({ itemId: 'MLU3', item: ITEMS.MLU3 }).source, 'none');
});

test('backfill guarda órdenes, suma publicaciones duplicadas y no duplica al re-ejecutar', async t => {
  const db = database(t), calls = [];
  const pages = { default: [
    order(1, 10, 'paid', [['MLU1', 2]]),
    order(2, 100, 'paid', [['MLU2', 1, 'Libro: El libro']]),
    order(3, 5, 'cancelled', [['MLU1', 4]]),
    order(4, 400, 'paid', [['MLU3', 1, 'Sin código']]),
  ] };
  const sales = createMlSales({ fetcher: fakeMl(pages, calls), tokenProvider: async () => 'tok', now: () => NOW });
  const env = { ORDERS_DB: db };
  const first = await sales.sync(env, { pages: 5 });
  assert.equal(first.state, 'backfill_complete');
  assert.equal(first.orders, 4);
  await sales.sync(env, { pages: 5, mode: 'backfill' });
  const status = await salesStatus(db);
  assert.equal(status.orders, 4);
  assert.equal(status.lines, 4);
  assert.equal(status.lines_with_isbn, 3);
  assert.equal(status.lines_title_only, 1);
  assert.ok(calls.every(c => !c.includes('POST')));

  const [r] = await salesByIsbn(db, ['0306406152'], NOW);
  assert.equal(r.isbn, ISBN);
  assert.equal(r.ventas_30d, 2);
  assert.equal(r.ventas_90d, 2);
  assert.equal(r.ventas_180d, 3);
  assert.equal(r.unidades_totales, 3);
  assert.equal(r.unidades_canceladas, 4);
  assert.deepEqual(r.item_ids, ['MLU1', 'MLU2']);
  assert.equal(r.ultima_venta, day(10));

  const byTitle = await salesByTitle(db, 'sin codigo', NOW);
  assert.equal(byTitle.length, 1);
  assert.equal(byTitle[0].identificado_por, 'titulo');
  assert.equal(byTitle[0].ventas_365d, 0);
  assert.equal(byTitle[0].unidades_totales, 1);
});

test('una orden que pasa a cancelada deja de contar; un estado viejo no pisa uno nuevo', async t => {
  const db = database(t), env = { ORDERS_DB: db };
  const run = results => createMlSales({ fetcher: fakeMl({ default: results, incremental: results }), tokenProvider: async () => 'tok', now: () => NOW }).sync(env, { pages: 2, mode: 'backfill' });
  await run([order(1, 3, 'paid', [['MLU1', 1]], { last_updated: day(3) })]);
  assert.equal((await salesByIsbn(db, [ISBN], NOW))[0].ventas_30d, 1);
  await run([order(1, 3, 'cancelled', [['MLU1', 1]], { last_updated: day(1) })]);
  assert.equal((await salesByIsbn(db, [ISBN], NOW))[0].ventas_30d, 0);
  await run([order(1, 3, 'paid', [['MLU1', 1]], { last_updated: day(2) })]);
  assert.equal((await salesByIsbn(db, [ISBN], NOW))[0].ventas_30d, 0);
});

test('paginación del backfill avanza por fecha y termina con página incompleta', async t => {
  const db = database(t), env = { ORDERS_DB: db };
  const full = Array.from({ length: 50 }, (_, i) => order(100 + i, 60 - i, 'paid', [['MLU1', 1]]));
  const pages = { '2000-01-01T00:00:00.000-00:00|0': full, [`${full.at(-1).date_created}|0`]: [order(200, 1, 'paid', [['MLU1', 1]])] };
  const sales = createMlSales({ fetcher: fakeMl(pages), tokenProvider: async () => 'tok', now: () => NOW });
  const r = await sales.sync(env, { pages: 5 });
  assert.equal(r.state, 'backfill_complete');
  assert.equal(r.pages, 2);
  assert.equal((await salesStatus(db)).orders, 51);
  const inc = await sales.sync(env, { pages: 1, mode: 'incremental' });
  assert.equal(inc.state, 'incremental');
});

test('rutas: valida 1..50 ISBN e informa ISBN inválidos sin fallar', async t => {
  const db = database(t), env = { ORDERS_DB: db };
  const service = createMlSales({ fetcher: fakeMl({}), tokenProvider: async () => 'tok', now: () => NOW });
  const post = (path, body) => handleSalesRoute(new Request('https://w.test' + path, { method: 'POST', body: JSON.stringify(body) }), env, service);
  assert.equal((await post('/sales/query', { isbns: [] })).status, 400);
  assert.equal((await post('/sales/query', { isbns: Array(51).fill(ISBN) })).status, 400);
  const data = await (await post('/sales/query', { isbns: [ISBN, 'xx'] })).json();
  assert.equal(data.resultados[0].unidades_totales, 0);
  assert.equal(data.resultados[1].error, 'invalid_isbn');
  const status = await handleSalesRoute(new Request('https://w.test/sales/status'), env, service);
  assert.equal((await status.json()).cursor.phase, 'backfill');
});
