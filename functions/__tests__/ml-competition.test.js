import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createMlCompetition, competitionByIsbn, competitionEvents, competitionStatus, competitionCoverage, montevideoDate } from '../../worker-sync/ml-competition.js';
import { createReposicionFacts } from '../../worker-sync/reposicion-facts.js';
import { SALES_SCHEMA } from '../../worker-sync/ml-sales.js';
import { importPurchases } from '../../worker-sync/purchases.js';
import { readSalesHealth, evaluateSalesHealth } from '../../worker-sync/sales-health.js';

function database(t) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  const statement = (sql, args = []) => ({ sql, args, bind(...values) { return statement(sql, values); }, async first() { return sqlite.prepare(sql).get(...args) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; }, async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; } });
  return { prepare: sql => statement(sql), async batch(items) { sqlite.exec('BEGIN'); try { const r = items.map(s => ({ results: sqlite.prepare(s.sql).all(...s.args) })); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }, sqlite };
}

const ISBN = '9780306406157', OWN = '440298103';
const DAY1 = Date.parse('2026-10-24T15:00:00Z'), DAY2 = DAY1 + 86400000;
const catalog = { updated_at: '2026-10-24T10:00:00Z', items: [
  { id: 'MLU1', isbn: ISBN, status: 'active', available_quantity: 1, catalog_listing: false, catalog_product_id: 'MLU999', price: 1200 },
  { id: 'MLU2', isbn: ISBN, status: 'active', available_quantity: 1, catalog_listing: true, catalog_product_id: 'MLU999', price: 1200 },
] };

async function seed(t) {
  const db = database(t);
  await db.batch(SALES_SCHEMA.map(sql => db.prepare(sql)));
  for (const [id, days] of [[1, 10], [2, 40]]) {
    db.sqlite.prepare('INSERT INTO ml_sales_orders(order_id,seller_id,status,date_created,date_created_ms,last_updated_ms,fetched_at) VALUES(?,?,?,?,?,?,0)').run(String(id), OWN, 'paid', new Date(DAY1 - days * 864e5).toISOString(), DAY1 - days * 864e5, DAY1);
    db.sqlite.prepare('INSERT INTO ml_sales_items(order_id,line_key,item_id,title,quantity,isbn,updated_at) VALUES(?,?,?,?,?,?,0)').run(String(id), 'a', 'MLU1', 'El libro', 1, ISBN);
  }
  return db;
}

// Mercado Libre simulado: el día cambia quién vende y el primer lugar.
function fakeMl(state) {
  return async url => {
    const u = new URL(String(url));
    if (state.closed) return new Response('forbidden', { status: 403 });
    // Usado más barato (44), del exterior (55) y uno sin condición en el listado (MLUC, se completa con /items/bulk).
    const noise = [{ item_id: 'MLUU', seller_id: 44, price: 300, condition: 'used' }, { item_id: 'MLUX', seller_id: 55, price: 400, condition: 'new', international_delivery_mode: 'cbt' }];
    if (u.pathname === '/products/MLU999/items') return Response.json({ results: state.day === 1
      ? [{ item_id: 'MLU2', seller_id: Number(OWN), price: 1200, condition: 'new' }, { item_id: 'MLUA', seller_id: 11, price: 1000, condition: 'new', shipping: { free_shipping: true, logistic_type: 'fulfillment' } }, { item_id: 'MLUB', seller_id: 22, price: 1100, condition: 'new' }, { item_id: 'MLUP', seller_id: 77, price: 500, condition: 'new' }, ...noise]
      : [{ item_id: 'MLU2', seller_id: Number(OWN), price: 1200, condition: 'new' }, { item_id: 'MLUA', seller_id: 11, price: 900, condition: 'new' }, { item_id: 'MLUC', seller_id: 33, price: 950 }, { item_id: 'MLUP', seller_id: 77, price: 500, condition: 'new' }, ...noise] });
    // MLUP vende a pedido (21 días): no compite con un libro en stock.
    if (u.pathname === '/items/bulk') return Response.json(u.searchParams.get('ids').split(',').map(id => ({ status_code: 200, body: { id, condition: 'new', international_delivery_mode: 'none', sale_terms: id === 'MLUP' ? [{ id: 'MANUFACTURING_TIME', value_name: '21 días', value_struct: { number: 21, unit: 'días' } }] : [{ id: 'WARRANTY_TYPE', value_name: 'Sin garantía' }] } })));
    if (u.pathname === '/items/MLU2/price_to_win') return Response.json(state.day === 1 ? { status: 'winning', price_to_win: 1200, winner: { item_id: 'MLU2' } } : { status: 'competing', price_to_win: 880, winner: { item_id: 'MLUA' } });
    const m = /^\/users\/(\d+)$/.exec(u.pathname);
    if (m) return Response.json({ id: Number(m[1]), nickname: `VENDEDOR${m[1]}`, seller_reputation: { transactions: { completed: m[1] === '22' ? (state.day === 1 ? 100 : 105) : 50 } } });
    return new Response('nope', { status: 404 });
  };
}

async function runDay(db, state, nowMs) {
  const comp = createMlCompetition({ fetcher: fakeMl(state), tokenProvider: async () => 'tok', now: () => nowMs, loadCatalog: async () => catalog });
  let r;
  for (let i = 0; i < 5; i++) { r = await comp.sync({ ORDERS_DB: db }, { calls: 50 }); if (r.state === 'done' || r.state === 'error' || r.state === 'products_endpoint_unavailable') break; }
  return r;
}

test('foto diaria: competidores, primer lugar perdido, competidor que dejó de ofrecer (probable venta), nuevo y precio arriba', async t => {
  const db = await seed(t);
  const state = { day: 1 };
  assert.equal((await runDay(db, state, DAY1)).state, 'done');
  state.day = 2;
  assert.equal((await runDay(db, state, DAY2)).state, 'done');
  const f = (await competitionByIsbn(db, [ISBN], DAY2)).get(ISBN);
  assert.equal(f.foto, montevideoDate(DAY2));
  assert.equal(f.competidores, 5);
  assert.equal(f.competidores_comparables, 2, 'usado, del exterior y a pedido quedan afuera');
  assert.equal(f.excluidos_de_precio, 3);
  assert.equal(f.precio_minimo, 900, 'el de $500 vende a pedido: no cuenta');
  assert.equal(f.competidores_a_pedido, 1);
  assert.equal(f.precio_minimo_a_pedido, 500);
  assert.equal(f.vendedores.find(v => v.vendedor === 'VENDEDOR77').dias_preparacion, 21);
  assert.equal(f.primer_lugar, 'competing');
  const tipos = f.avisos.map(a => a.tipo).sort();
  assert.deepEqual(tipos, ['competidor_nuevo', 'competidor_sin_stock', 'precio_arriba', 'primer_lugar_perdido'].sort());
  // La venta nunca se afirma: el contador es de toda la cuenta del vendedor.
  const sinStock = f.avisos.find(a => a.tipo === 'competidor_sin_stock');
  assert.equal(sinStock.etiqueta, 'estimado');
  assert.match(sinStock.texto, /VENDEDOR22 dejó de ofrecer.*estimado: su contador de ventas subió 5; puede ser cualquier otro libro/);
  assert.doesNotMatch(sinStock.texto, /probablemente lo vendió/);
  assert.equal(f.foto_completa, true);
  assert.equal(f.foto_edad_horas, 0);
  assert.equal(f.captura_posterior, null);
  assert.deepEqual(f.listado, { total: 6, leidos: 6, sin_detalle: 0 });
  assert.equal(f.etiquetas.ventas_competidor, 'desconocido');
  assert.match(f.avisos.find(a => a.tipo === 'primer_lugar_perdido').texto, /\$ 880/);
  assert.match(f.avisos.find(a => a.tipo === 'precio_arriba').texto, /33% arriba del más barato con entrega inmediata sin envío gratis/);
  const ev = await competitionEvents(db, { limit: 10 });
  assert.equal(ev.vigilados, 1);
  assert.equal(ev.eventos[0].tipo, 'primer_lugar_perdido');
  // Re-ejecutar el mismo día no duplica la foto.
  await runDay(db, state, DAY2 + 3600000);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM comp_snapshots WHERE snap_date=?').get(montevideoDate(DAY2)).n, 6);
  assert.equal(db.sqlite.prepare("SELECT condition FROM comp_snapshots WHERE item_id='MLUC'").get().condition, 'new', 'condición completada con /items/bulk');
  // Cada corrida con trabajo queda registrada con cupo usado y resultado por ficha.
  const runs = db.sqlite.prepare('SELECT * FROM comp_runs ORDER BY id').all();
  assert.ok(runs.length >= 2);
  assert.ok(runs.every(r => r.calls_used > 0 && r.products_ok + r.products_partial + r.products_error === r.products));
  const cov = await competitionCoverage(db, catalog, DAY2 + 3600000);
  assert.equal(cov.vigilados, 1);
  assert.equal(cov.segmentos.ventas_propias.hoy_completas, 1);
  assert.equal(cov.segmentos.ventas_propias.pendientes_hoy, 0);
  assert.equal(cov.catalogo.con_ficha_vigilados, 1);
  assert.equal(cov.catalogo.con_ficha_sin_vigilar, 0);
  assert.ok(cov.corridas_hoy.llamadas > 0);
});

// Mercado Libre paginado: la ficha dice que hay 3 vendedores y la segunda página
// falla (o no llega). La foto queda parcial y no reemplaza a la última completa.
function pagedMl({ total, secondPageFails = false, secondPage = [], sellersDelta = 0, usd = false, bulkFails = false }) {
  return async url => {
    const u = new URL(String(url));
    if (u.pathname === '/products/MLU999/items') {
      const offset = Number(u.searchParams.get('offset') || 0);
      if (offset > 0) return secondPageFails ? new Response('boom', { status: 500 }) : Response.json({ paging: { total, offset, limit: 2 }, results: secondPage });
      return Response.json({ paging: { total, offset: 0, limit: 2 }, results: [{ item_id: 'MLU2', seller_id: Number(OWN), price: 1200, currency_id: 'UYU', condition: 'new' }, { item_id: 'MLUA', seller_id: 11, price: usd ? 20 : 1000, currency_id: usd ? 'USD' : 'UYU', condition: 'new' }] });
    }
    if (u.pathname === '/items/bulk') { if (bulkFails) return new Response('boom', { status: 500 }); return Response.json(u.searchParams.get('ids').split(',').map(id => ({ status_code: 200, body: { id, condition: 'new', international_delivery_mode: 'none', sale_terms: [] } }))); }
    if (u.pathname === '/items/MLU2/price_to_win') return Response.json({ status: 'competing', price_to_win: 990, winner: { item_id: 'MLUA' } });
    const m = /^\/users\/(\d+)$/.exec(u.pathname);
    if (m) return Response.json({ id: Number(m[1]), nickname: `VENDEDOR${m[1]}`, seller_reputation: { transactions: { completed: 50 + sellersDelta } } });
    return new Response('nope', { status: 404 });
  };
}
async function runWith(db, fetcher, nowMs, calls = 50) {
  const comp = createMlCompetition({ fetcher, tokenProvider: async () => 'tok', now: () => nowMs, loadCatalog: async () => catalog });
  let r;
  for (let i = 0; i < 6; i++) { r = await comp.sync({ ORDERS_DB: db }, { calls }); if (['done', 'error', 'products_endpoint_unavailable', 'idle'].includes(r.state)) break; }
  return r;
}

test('foto parcial: una página que falta nunca equivale a que un competidor se fue; se conserva la última foto completa y se muestra su edad', async t => {
  const db = await seed(t);
  const DAY3 = DAY2 + 86400000;
  // Día 1 completo con 3 vendedores (dos páginas).
  assert.equal((await runWith(db, pagedMl({ total: 3, secondPage: [{ item_id: 'MLUB', seller_id: 22, price: 1100, currency_id: 'UYU', condition: 'new' }] }), DAY1)).state, 'done');
  let f = (await competitionByIsbn(db, [ISBN], DAY1)).get(ISBN);
  assert.equal(f.competidores, 2);
  assert.deepEqual(f.listado, { total: 3, leidos: 3, sin_detalle: 0 });
  // Día 2: la segunda página falla → parcial. No hay aviso de "dejó de ofrecer".
  assert.equal((await runWith(db, pagedMl({ total: 3, secondPageFails: true }), DAY2)).state, 'done');
  assert.equal(db.sqlite.prepare('SELECT status,items_total,items_fetched,code FROM comp_product_days WHERE snap_date=?').get(montevideoDate(DAY2)).status, 'partial');
  f = (await competitionByIsbn(db, [ISBN], DAY2 + 5 * 3600000)).get(ISBN);
  assert.equal(f.foto, montevideoDate(DAY1), 'sigue valiendo la última foto completa');
  assert.equal(f.foto_edad_horas, 29);
  assert.deepEqual(f.captura_posterior, { estado: 'parcial', fecha: montevideoDate(DAY2), leidos: 2, total: 3, codigo: 'ml_http_500' });
  assert.ok(!f.avisos.some(a => a.tipo === 'competidor_sin_stock'));
  const cov = await competitionCoverage(db, catalog, DAY2 + 5 * 3600000);
  assert.equal(cov.segmentos.ventas_propias.hoy_parciales, 1);
  assert.equal(cov.segmentos.ventas_propias.foto_completa_mas_vieja, montevideoDate(DAY1));
  assert.equal(cov.corridas_hoy.parciales, 1);
  // Día 3: completo otra vez y VENDEDOR22 ya no está → ahora sí, contra la foto completa del día 1,
  // y como "observado" porque su contador no subió.
  assert.equal((await runWith(db, pagedMl({ total: 3, secondPage: [{ item_id: 'MLUC', seller_id: 33, price: 1050, currency_id: 'UYU', condition: 'new' }] }), DAY3)).state, 'done');
  f = (await competitionByIsbn(db, [ISBN], DAY3)).get(ISBN);
  assert.equal(f.foto, montevideoDate(DAY3));
  assert.equal(f.foto_anterior, montevideoDate(DAY1));
  const fue = f.avisos.find(a => a.tipo === 'competidor_sin_stock');
  assert.equal(fue.etiqueta, 'observado');
  assert.match(fue.texto, /VENDEDOR22 dejó de ofrecer este libro en el catálogo\.$/);
  assert.ok(f.avisos.some(a => a.tipo === 'competidor_nuevo' && /VENDEDOR33/.test(a.texto)), 'reaparición/alta de un vendedor se ve como nuevo');
  // Día 4: VENDEDOR22 vuelve → competidor nuevo otra vez, sin inventar ventas en el medio.
  const DAY4 = DAY3 + 86400000;
  assert.equal((await runWith(db, pagedMl({ total: 3, secondPage: [{ item_id: 'MLUB', seller_id: 22, price: 1100, currency_id: 'UYU', condition: 'new' }] }), DAY4)).state, 'done');
  f = (await competitionByIsbn(db, [ISBN], DAY4)).get(ISBN);
  assert.ok(f.avisos.some(a => a.tipo === 'competidor_nuevo' && /VENDEDOR22/.test(a.texto)));
});

test('captura en curso: una ficha que todavía no se leyó hoy sigue mostrando su última foto completa', async t => {
  const db = await seed(t);
  assert.equal((await runWith(db, pagedMl({ total: 2 }), DAY1)).state, 'done');
  // Día 2 arranca (rearma objetivos) pero sin cupo para leer la ficha.
  const comp = createMlCompetition({ fetcher: pagedMl({ total: 2 }), tokenProvider: async () => 'tok', now: () => DAY2, loadCatalog: async () => catalog });
  const r = await comp.sync({ ORDERS_DB: db }, { calls: 0 });
  assert.equal(r.targets, 1);
  const f = (await competitionByIsbn(db, [ISBN], DAY2)).get(ISBN);
  assert.equal(f.foto, montevideoDate(DAY1));
  assert.equal(f.captura_posterior, null);
  const cov = await competitionCoverage(db, catalog, DAY2);
  assert.equal(cov.segmentos.ventas_propias.pendientes_hoy, 1);
  assert.equal(cov.fase, 'products');
});

test('moneda distinta y datos desconocidos no entran en el precio comparable', async t => {
  const db = await seed(t);
  assert.equal((await runWith(db, pagedMl({ total: 3, usd: true, secondPage: [{ item_id: 'MLUB', seller_id: 22, price: 1100, currency_id: 'UYU', condition: 'new' }] }), DAY1)).state, 'done');
  let f = (await competitionByIsbn(db, [ISBN], DAY1)).get(ISBN);
  assert.equal(f.competidores, 2);
  assert.equal(f.otra_moneda, 1, 'el de USD 20 no se compara con pesos');
  assert.equal(f.competidores_comparables, 1);
  assert.equal(f.precio_minimo, 1100);
  // Sin /items/bulk no se sabe el plazo de entrega: desconocido, no "inmediato".
  const db2 = await seed(t);
  assert.equal((await runWith(db2, pagedMl({ total: 2, bulkFails: true }), DAY1)).state, 'done');
  f = (await competitionByIsbn(db2, [ISBN], DAY1)).get(ISBN);
  assert.equal(f.competidores, 1);
  assert.equal(f.desconocidos, 1);
  assert.equal(f.competidores_comparables, 0);
  assert.equal(f.precio_minimo, null);
  assert.equal(f.etiquetas.precio_minimo, 'desconocido');
  assert.equal(f.listado.sin_detalle, 1);
  assert.ok(!f.avisos.some(a => a.tipo === 'solos_en_catalogo'), 'un competidor sin datos no es "estás solo"');
});

test('si ML cierra el endpoint se detiene, lo registra y Salud lo muestra', async t => {
  const db = await seed(t);
  const r = await runDay(db, { day: 1, closed: true }, DAY1);
  assert.equal(r.state, 'products_endpoint_unavailable');
  const st = await competitionStatus(db);
  assert.equal(st.cursor.caps.products_items, 'ml_http_403');
  const salud = evaluateSalesHealth(await readSalesHealth(db), DAY1);
  assert.ok(salud.problemas.some(p => /no deja leer los competidores/.test(p)));
  assert.ok(salud.notas.some(n => /Competencia: 1 productos vigilados/.test(n)));
});

test('hechos de reposición: aviso anti-doble compra y competencia por libro', async t => {
  const db = await seed(t);
  const state = { day: 1 };
  await runDay(db, state, DAY1); state.day = 2; await runDay(db, state, DAY2);
  await importPurchases(db, { supplier: 'Celesa', document_type: 'invoice', document_number: 'FF-1', document_date: new Date(DAY2 - 9 * 864e5).toISOString().slice(0, 10), items: [{ isbn: ISBN, title: 'El libro', quantity: 2 }] }, DAY2);
  const facts = createReposicionFacts({ now: () => DAY2, loadCatalog: async () => catalog });
  const r = (await facts.facts(db, [ISBN])).resultados[0];
  assert.equal(r.avisos[0].tipo, 'compra_reciente');
  assert.match(r.avisos[0].texto, /^Compraste 2 hace 9 días \(CELESA\): puede estar en camino\.$/);
  assert.equal(r.competencia.competidores, 5);
  assert.ok(r.avisos.some(a => a.tipo === 'primer_lugar_perdido'));
});

test('libro agotado que ya no está en el catálogo: se vigila por el producto de catálogo de sus ventas', async t => {
  const db = await seed(t);
  const GONE = '9788420412146';
  db.sqlite.prepare('INSERT INTO ml_sales_orders(order_id,seller_id,status,date_created,date_created_ms,last_updated_ms,fetched_at) VALUES(?,?,?,?,?,?,0)').run('9', OWN, 'paid', new Date(DAY1 - 5 * 864e5).toISOString(), DAY1 - 5 * 864e5, DAY1);
  db.sqlite.prepare('INSERT INTO ml_sales_items(order_id,line_key,item_id,title,quantity,isbn,updated_at) VALUES(?,?,?,?,?,?,0)').run('9', 'a', 'MLU77', 'Agotado', 3, GONE);
  db.sqlite.prepare("INSERT INTO ml_sales_item_identity(item_id,isbn,source,catalog_product_id,checked_at) VALUES('MLU77',?,'attr','mlu555',0)").run(GONE);
  const state = { day: 1 };
  const base = fakeMl(state);
  const comp = createMlCompetition({ fetcher: async url => new URL(String(url)).pathname === '/products/MLU555/items' ? Response.json({ results: [{ item_id: 'MLUZ', seller_id: 66, price: 700, condition: 'new' }] }) : base(url), tokenProvider: async () => 'tok', now: () => DAY1, loadCatalog: async () => catalog });
  for (let i = 0; i < 5; i++) { const r = await comp.sync({ ORDERS_DB: db }, { calls: 50 }); if (r.state === 'done') break; }
  assert.equal(db.sqlite.prepare("SELECT own_item_ids FROM comp_targets WHERE catalog_product_id='MLU555'").get().own_item_ids, '[]');
  const f = (await competitionByIsbn(db, [GONE])).get(GONE);
  assert.equal(f.competidores_comparables, 1);
  assert.equal(f.precio_minimo, 700);
  assert.equal(f.tu_precio, null);
});

test('días de preparación: sin MANUFACTURING_TIME es entrega inmediata; sin sale_terms no se sabe', async () => {
  const { manufacturingDays } = await import('../../worker-sync/ml-competition.js');
  assert.equal(manufacturingDays({ sale_terms: [{ id: 'MANUFACTURING_TIME', value_name: '21 días' }] }), 21);
  assert.equal(manufacturingDays({ sale_terms: [{ id: 'MANUFACTURING_TIME', value_struct: { number: 16, unit: 'días' } }] }), 16);
  assert.equal(manufacturingDays({ sale_terms: [{ id: 'WARRANTY_TYPE' }] }), 0);
  assert.equal(manufacturingDays({}), null);
});
