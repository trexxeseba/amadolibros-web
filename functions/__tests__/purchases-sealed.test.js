import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureSealKey, importSealed } from '../../worker-sync/purchases-sealed.js';
import { handlePurchasesRoute } from '../../worker-sync/purchases.js';
import { seal } from '../../scripts/purchases/sellar.mjs';

function database(t) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  const statement = (sql, args = []) => ({ sql, args, bind(...values) { return statement(sql, values); }, async first() { return sqlite.prepare(sql).get(...args) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; }, async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; } });
  return { prepare: sql => statement(sql), async batch(items) { sqlite.exec('BEGIN'); try { const r = items.map(s => ({ results: sqlite.prepare(s.sql).all(...s.args) })); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }, sqlite };
}

const doc = (number = 'CF-10256', extra = {}) => ({ supplier: 'CELESA', document_type: 'invoice', document_number: number, document_date: '2026-10-06', currency: 'EUR', total_amount: 100,
  items: [{ isbn: '9780306406157', title: 'LIBRO SECRETO DE PRUEBA', quantity: 2, unit_price: 40, discount_pct: 0, line_total: 80 }], ...extra });

test('la clave se crea una vez y la pública no trae la parte privada', async t => {
  const db = database(t);
  const a = await ensureSealKey(db), b = await ensureSealKey(db);
  assert.deepEqual(a.publicJwk, b.publicJwk, 'la segunda vez devuelve la misma');
  assert.equal(a.publicJwk.d, undefined);
  const res = await handlePurchasesRoute(new Request('https://w/purchases/key', { method: 'POST', body: '{}' }), { ORDERS_DB: db });
  const body = await res.json();
  assert.equal(body.public_jwk.n, a.publicJwk.n);
  assert.equal(body.public_jwk.d, undefined);
  assert.equal(body.private_jwk, undefined);
});

test('importa lo nuevo, saltea lo ya cargado aunque cambie el guion, y no devuelve datos de las compras', async t => {
  const db = database(t);
  const { publicJwk } = await ensureSealKey(db);
  const first = await importSealed(db, await seal(publicJwk, { documents: [doc()] }));
  assert.deepEqual(first, { imported: 1, skipped_existing: 0, removed: 0, errors: [], review: 0 });
  assert.ok(!JSON.stringify(first).includes('SECRETO'), 'la respuesta no lleva títulos');
  // Mismo documento, mismo año: se saltea (aunque venga como CF10256 y no se pise lo ya corregido).
  db.sqlite.prepare("UPDATE purchase_orders SET received_date='2026-10-20'").run();
  const again = await importSealed(db, await seal(publicJwk, { documents: [doc('CF10256'), doc('CF-10300', { document_date: '2026-10-09' })] }));
  assert.deepEqual([again.imported, again.skipped_existing], [1, 1]);
  assert.equal(db.sqlite.prepare("SELECT received_date FROM purchase_orders WHERE document_number='CF-10256'").get().received_date, '2026-10-20', 'no pisó la fecha de recepción cargada a mano');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_orders').get().n, 2);
  // Otro año con los mismos dígitos es otra compra.
  const otherYear = await importSealed(db, await seal(publicJwk, { documents: [doc('CF-10256', { document_date: '2025-10-06' })] }));
  assert.equal(otherYear.imported, 1);
});

test('un documento inválido se informa por código y no frena a los demás', async t => {
  const db = database(t);
  const { publicJwk } = await ensureSealKey(db);
  const r = await importSealed(db, await seal(publicJwk, { documents: [{ supplier: 'CELESA', items: [] }, doc('CF-1')] }));
  assert.equal(r.imported, 1);
  assert.deepEqual(r.errors.map(e => e.index), [0]);
});

test('un sobre alterado o cifrado con otra clave no se importa', async t => {
  const db = database(t), other = database(t);
  const { publicJwk } = await ensureSealKey(db);
  const foreign = (await ensureSealKey(other)).publicJwk;
  await assert.rejects(importSealed(db, await seal(foreign, { documents: [doc()] })), /decrypt_failed/);
  const good = await seal(publicJwk, { documents: [doc()] });
  const tampered = good.slice(0, -8) + (good.endsWith('AAAAAAAA') ? 'BBBBBBBB' : 'AAAAAAAA');
  await assert.rejects(importSealed(db, tampered), /decrypt_failed/);
  await assert.rejects(importSealed(db, 'corto'), /sealed_invalid/);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='purchase_orders'").get().n, 0, 'con un sobre inválido no se escribe nada');
});

test('la misma factura cargada antes con otro formato de número se reconoce por su contenido', async t => {
  const db = database(t);
  const { publicJwk } = await ensureSealKey(db);
  // Cargada a mano con el número del nombre del archivo: los dígitos no coinciden con CF-10256.
  const manual = await importSealed(db, await seal(publicJwk, { documents: [doc('863137-CF-10256')] }));
  assert.equal(manual.imported, 1);
  const again = await importSealed(db, await seal(publicJwk, { documents: [doc('CF-10256')] }));
  assert.deepEqual([again.imported, again.skipped_existing], [0, 1], 'mismo proveedor, fecha, libro y cantidad: es la misma compra');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_orders').get().n, 1);
  // Otra fecha o otra cantidad es otra compra.
  const other = await importSealed(db, await seal(publicJwk, { documents: [doc('CF-20000', { document_date: '2026-10-07' }), doc('CF-20001', { items: [{ isbn: '9780306406157', title: 'OTRO', quantity: 5, unit_price: 40, discount_pct: 0, line_total: 200 }] })] }));
  assert.deepEqual([other.imported, other.skipped_existing], [2, 0]);
});

test('quitar: borra un duplicado que cargó este circuito y nunca lo cargado a mano', async t => {
  const db = database(t);
  const { publicJwk } = await ensureSealKey(db);
  const viaPdf = doc('CF-10256', { source_type: 'pdf', source_reference: 'gmail:factura.pdf' });
  await importSealed(db, await seal(publicJwk, { documents: [viaPdf] }));
  db.sqlite.prepare("INSERT INTO purchase_orders(purchase_id,supplier,document_number,purchase_date,purchase_date_ms,currency,source_type,created_at,updated_at,document_type,purpose) VALUES('CELESA:invoice:2026:MANUAL-1','CELESA','MANUAL-1','2026-09-01',0,'EUR','manual',0,0,'invoice','stock')").run();
  const r = await importSealed(db, await seal(publicJwk, { remove: ['CELESA:invoice:2026:CF-10256', 'CELESA:invoice:2026:MANUAL-1'] }));
  assert.equal(r.removed, 1, 'sólo el que vino de un PDF de mail');
  const left = db.sqlite.prepare('SELECT purchase_id FROM purchase_orders').all().map(x => x.purchase_id);
  assert.deepEqual(left, ['CELESA:invoice:2026:MANUAL-1']);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_items').get().n, 0, 'también se borraron sus líneas');
  // Quitar y volver a cargar en un mismo envío deja una sola compra (se corrige solo si no había original).
  const again = await importSealed(db, await seal(publicJwk, { remove: ['CELESA:invoice:2026:CF-10256'], documents: [viaPdf] }));
  assert.deepEqual([again.removed, again.imported], [0, 1]);
});
