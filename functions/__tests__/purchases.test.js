import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { importPurchases, purchasesByIsbn, purchasesByTitle, purchaseSummary, documentIsbn, supplierKey, handlePurchasesRoute } from '../../worker-sync/purchases.js';
import { SALES_SCHEMA } from '../../worker-sync/ml-sales.js';
import { createPurchasesPanel } from '../panel/compras.js';

function database(t) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  const statement = (sql, args = []) => ({ sql, args, bind(...values) { return statement(sql, values); }, async first() { return sqlite.prepare(sql).get(...args) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; }, async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; } });
  return { prepare: sql => statement(sql), async batch(items) { sqlite.exec('BEGIN'); try { const r = items.map(s => ({ results: sqlite.prepare(s.sql).all(...s.args) })); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }, sqlite };
}
const count = (db, table) => db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

const ISBN = '9780306406157', ISBN10 = '0306406152';
const NOW = Date.parse('2026-10-24T12:00:00Z');
const celesa = (items, extra = {}) => ({ supplier: 'CELESA', supplier_order_id: 'C-41003791', document_number: 'A57307', purchase_date: '2025-06-10', currency: 'EUR', source_type: 'gmail_pdf', source_reference: 'gmail:msg-1', items, ...extra });

test('ISBN-10 se convierte a ISBN-13 y se marca isbn10', () => {
  assert.deepEqual(documentIsbn(ISBN10), { isbn: ISBN, method: 'isbn10', confidence: 98 });
  assert.equal(documentIsbn('978-0-306-40615-7').method, 'isbn13');
  assert.equal(documentIsbn('9780306406158'), null);
  assert.equal(supplierKey('Casassa y Lorenzo - Distribuidora'), 'CASASSA_Y_LORENZO');
  assert.equal(supplierKey('Amazon.com'), 'AMAZON_COM');
});

test('importar el mismo documento dos veces no duplica', async t => {
  const db = database(t);
  const doc = celesa([{ isbn: ISBN, title: 'Libro A', quantity: 2, unit_price: 10, discount_pct: 30 }, { isbn: ISBN10, title: 'Libro A otra línea', quantity: 1, unit_price: 10 }]);
  const first = await importPurchases(db, doc, NOW);
  assert.equal(first.imported, 1);
  await importPurchases(db, { documents: [doc] }, NOW);
  assert.equal(count(db, 'purchase_orders'), 1);
  assert.equal(count(db, 'purchase_items'), 2);
  const methods = db.sqlite.prepare('SELECT line_key,match_method FROM purchase_items ORDER BY line_key').all().map(r => `${r.line_key}=${r.match_method}`);
  assert.deepEqual(methods, [`${ISBN}=isbn13`, `${ISBN}#2=isbn10`]);
});

test('actualizar el mismo documento corrige cantidades y quita líneas que ya no vienen', async t => {
  const db = database(t);
  await importPurchases(db, celesa([{ isbn: ISBN, title: 'Libro A', quantity: 2 }, { isbn: '9788420412146', title: 'Libro B', quantity: 5 }]), NOW);
  await importPurchases(db, celesa([{ isbn: ISBN, title: 'Libro A', quantity: 3 }]), NOW);
  assert.equal(count(db, 'purchase_items'), 1);
  const [r] = await purchasesByIsbn(db, [ISBN]);
  assert.equal(r.unidades_compradas, 3);
  assert.equal(r.compras_totales, 1);
});

test('mismo ISBN comprado a dos proveedores se suma', async t => {
  const db = database(t);
  await importPurchases(db, [
    celesa([{ isbn: ISBN, title: 'Libro A', quantity: 2, unit_price: 10 }]),
    { supplier: 'Arnoia', document_number: 'ARN-0206', purchase_date: '2025-06-02', currency: 'ARS', source_type: 'gmail_pdf', items: [{ isbn: ISBN10, title: 'Libro A', quantity: 4, unit_price: 15000 }] },
  ], NOW);
  const [r] = await purchasesByIsbn(db, [ISBN]);
  assert.equal(r.unidades_compradas, 6);
  assert.equal(r.compras_totales, 2);
  assert.deepEqual(r.proveedores, ['ARNOIA', 'CELESA']);
  assert.equal(r.primera_compra, '2025-06-02');
  assert.equal(r.ultima_compra, '2025-06-10');
  assert.equal(r.ultimas_compras[0].documento, 'A57307');
  const [s] = await purchaseSummary(db, [ISBN], NOW);
  assert.equal(s.ultima_compra_proveedor, 'CELESA');
  assert.equal(s.ultima_compra_cantidad, 2);
  assert.equal(s.documentos, 2);
  assert.equal(s.unidades_365d, 0);
});

test('compra sin ISBN con título queda guardada y se encuentra por título', async t => {
  const db = database(t);
  const res = await importPurchases(db, { supplier: 'Amazon.com', supplier_order_id: '111-2223334-5556667', purchase_date: '2026-09-01', currency: 'USD', source_type: 'gmail_email',
    items: [{ title: 'The Psychology of Money', author: 'Morgan Housel', quantity: 3, unit_price: 12.5 }] }, NOW);
  assert.equal(res.results[0].match_methods.unresolved, 1);
  assert.equal(count(db, 'purchase_items'), 1);
  const found = await purchasesByTitle(db, 'psychology of money');
  assert.equal(found.length, 1);
  assert.equal(found[0].identificado_por, 'titulo');
  assert.equal(found[0].unidades_compradas, 3);
  assert.equal(found[0].ultimas_compras[0].pedido, '111-2223334-5556667');
});

test('título + autor resuelve contra un ISBN conocido de ventas ML', async t => {
  const db = database(t);
  await db.batch(SALES_SCHEMA.map(sql => db.prepare(sql)));
  db.sqlite.prepare("INSERT INTO ml_sales_items(order_id,line_key,item_id,title,title_key,quantity,isbn,updated_at) VALUES('1','a','MLU1','El Inversor Inteligente - Benjamin Graham','elinversorinteligentebenjamingraham',1,'9781418599942',0)").run();
  const res = await importPurchases(db, { supplier: 'CELESA', document_number: 'A1', purchase_date: '2026-10-01', items: [{ title: 'El inversor inteligente', author: 'Graham, Benjamin', quantity: 4 }] }, NOW);
  assert.equal(res.results[0].match_methods.title_author, 1);
  const [s] = await purchaseSummary(db, ['9781418599942'], NOW);
  assert.equal(s.unidades_30d, 4);
});

test('dos ediciones dudosas no se fusionan: queda para revisión con candidatos', async t => {
  const db = database(t);
  await importPurchases(db, [
    { supplier: 'CELESA', document_number: 'E1', purchase_date: '2025-01-01', items: [{ isbn: ISBN, title: 'Cien años de soledad', author: 'Gabriel García Márquez', quantity: 1 }] },
    { supplier: 'ARNOIA', document_number: 'E2', purchase_date: '2025-02-01', items: [{ isbn: '9788420412146', title: 'Cien años de soledad', author: 'Gabriel García Márquez', quantity: 1 }] },
  ], NOW);
  const res = await importPurchases(db, { supplier: 'CASASSA', supplier_order_id: '2107576', purchase_date: '2025-03-01', items: [{ title: 'Cien años de soledad', author: 'García Márquez', quantity: 2 }] }, NOW);
  const review = res.results[0].review[0];
  assert.equal(review.method, 'title_only');
  assert.deepEqual(review.candidates.sort(), [ISBN, '9788420412146'].sort());
  const row = db.sqlite.prepare("SELECT isbn,match_confidence FROM purchase_items WHERE purchase_id='CASASSA_Y_LORENZO:pedido-2107576'").get();
  assert.equal(row.isbn, null);
  assert.ok(row.match_confidence < 50);
  const [a] = await purchasesByIsbn(db, [ISBN]);
  assert.equal(a.unidades_compradas, 1);
  assert.equal(a.posibles_sin_isbn.length, 1);
  assert.equal((await purchaseSummary(db, [ISBN], NOW))[0].compras_sin_isbn_posibles, 1);
});

test('documento inválido no impide importar el resto; rutas validan 1..50 ISBN', async t => {
  const db = database(t);
  const res = await importPurchases(db, [celesa([{ isbn: ISBN, quantity: 1 }]), { supplier: 'CELESA', purchase_date: '2025-06-10', items: [{ title: 'x', quantity: 1 }] }, celesa([{ title: '', quantity: 1 }], { document_number: 'B' })], NOW);
  assert.equal(res.imported, 1);
  assert.deepEqual(res.results.filter(r => r.status === 'error').map(r => r.error), ['document_number_or_order_required', 'item_0_needs_isbn_or_title']);
  const post = (path, body) => handlePurchasesRoute(new Request('https://w.test' + path, { method: 'POST', body: JSON.stringify(body) }), { ORDERS_DB: db });
  assert.equal((await post('/purchases/query', { isbns: [] })).status, 400);
  assert.equal((await (await post('/purchases/query', { isbns: [ISBN] })).json()).resultados[0].unidades_compradas, 1);
  assert.equal((await post('/purchases/summary', { isbns: Array(51).fill(ISBN) })).status, 400);
});

test('panel de compras exige sesión y producción', async t => {
  const handler = createPurchasesPanel({ importer: async () => { throw new Error('no debería importar'); } });
  const preview = await handler({ request: new Request('https://preview.pages.dev/panel/compras'), env: { APP_ENV: 'preview' } });
  assert.equal(preview.status, 403);
  const noSession = await handler({ request: new Request('https://www.amadolibros.com/panel/compras'), env: { APP_ENV: 'production', PANEL_PASSWORD: 'una-clave-larga' } });
  assert.equal(noSession.status, 303);
});
