import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { revisarPrecio, textoPrecio, reviewCatalogPrices, opportunitiesFromPriceReview, lastPriceReview, ownPriceIndex, PRICE_PARAMS } from '../../worker-sync/precios-catalogo.js';
import { createMlCompetition } from '../../worker-sync/ml-competition.js';
import { refreshOpportunities, listOpportunities } from '../../worker-sync/oportunidades.js';
import { SALES_SCHEMA } from '../../worker-sync/ml-sales.js';
import { importPurchases } from '../../worker-sync/purchases.js';

function database(t) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  const statement = (sql, args = []) => ({ sql, args, bind(...values) { return statement(sql, values); }, async first() { return sqlite.prepare(sql).get(...args) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; }, async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; } });
  return { prepare: sql => statement(sql), async batch(items) { sqlite.exec('BEGIN'); try { const r = items.map(s => ({ results: sqlite.prepare(s.sql).all(...s.args) })); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }, sqlite };
}
const NOW = Date.parse('2026-10-27T15:00:00Z'), DAY = 864e5;
const A = '9780306406157', B = '9788420412146', C = '9781418599942';
const foto = extra => ({ foto: '2026-10-27', foto_edad_horas: 2, captura_posterior: null, competidores: 2, competidores_comparables: 2, precio_minimo: 1500, competidores_a_pedido: 0, precio_minimo_a_pedido: null, otra_moneda: 0, desconocidos: 0, segmento: 'top', ...extra });
const costo = { cost: 600, d: NOW - 20 * DAY, supplier: 'CELESA', currency: 'EUR' };

test('revisarPrecio: sugiere 2 % debajo del comparable cuando está 15 % o más arriba, con rango de prueba, costo con fecha, comisión y contribución', () => {
  const r = revisarPrecio({ isbn: A, precio_actual: 1000, stock: 2, u90: 6, f: foto(), costo, feeRate: 0.15 });
  assert.equal(r.sugerido, 1470); assert.equal(r.suba_pct, 47);
  assert.deepEqual(r.rango_prueba, [1050, 1100, 1150, 1200, 1260, 1320, 1380, 1440, 1470]);
  assert.equal(r.mas_por_mes, 940);
  assert.deepEqual(r.costo, { valor: 600, fecha: '2026-10-07', proveedor: 'CELESA', moneda: 'EUR' });
  assert.deepEqual(r.comision, { tasa: 0.15, actual: 150, sugerida: 221 });
  assert.deepEqual(r.contribucion, { actual: 250, sugerida: 649 });
  assert.deepEqual(r.faltantes, ['flete'], 'el flete no tiene fuente: se dice, no bloquea');
  assert.equal(r.nivel, 'firme'); assert.equal(r.confianza, 'alta');
  assert.match(textoPrecio(r), /El más barato con entrega inmediata está a \$ 1\.500 \(2 comparables en la ficha de ML\)\. Sugerencia: \$ 1\.470 \(\+47 %\); rango de prueba \$ 1\.050 → .*\$ 1\.470\. Al ritmo de 90 días \(6 vendidos\) son \$ 940 más por mes si sigue vendiendo igual\. Costo \$ 600 \(CELESA, 07\/10\/2026\), comisión ML 15 %: te quedan \$ 250 hoy y \$ 649 con el sugerido \(sin contar flete\)\. Faltan: flete\./);
  // Menos de 15 % arriba: sin suba, con el motivo.
  const cerca = revisarPrecio({ isbn: A, precio_actual: 1400, stock: 2, f: foto(), costo, feeRate: 0.15 });
  assert.equal(cerca.nivel, 'sin_suba'); assert.match(cerca.motivo, /menos de 15 % arriba/);
  // Sin costo ni comisión: provisional, nunca "rentable firme".
  const sinCosto = revisarPrecio({ isbn: A, precio_actual: 1000, stock: 2, f: foto() });
  assert.equal(sinCosto.nivel, 'provisional'); assert.deepEqual(sinCosto.faltantes, ['costo', 'comision', 'flete']); assert.equal(sinCosto.contribucion, null);
  assert.match(textoPrecio(sinCosto), /Sin costo y comisión no hay precio rentable firme: es una prueba/);
  // Sin stock: confianza baja (es el precio para cuando se reponga).
  assert.equal(revisarPrecio({ isbn: A, precio_actual: 1000, stock: 0, f: foto(), costo, feeRate: 0.15 }).confianza, 'baja');
  // Foto vieja o captura parcial posterior: baja.
  assert.equal(revisarPrecio({ isbn: A, precio_actual: 1000, stock: 1, f: foto({ foto_edad_horas: 60 }), costo, feeRate: 0.15 }).confianza, 'baja');
  // Parámetros propios: otro umbral y otro paso.
  const custom = revisarPrecio({ isbn: A, precio_actual: 1400, stock: 2, f: foto(), costo, feeRate: 0.15, params: { min_gap_pct: 5, probe_step_pct: 10 } });
  assert.equal(custom.sugerido, 1470); assert.deepEqual(custom.rango_prueba, [1470]);
});

test('revisarPrecio: ventaja inmediata, sin otra oferta y competidores sin datos', () => {
  // Todos a pedido y nosotros con stock: el sugerido sale de ellos.
  const v = revisarPrecio({ isbn: B, precio_actual: 1000, stock: 1, u90: 3, f: foto({ competidores_comparables: 0, precio_minimo: null, competidores_a_pedido: 3, precio_minimo_a_pedido: 1300 }), costo, feeRate: 0.15 });
  assert.equal(v.ventaja_inmediata, true); assert.equal(v.sugerido, 1270); assert.equal(v.referencia.tipo, 'a_pedido'); assert.equal(v.confianza, 'media');
  // A pedido cerca del precio: probar de a 5 % hasta 20 %.
  const cerca = revisarPrecio({ isbn: B, precio_actual: 1000, stock: 1, f: foto({ competidores_comparables: 0, precio_minimo: null, competidores_a_pedido: 1, precio_minimo_a_pedido: 1050 }), costo, feeRate: 0.15 });
  assert.equal(cerca.sugerido, 1200); assert.deepEqual(cerca.rango_prueba, [1050, 1100, 1150, 1200]);
  // Nadie en la ficha: nunca "nadie lo vende".
  const solo = revisarPrecio({ isbn: B, precio_actual: 1000, stock: 1, f: foto({ competidores: 0, competidores_comparables: 0, precio_minimo: null }), costo, feeRate: 0.15 });
  assert.equal(solo.referencia.tipo, 'ninguna'); assert.equal(solo.sugerido, 1200);
  assert.match(textoPrecio(solo), /No detectamos otra oferta en esta ficha de catálogo de ML/); assert.doesNotMatch(textoPrecio(solo), /nadie/i);
  // Competidores con datos desconocidos: no se compara ni se sugiere.
  const desc = revisarPrecio({ isbn: B, precio_actual: 1000, stock: 1, f: foto({ competidores: 2, competidores_comparables: 0, precio_minimo: null, desconocidos: 2 }), costo, feeRate: 0.15 });
  assert.equal(desc.nivel, 'sin_suba'); assert.equal(desc.referencia.tipo, 'desconocida'); assert.match(desc.motivo, /2 competidores sin datos/);
  // Sin foto o sin precio: bloqueado.
  assert.equal(revisarPrecio({ isbn: B, precio_actual: 1000, f: null }).nivel, 'bloqueado');
  assert.equal(revisarPrecio({ isbn: B, precio_actual: null, f: foto() }).nivel, 'bloqueado');
});

test('stock compartido y precio propio: máximo entre publicaciones, mínimo precio activo en pesos', () => {
  const idx = ownPriceIndex({ items: [{ isbn: A, status: 'active', available_quantity: 1, price: 1200, currency: 'UYU' }, { isbn: A, status: 'active', available_quantity: 1, price: 1100, currency: 'UYU' }, { isbn: A, status: 'paused', available_quantity: 5, price: 900 }, { isbn: B, status: 'active', available_quantity: 1, price: 30, currency: 'USD' }] });
  assert.deepEqual([idx.get(A).stock, idx.get(A).price], [1, 1100]);
  assert.equal(idx.get(B).price, null, 'un precio en dólares no es el precio en pesos');
});

const catalog = { updated_at: '2026-10-27T10:00:00Z', items: [
  { id: 'MLU1', isbn: A, title: 'Libro A', status: 'active', available_quantity: 2, catalog_listing: true, catalog_product_id: 'MLU901', price: 1000, currency: 'UYU' },
  { id: 'MLU2', isbn: B, title: 'Libro B', status: 'active', available_quantity: 1, catalog_listing: false, catalog_product_id: 'MLU902', price: 2000, currency: 'UYU' },
  { id: 'MLU3', isbn: C, title: 'Libro C', status: 'active', available_quantity: 0, catalog_listing: false, catalog_product_id: 'MLU903', price: 500, currency: 'UYU' },
] };

async function seedWatched(t) {
  const db = database(t);
  await db.batch(SALES_SCHEMA.map(sql => db.prepare(sql)));
  await createMlCompetition().ensure(db);
  const D = '2026-10-27', fetched = NOW - 3600000;
  db.sqlite.prepare("INSERT INTO comp_targets(catalog_product_id,isbn,own_item_ids,own_catalog_item_id,own_price,priority,updated_at) VALUES('MLU901',?,'[\"MLU1\"]','MLU1',1000,10,0)").run(A);
  db.sqlite.prepare("INSERT INTO comp_rotation(catalog_product_id,isbn,own_item_ids,own_catalog_item_id,own_price,segment,last_ok_at,next_due_at,updated_at) VALUES('MLU902',?,'[\"MLU2\"]',NULL,2000,'catalogo',?,0,0)").run(B, fetched);
  db.sqlite.prepare("INSERT INTO comp_rotation(catalog_product_id,isbn,own_item_ids,own_catalog_item_id,own_price,segment,last_ok_at,next_due_at,updated_at) VALUES('MLU903',?,'[\"MLU3\"]',NULL,500,'catalogo',NULL,0,0)").run(C);
  const day = (pid, status) => db.sqlite.prepare('INSERT INTO comp_product_days(snap_date,catalog_product_id,status,fetched_at,snapshot_version,items_total,items_fetched,pages,bulk_pending) VALUES(?,?,?,?,5,2,2,1,0)').run(D, pid, status, fetched);
  const snap = (pid, item, seller, price, days = 0) => db.sqlite.prepare('INSERT INTO comp_snapshots(snap_date,catalog_product_id,item_id,seller_id,price,currency_id,free_shipping,fetched_at,condition,international,manufacturing_days) VALUES(?,?,?,?,?,\'UYU\',0,?,\'new\',0,?)').run(D, pid, item, seller, price, fetched, days);
  day('MLU901', 'ok'); snap('MLU901', 'MLU1', '440298103', 1000); snap('MLU901', 'MLUX', '11', 1500); snap('MLU901', 'MLUY', '12', 1600);
  day('MLU902', 'ok'); snap('MLU902', 'MLUZ', '13', 3000, 21);
  day('MLU903', 'partial'); // sin foto completa
  // Ventas de A (6 en 90 días) y compra con precio para el costo.
  for (let i = 0; i < 6; i++) {
    db.sqlite.prepare('INSERT INTO ml_sales_orders(order_id,seller_id,status,date_created,date_created_ms,last_updated_ms,fetched_at) VALUES(?,?,?,?,?,?,0)').run(String(i), '440298103', 'paid', new Date(NOW - (i + 1) * 10 * DAY).toISOString(), NOW - (i + 1) * 10 * DAY, NOW);
    db.sqlite.prepare('INSERT INTO ml_sales_items(order_id,line_key,item_id,title,quantity,unit_price,currency_id,isbn,sale_fee,updated_at) VALUES(?,?,?,?,1,1000,?,?,150,0)').run(String(i), 'a', 'MLU1', 'Libro A', 'UYU', A);
  }
  db.sqlite.exec("CREATE TABLE IF NOT EXISTS fx_rates(rate_date TEXT NOT NULL,currency TEXT NOT NULL,uyu_per_unit REAL NOT NULL,fetched_at INTEGER NOT NULL,PRIMARY KEY(rate_date,currency)); INSERT INTO fx_rates VALUES('2026-10-27','EUR',46,0)");
  await importPurchases(db, { supplier: 'Celesa', document_type: 'invoice', document_number: 'F1', document_date: '2026-10-07', currency: 'EUR', items: [{ isbn: A, title: 'Libro A', quantity: 3, unit_price: 13 }] }, NOW);
  return db;
}

test('reviewCatalogPrices recorre top y rotación, deja el resumen y alimenta la bandeja reemplazando las subas de Brújula', async t => {
  const db = await seedWatched(t);
  const r = await reviewCatalogPrices(db, catalog, { nowMs: NOW });
  assert.equal(r.state, 'ok');
  assert.deepEqual({ v: r.resumen.fichas_vigiladas, f: r.resumen.con_foto, s: r.resumen.con_suba, firmes: r.resumen.firmes, prov: r.resumen.provisionales, b: r.resumen.bloqueadas }, { v: 3, f: 2, s: 2, firmes: 1, prov: 1, b: 0 });
  const byIsbn = Object.fromEntries(r.revisiones.map(x => [x.isbn, x]));
  assert.equal(byIsbn[A].nivel, 'firme'); assert.equal(byIsbn[A].sugerido, 1470); assert.equal(byIsbn[A].segmento, 'top'); assert.equal(byIsbn[A].u90, 6);
  assert.equal(byIsbn[A].costo.valor, 598, '13 EUR × 46 (sin descuento ni gastos)');
  assert.equal(byIsbn[A].comision.tasa, 0.15);
  assert.equal(byIsbn[B].segmento, 'rotacion'); assert.equal(byIsbn[B].ventaja_inmediata, true); assert.equal(byIsbn[B].sugerido, 2940); assert.equal(byIsbn[B].nivel, 'provisional', 'sin compra cargada: no hay costo');
  assert.ok(!byIsbn[C], 'sin foto completa no se revisa');
  assert.equal((await lastPriceReview(db)).con_suba, 2);
  // Bandeja: las subas vienen de la revisión (rango, costo, faltantes), no de Brújula.
  const bi = { precios: { ok: true, data: { lista: [{ isbn: A, title: 'Libro A', actual: 1000, min: 1500, competidores: 2, sugerido: 1470, subaPct: 47, ganaMes: 940, u90: 6, stock: 2, agotado: false }], solos: [] } }, abc: { ok: true, data: { sorted: [] } }, inventario: { ok: true, data: { aSinStock: [] } }, competencia: { ok: false } };
  const precios = opportunitiesFromPriceReview(r.revisiones, { nowMs: NOW });
  assert.equal(precios.length, 2);
  const res = await refreshOpportunities(db, { bi, catalog, precios, nowMs: NOW });
  assert.equal(res.con_revision_precios, 2); assert.equal(res.total, 2);
  const lista = await listOpportunities(db, { estado: 'pendiente', nowMs: NOW });
  const a = lista.find(o => o.isbn === A), b = lista.find(o => o.isbn === B);
  assert.equal(a.accion, 'Probar de $ 1.000 a $ 1.470 (+47%)'); assert.equal(a.impacto_mes, 940); assert.equal(a.confianza, 'alta');
  assert.deepEqual(a.evidencia.rango_prueba.slice(0, 2), [1050, 1100]); assert.equal(a.evidencia.costo.proveedor, 'CELESA'); assert.deepEqual(a.evidencia.faltantes, ['flete']);
  assert.equal(b.accion, 'Probar de $ 2.000 a $ 2.940 (+47%) · provisional'); assert.equal(b.impacto_mes, null); assert.deepEqual(b.evidencia.faltantes, ['costo', 'flete']);
  assert.match(b.evidencia.texto, /Sos el único con entrega inmediata: 1 lo venden a pedido desde \$ 3\.000/);
  assert.equal(lista[0].isbn, A, 'la de impacto sustentado va primero');
});
