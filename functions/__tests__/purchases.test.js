import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { importPurchases, purchasesByIsbn, purchasesByTitle, purchaseSummary, documentIsbn, supplierKey, parseNumber, missingCoverage, readCoverage, handlePurchasesRoute } from '../../worker-sync/purchases.js';
import { SALES_SCHEMA } from '../../worker-sync/ml-sales.js';
import { createPurchasesPanel } from '../panel/compras.js';

function database(t) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  const statement = (sql, args = []) => ({ sql, args, bind(...values) { return statement(sql, values); }, async first() { return sqlite.prepare(sql).get(...args) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; }, async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; } });
  return { prepare: sql => statement(sql), async batch(items) { sqlite.exec('BEGIN'); try { const r = items.map(s => ({ results: sqlite.prepare(s.sql).all(...s.args) })); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }, sqlite };
}
const count = (db, table) => db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

const ISBN = '9780306406157', ISBN10 = '0306406152', ISBN2 = '9788420412146';
const NOW = Date.parse('2026-10-24T12:00:00Z');
const invoice = (items, extra = {}) => ({ supplier: 'CELESA', document_type: 'invoice', document_number: 'A57307', supplier_order_id: 'C-41003791', document_date: '2025-06-10', currency: 'EUR', source_type: 'gmail_pdf', items, ...extra });

test('ISBN-10 → ISBN-13, alias de proveedores y números con formato local', () => {
  assert.deepEqual(documentIsbn(ISBN10), { isbn: ISBN, method: 'isbn10', confidence: 98 });
  assert.equal(documentIsbn('9780306406158'), null);
  for (const [raw, key] of [['Casassa y Lorenzo - Distribuidora', 'CASASSA_Y_LORENZO'], ['Casassa & Lorenzo', 'CASASSA_Y_LORENZO'], ['CASASSA Y LORENZO LIBREROS S.A.', 'CASASSA_Y_LORENZO'], ['Celesa S.L.', 'CELESA'], ['Amazon.es', 'AMAZON_ES'], ['Amazon.com', 'AMAZON_COM']]) assert.equal(supplierKey(raw), key, raw);
  assert.equal(parseNumber('25.900'), 25900);
  assert.equal(parseNumber('1.234,56'), 1234.56);
  assert.equal(parseNumber('12,5'), 12.5);
  assert.equal(parseNumber('1,234.56'), 1234.56);
  assert.equal(parseNumber('$ 890'), 890);
});

test('importar el mismo documento dos veces no duplica; el id lo arma el servidor', async t => {
  const db = database(t);
  const doc = invoice([{ isbn: ISBN, title: 'Libro A', quantity: 2, unit_price: 10, discount_pct: 30, line_total: 14 }, { isbn: ISBN10, title: 'Libro A otra línea', quantity: 1, unit_price: 10 }], { purchase_id: 'Comprobante_compra.pdf' });
  const first = await importPurchases(db, doc, NOW);
  assert.equal(first.results[0].purchase_id, 'CELESA:invoice:2025:A57307');
  await importPurchases(db, { documents: [doc] }, NOW);
  assert.equal(count(db, 'purchase_orders'), 1);
  assert.equal(count(db, 'purchase_items'), 2);
});

test('actualizar el mismo documento corrige cantidades y quita líneas que ya no vienen', async t => {
  const db = database(t);
  await importPurchases(db, invoice([{ isbn: ISBN, title: 'Libro A', quantity: 2 }, { isbn: ISBN2, title: 'Libro B', quantity: 5 }]), NOW);
  await importPurchases(db, invoice([{ isbn: ISBN, title: 'Libro A', quantity: 3 }]), NOW);
  assert.equal(count(db, 'purchase_items'), 1);
  assert.equal((await purchasesByIsbn(db, [ISBN]))[0].unidades_compradas, 3);
});

test('pedido + factura del mismo pedido cuentan una sola vez, en cualquier orden', async t => {
  for (const order of [['pedido', 'factura'], ['factura', 'pedido']]) {
    const db = database(t);
    const pedido = { supplier: 'CELESA', document_type: 'order', supplier_order_id: 'C-41003791', document_date: '2025-06-01', items: [{ isbn: ISBN, title: 'Libro A', quantity: 5 }] };
    const factura = invoice([{ isbn: ISBN, title: 'Libro A', quantity: 4 }], { supplier_order_id: null, related_order_ids: ['C-41003791'] });
    for (const which of order) await importPurchases(db, which === 'pedido' ? pedido : factura, NOW);
    const [r] = await purchasesByIsbn(db, [ISBN]);
    assert.equal(r.unidades_compradas, 4, order.join('→'));
    assert.equal(r.compras_totales, 1);
  }
});

test('misma numeración en dos años no se pisa; nota de crédito resta', async t => {
  const db = database(t);
  await importPurchases(db, [
    invoice([{ isbn: ISBN, title: 'A', quantity: 2 }], { document_number: '0001', document_date: '2025-03-01' }),
    invoice([{ isbn: ISBN, title: 'A', quantity: 3 }], { document_number: '0001', document_date: '2026-03-01' }),
    { supplier: 'CELESA', document_type: 'credit_note', document_number: 'NC-9', document_date: '2026-03-10', items: [{ isbn: ISBN, title: 'A', quantity: 1 }] },
  ], NOW);
  assert.equal(count(db, 'purchase_orders'), 3);
  assert.equal((await purchasesByIsbn(db, [ISBN]))[0].unidades_compradas, 4);
});

test('mismo ISBN comprado a dos proveedores se suma; resumen para el motor', async t => {
  const db = database(t);
  await importPurchases(db, [
    invoice([{ isbn: ISBN, title: 'Libro A', quantity: 2, unit_price: 10 }]),
    { supplier: 'Arnoia', document_type: 'receipt', document_number: 'ARN-0206', document_date: '2026-10-20', currency: 'ARS', items: [{ isbn: ISBN10, title: 'Libro A', quantity: 4, unit_price: '15.000' }] },
  ], NOW);
  const [r] = await purchasesByIsbn(db, [ISBN]);
  assert.equal(r.unidades_compradas, 6);
  assert.deepEqual(r.proveedores, ['ARNOIA', 'CELESA']);
  assert.equal(r.ultimas_compras[0].precio_unitario, 15000);
  const [s] = await purchaseSummary(db, [ISBN], NOW);
  assert.equal(s.ultima_compra_proveedor, 'ARNOIA');
  assert.equal(s.unidades_30d, 4);
  assert.equal(s.en_transito_estimado, 4);
  assert.equal(s.documentos, 2);
});

test('compra sin ISBN con título queda guardada y se encuentra por título; encargo de cliente no cuenta', async t => {
  const db = database(t);
  const res = await importPurchases(db, { supplier: 'Amazon.com', document_type: 'order', supplier_order_id: '111-2223334-5556667', document_date: '2026-09-01', currency: 'USD', purpose: 'encargo_cliente',
    items: [{ title: 'The Psychology of Money', author: 'Morgan Housel', quantity: 3, unit_price: 12.5 }] }, NOW);
  assert.equal(res.results[0].match_methods.unresolved, 1);
  const found = await purchasesByTitle(db, 'psychology of money');
  assert.equal(found[0].identificado_por, 'titulo');
  assert.equal(found[0].ultimas_compras[0].destino, 'encargo_cliente');
});

test('título + todos los apellidos del autor resuelve; un apellido parcial o editorial genérica no', async t => {
  const db = database(t);
  await db.batch(SALES_SCHEMA.map(sql => db.prepare(sql)));
  db.sqlite.prepare("INSERT INTO ml_sales_items(order_id,line_key,item_id,title,title_key,quantity,isbn,updated_at) VALUES('1','a','MLU1','El Inversor Inteligente - Benjamin Graham','elinversorinteligentebenjamingraham',1,'9781418599942',0)").run();
  db.sqlite.prepare("INSERT INTO ml_sales_items(order_id,line_key,item_id,title,title_key,quantity,isbn,updated_at) VALUES('2','a','MLU2','Romancero Gitano Federico García Lorca Editorial Planeta','',1,?,0)").run(ISBN2);
  const res = await importPurchases(db, [
    { supplier: 'CELESA', document_number: 'A1', document_date: '2026-10-01', items: [{ title: 'El inversor inteligente', author: 'Graham, Benjamin', quantity: 4 }] },
    { supplier: 'CELESA', document_number: 'A2', document_date: '2026-10-01', items: [{ title: 'Romancero gitano', author: 'García Márquez, Gabriel', quantity: 1 }] },
    { supplier: 'CELESA', document_number: 'A3', document_date: '2026-10-01', items: [{ title: 'Romancero gitano edición escolar', publisher: 'Editorial Planeta', quantity: 1 }] },
  ], NOW);
  assert.equal(res.results[0].match_methods.title_author, 1);
  assert.equal(res.results[0].inferred_type, true);
  assert.equal(res.results[1].match_methods.title_author, undefined);
  assert.equal(res.results[2].match_methods.title_publisher, undefined);
  assert.equal((await purchaseSummary(db, ['9781418599942'], NOW))[0].unidades_30d, 4);
});

test('dos ediciones dudosas no se fusionan: queda para revisión con candidatos', async t => {
  const db = database(t);
  await importPurchases(db, [
    invoice([{ isbn: ISBN, title: 'Cien años de soledad', author: 'Gabriel García Márquez', quantity: 1 }], { document_number: 'E1', document_date: '2025-01-01' }),
    { supplier: 'ARNOIA', document_number: 'E2', document_date: '2025-02-01', items: [{ isbn: ISBN2, title: 'Cien años de soledad', author: 'Gabriel García Márquez', quantity: 1 }] },
  ], NOW);
  const res = await importPurchases(db, { supplier: 'CASASSA', document_type: 'order', supplier_order_id: '2107576', document_date: '2025-03-01', items: [{ title: 'Cien años de soledad', author: 'García Márquez', quantity: 2 }] }, NOW);
  const review = res.results[0].review[0];
  assert.equal(review.method, 'title_only');
  assert.deepEqual(review.candidates.sort(), [ISBN, ISBN2].sort());
  assert.equal((await purchasesByIsbn(db, [ISBN]))[0].posibles_sin_isbn.length, 1);
  assert.equal((await purchaseSummary(db, [ISBN], NOW))[0].compras_sin_isbn_posibles, 1);
});

test('validación: moneda obligatoria con precios, total de línea inconsistente marcado, errores por documento', async t => {
  const db = database(t);
  const res = await importPurchases(db, [
    invoice([{ isbn: ISBN, quantity: 1, unit_price: 10 }], { currency: null }),
    invoice([{ isbn: ISBN, quantity: 2, unit_price: 10, line_total: 50 }], { document_number: 'B' }),
    { supplier: 'CELESA', document_type: 'invoice', document_date: '2025-06-10', items: [{ title: 'x', quantity: 1 }] },
  ], NOW);
  assert.deepEqual(res.results.map(r => r.status === 'error' ? r.error : r.review[0]?.flags[0]), ['currency_required_with_prices', 'line_total_mismatch', 'document_number_required']);
});

test('cobertura por proveedor: se guarda en el mismo import y define qué falta', async t => {
  const db = database(t);
  const res = await importPurchases(db, { coverage: [{ supplier: 'Celesa', covered_from: '2025-01-01', covered_to: '2026-10-20' }, { supplier: 'Arnoia', covered_from: '2026-01-01', covered_to: '2026-10-20' }] }, NOW);
  assert.equal(res.coverage.filter(c => c.status === 'saved').length, 2);
  assert.deepEqual(missingCoverage(await readCoverage(db), NOW), ['ARNOIA', 'CASASSA_Y_LORENZO', 'AMAZON_COM']);
});

test('rutas validan 1..50 ISBN; panel exige sesión y producción', async t => {
  const db = database(t);
  const post = (path, body) => handlePurchasesRoute(new Request('https://w.test' + path, { method: 'POST', body: JSON.stringify(body) }), { ORDERS_DB: db });
  assert.equal((await post('/purchases/query', { isbns: [] })).status, 400);
  assert.equal((await post('/purchases/summary', { isbns: Array(51).fill(ISBN) })).status, 400);
  const handler = createPurchasesPanel({ importer: async () => { throw new Error('no debería importar'); } });
  assert.equal((await handler({ request: new Request('https://preview.pages.dev/panel/compras'), env: { APP_ENV: 'preview' } })).status, 403);
  assert.equal((await handler({ request: new Request('https://www.amadolibros.com/panel/compras'), env: { APP_ENV: 'production', PANEL_PASSWORD: 'una-clave-larga' } })).status, 303);
});

test('en camino: el pedido y la confirmación de envío del mismo proveedor no suman dos veces, ni un envío cargado dos veces', async () => {
  const { dedupePurchaseRows } = await import('../../worker-sync/purchases.js');
  const D = 864e5, base = Date.parse('2026-10-22T12:00:00Z');
  const row = (id, type, daysAgo, q, supplier = 'ARNOIA') => ({ purchase_id: id, document_type: type, supplier, quantity: q, purchase_date_ms: base - daysAgo * D });
  const kept = dedupePurchaseRows([
    row('ped', 'order', 5, 2), row('envio', 'receipt', 0, 2),        // mismo libro: pedido y después la confirmación
    row('envio-bis', 'receipt', 1, 2),                                   // el mismo envío cargado de nuevo
    row('celesa', 'invoice', 2, 2, 'CELESA'),                            // otro proveedor: sí suma
    row('viejo', 'receipt', 40, 2),                                      // compra anterior: sí suma
  ]);
  assert.deepEqual(kept.map(r => r.purchase_id).sort(), ['celesa', 'envio-bis', 'viejo'].sort());
});
