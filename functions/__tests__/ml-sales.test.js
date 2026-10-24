import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createMlSales, bookIsbn, resolveIdentity, salesByIsbn, salesByTitle, salesStatus, handleSalesRoute, salesChannel } from '../../worker-sync/ml-sales.js';

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
  MLU4: { id: 'MLU4', seller_id: 440298103, title: 'Encargo', seller_custom_field: `AMADO-AR-${ISBN}`, attributes: [] },
};

// ML simulado con semántica real: filtra por fecha de creación y sólo por los
// parámetros de "actualización" listados en honored; ignora los demás.
function fakeMl(store, { honored = [], items = ITEMS, calls = [] } = {}) {
  return async url => {
    const u = new URL(String(url)); calls.push(u.pathname + u.search);
    if (u.pathname === '/orders/search') {
      assert.equal(u.searchParams.get('seller'), '440298103');
      let rows = [...store.orders];
      const from = u.searchParams.get('order.date_created.from');
      if (from) rows = rows.filter(o => Date.parse(o.date_created) >= Date.parse(from));
      for (const name of honored) { const v = u.searchParams.get(name); if (v) rows = rows.filter(o => Date.parse(o.last_updated) >= Date.parse(v)); }
      rows.sort((a, b) => Date.parse(a.date_created) - Date.parse(b.date_created) || a.id - b.id);
      if (u.searchParams.get('sort') === 'date_desc') rows.reverse();
      const offset = Number(u.searchParams.get('offset') || 0), limit = Number(u.searchParams.get('limit') || 50);
      return Response.json({ results: rows.slice(offset, offset + limit), paging: { total: rows.length } });
    }
    if (u.pathname === '/items/bulk') return Response.json(u.searchParams.get('ids').split(',').map(id => items[id] ? { status_code: 200, body: items[id] } : { status_code: 404 }));
    if (u.pathname === '/products/MLU999') return Response.json({ id: 'MLU999', attributes: [{ id: 'GTIN', value_name: ISBN }] });
    return new Response('nope', { status: 404 });
  };
}
const service = (store, opts = {}, clock = () => NOW) => createMlSales({ fetcher: fakeMl(store, opts), tokenProvider: async () => 'tok', now: clock });

test('bookIsbn exige 978/979 válido y convierte ISBN-10; canal por SKU', () => {
  assert.equal(bookIsbn('0-306-40615-2'), ISBN);
  assert.equal(bookIsbn('9780306406158'), null);
  assert.equal(bookIsbn('7790001000010'), null);
  assert.equal(salesChannel(`AMADO-AR-${ISBN}`), 'encargo');
  assert.equal(salesChannel('ABC'), 'propio');
});

test('identidad: SKU AMADO-AR primero, luego atributos y producto de catálogo', () => {
  assert.equal(resolveIdentity({ itemId: 'MLU9', sellerSku: `AMADO-AR-${ISBN2}`, item: ITEMS.MLU1 }).source, 'sku');
  assert.equal(resolveIdentity({ itemId: 'MLU1', item: { attributes: [{ id: 'EAN', value_name: `123, ${ISBN}` }] } }).isbn, ISBN);
  assert.equal(resolveIdentity({ itemId: 'MLU3', item: ITEMS.MLU3 }).source, 'none');
});

test('backfill: suma publicaciones, separa propio/encargo y no duplica al re-ejecutar', async t => {
  const db = database(t), env = { ORDERS_DB: db };
  const store = { orders: [
    order(1, 10, 'paid', [['MLU1', 2]]),
    order(2, 100, 'paid', [['MLU2', 1, 'Libro: El libro']]),
    order(3, 5, 'cancelled', [['MLU1', 4]]),
    order(4, 400, 'paid', [['MLU3', 1, 'Sin código']]),
    order(5, 20, 'paid', [['MLU4', 3, 'Encargo', `AMADO-AR-${ISBN}`]]),
  ] };
  assert.equal((await service(store).sync(env, { pages: 5 })).state, 'backfill_complete');
  await service(store).sync(env, { pages: 5, mode: 'backfill' });
  const status = await salesStatus(db);
  assert.equal(status.orders, 5);
  assert.equal(status.lines_title_only, 1);
  const [r] = await salesByIsbn(db, ['0306406152'], NOW);
  assert.equal(r.ventas_30d, 5);
  assert.equal(r.ventas_propio_30d, 2);
  assert.equal(r.ventas_encargo_30d, 3);
  assert.equal(r.ventas_180d, 6);
  assert.equal(r.unidades_canceladas, 4);
  assert.deepEqual(r.item_ids, ['MLU1', 'MLU2', 'MLU4']);
  assert.equal(r.ventana_365d_completa, true);
  const byTitle = await salesByTitle(db, 'sin codigo', NOW);
  assert.equal(byTitle[0].identificado_por, 'titulo');
});

test('filtro respetado por ML: el sondeo lo elige y una cancelación de una orden vieja entra', async t => {
  const db = database(t), env = { ORDERS_DB: db };
  const store = { orders: [order(1, 200, 'paid', [['MLU1', 1]]), order(2, 2, 'paid', [['MLU1', 1]])] };
  let clock = NOW;
  const s = () => service(store, { honored: ['order.date_last_updated.from'] }, () => clock);
  await s().sync(env, { pages: 5 });
  clock += 3600000;
  await s().sync(env, { pages: 10 });
  assert.equal((await salesStatus(db)).cursor.inc_filter.name, 'order.date_last_updated.from');
  store.orders[0] = { ...store.orders[0], status: 'cancelled', last_updated: new Date(clock).toISOString() };
  clock += 2 * 3600000;
  const r = await s().sync(env, { pages: 10 });
  assert.match(r.state, /incremental/);
  assert.equal((await salesByIsbn(db, [ISBN], clock))[0].unidades_canceladas, 1);
});

test('filtro ignorado por ML: queda sin filtro y el barrido semanal igual corrige el estado', async t => {
  const db = database(t), env = { ORDERS_DB: db };
  const store = { orders: [order(1, 200, 'paid', [['MLU1', 1]])] };
  let clock = NOW;
  const s = () => service(store, { honored: [] }, () => clock);
  await s().sync(env, { pages: 5 });
  store.orders[0] = { ...store.orders[0], status: 'cancelled', last_updated: new Date(clock).toISOString() };
  clock += 3600000;
  const r = await s().sync(env, { pages: 10 });
  const st = await salesStatus(db);
  assert.equal(st.cursor.inc_filter.name, null);
  assert.equal(st.cursor.inc_filter.reason, 'ignored_by_ml');
  assert.match(r.state, /sweep/);
  assert.equal((await salesByIsbn(db, [ISBN], clock))[0].unidades_canceladas, 1);
});

test('el barrido detecta que el filtro perdió una actualización y lo desactiva', async t => {
  const db = database(t), env = { ORDERS_DB: db };
  const store = { orders: [order(1, 200, 'paid', [['MLU1', 1]]), order(2, 100, 'paid', [['MLU1', 1]])] };
  let clock = NOW;
  // El sondeo pasa (filtra), pero el filtro "pierde" la orden 1.
  const lossy = async url => {
    const u = new URL(String(url));
    if (u.pathname === '/orders/search' && u.searchParams.get('order.date_last_updated.from')) {
      const since = Date.parse(u.searchParams.get('order.date_last_updated.from'));
      const rows = store.orders.filter(o => o.id !== 1 && Date.parse(o.last_updated) >= since);
      return Response.json({ results: rows, paging: { total: rows.length } });
    }
    return fakeMl(store)(url);
  };
  const s = () => createMlSales({ fetcher: lossy, tokenProvider: async () => 'tok', now: () => clock });
  await s().sync(env, { pages: 5 });
  clock += 3600000;
  await s().sync(env, { pages: 10 }); // sondeo + barrido inicial
  store.orders[0] = { ...store.orders[0], status: 'cancelled', last_updated: new Date(clock + 60000).toISOString() };
  clock += 3 * 3600000;
  await s().sync(env, { pages: 10 }); // incremental "completo" pero sin la orden 1
  clock += 8 * 86400000;
  await s().sync(env, { pages: 20, mode: 'sweep' });
  const st = await salesStatus(db);
  assert.equal(st.cursor.sweep_missed, 1);
  assert.equal(st.cursor.inc_filter.reason, 'sweep_missed');
});

test('un estado viejo no pisa uno nuevo y una publicación reciclada no mueve la historia', async t => {
  const db = database(t), env = { ORDERS_DB: db };
  const store = { orders: [order(1, 3, 'cancelled', [['MLU1', 1]], { last_updated: day(1) })] };
  await service(store).sync(env, { pages: 2, mode: 'backfill' });
  store.orders = [order(1, 3, 'paid', [['MLU1', 1]], { last_updated: day(2) })];
  await service(store).sync(env, { pages: 2, mode: 'backfill' });
  assert.equal((await salesByIsbn(db, [ISBN], NOW))[0].ventas_30d, 0);
  // MLU1 pasa a ser otro libro: las líneas viejas siguen con el ISBN original.
  const recycled = { ...ITEMS, MLU1: { ...ITEMS.MLU1, attributes: [{ id: 'GTIN', value_name: ISBN2 }] } };
  db.sqlite.prepare("UPDATE ml_sales_item_identity SET checked_at=0").run();
  store.orders = [order(1, 3, 'cancelled', [['MLU1', 1]], { last_updated: day(1) }), order(2, 1, 'paid', [['MLU1', 1]])];
  await createMlSales({ fetcher: fakeMl(store, { items: recycled }), tokenProvider: async () => 'tok', now: () => NOW }).sync(env, { pages: 2, mode: 'backfill' });
  const rows = db.sqlite.prepare('SELECT order_id,isbn FROM ml_sales_items ORDER BY order_id').all().map(r => `${r.order_id}:${r.isbn}`);
  assert.deepEqual(rows, [`1:${ISBN}`, `2:${ISBN2}`]);
});

test('sin cupo de /products queda pending_product y reidentify lo resuelve', async t => {
  const db = database(t), env = { ORDERS_DB: db };
  const store = { orders: Array.from({ length: 27 }, (_, i) => order(10 + i, 5, 'paid', [[`MLU${100 + i}`, 1]])) };
  const items = Object.fromEntries(store.orders.map(o => { const id = o.order_items[0].item.id; return [id, { id, seller_id: 440298103, title: 't', catalog_product_id: 'MLU999', attributes: [] }]; }));
  const s = createMlSales({ fetcher: fakeMl(store, { items }), tokenProvider: async () => 'tok', now: () => NOW });
  await s.sync(env, { pages: 5 });
  const pending = db.sqlite.prepare("SELECT COUNT(*) AS n FROM ml_sales_item_identity WHERE source='pending_product'").get().n;
  assert.equal(pending, 2);
  const out = await s.reidentify(env, { limit: 100 });
  assert.equal(out.resolved, 2);
  assert.equal(out.remaining_items_without_isbn, 0);
});

test('lease: una corrida que perdió el lease no pisa el cursor; 429 activa backoff', async t => {
  const db = database(t), env = { ORDERS_DB: db };
  const store = { orders: [order(1, 3, 'paid', [['MLU1', 1]])] };
  let clock = NOW;
  const slow = async url => { if (String(url).includes('/orders/search')) db.sqlite.prepare("UPDATE ml_sales_sync_state SET lease_until=?").run(clock + 999999); return fakeMl(store)(url); };
  const r = await createMlSales({ fetcher: slow, tokenProvider: async () => 'tok', now: () => clock }).sync(env, { pages: 1 });
  assert.equal(r.state, 'lease_lost');
  assert.equal((await salesStatus(db)).cursor.phase, 'backfill');
  db.sqlite.prepare("UPDATE ml_sales_sync_state SET lease_until=0").run();
  const limited = async () => new Response('slow down', { status: 429, headers: { 'Retry-After': '60' } });
  const e = await createMlSales({ fetcher: limited, tokenProvider: async () => 'tok', now: () => clock }).sync(env, { pages: 1 });
  assert.equal(e.state, 'error');
  assert.equal(e.errors_in_row, 1);
  assert.equal((await createMlSales({ fetcher: limited, tokenProvider: async () => 'tok', now: () => clock + 1000 }).sync(env, { pages: 1 })).state, 'backoff');
});

test('rutas: valida 1..50 ISBN e informa ISBN inválidos sin fallar', async t => {
  const db = database(t), env = { ORDERS_DB: db };
  const svc = service({ orders: [] });
  const post = (path, body) => handleSalesRoute(new Request('https://w.test' + path, { method: 'POST', body: JSON.stringify(body) }), env, svc);
  assert.equal((await post('/sales/query', { isbns: [] })).status, 400);
  const data = await (await post('/sales/query', { isbns: [ISBN, 'xx'] })).json();
  assert.equal(data.resultados[0].unidades_totales, 0);
  assert.equal(data.resultados[1].error, 'invalid_isbn');
});
