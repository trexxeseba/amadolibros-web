import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { loadBi, abc, priceRaises, withUnsoldBooks, brujulaDigest, constantesEnRiesgo, stockObjetivo, detalleReposicion, comprasTexto, mercadoCorto } from '../_shared/panel-bi.js';
import { renderBi, createBiPanel } from '../panel/inteligencia.js';
import { SALES_SCHEMA } from '../../worker-sync/ml-sales.js';
import { importPurchases } from '../../worker-sync/purchases.js';
import { createSessionToken, deriveSessionSecret, sessionCookieHeader } from '../_shared/panel-auth.js';

test('un envío distinto no prueba que Amado sea el único vendedor con stock', () => {
  const facts = new Map([['9780306406157', { competidores_comparables: 0, competidores_inmediatos: 1, tu_precio: 1000, precio_minimo_a_pedido: 2000 }]]);
  const result = priceRaises(facts, [{ isbn: '9780306406157', title: 'Libro', u90: 3, stock: 1 }]);
  assert.equal(result.lista.length, 0);
  assert.equal(result.solos.length, 0);
});

function database(t) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  const statement = (sql, args = []) => ({ sql, args, bind(...values) { return statement(sql, values); }, async first() { return sqlite.prepare(sql).get(...args) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; }, async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; } });
  return { prepare: sql => statement(sql), async batch(items) { sqlite.exec('BEGIN'); try { const r = items.map(s => ({ results: sqlite.prepare(s.sql).all(...s.args) })); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }, sqlite };
}

const NOW = Date.parse('2026-10-24T12:00:00Z');
const A = '9780306406157', B = '9788420412146', C = '9781418599942', D = '9780997419900';
const catalog = { updated_at: '2026-10-24T10:00:00Z', items: [
  { id: 'MLU1', isbn: A, title: 'Libro A', publisher: 'AMADO LIBROS', status: 'active', available_quantity: 0, start_time: '2025-01-01T00:00:00Z' },
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
  // Editorial real: el catálogo trae la marca (Amado Libros); ML la guarda en la identidad de la venta.
  db.sqlite.prepare("INSERT INTO ml_sales_item_identity(item_id,isbn,source,publisher,checked_at) VALUES('MLU1',?,'attr','Paidós',0)").run(A);
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
  assert.equal(bi.editoriales.data[0].publisher, 'Paidós', 'A (identidad) y B (catálogo) son Paidós; la marca Amado Libros no cuenta');
  assert.ok(!bi.editoriales.data.some(p => /amado/i.test(p.publisher)));
  assert.equal(bi.kpis.data.enc365, 1);
  assert.equal(bi.inventario.data.aSinStock[0].mercado.estado, 'sin_dato');
  assert.equal(bi.inventario.data.aSinStock[0].compra.supplier, 'CELESA');
  assert.equal(bi.competencia.ok, false, 'sin tablas de competencia en el entorno de prueba el bloque falla solo');
  // Lentos pero constantes: B vendió 5 propias en 12 meses (el encargo SBS no
  // cuenta), 1 cada 73 días, queda 1: alcanza 73 días, menos que 75 → pedir 1.
  // A está agotado y es constante: entra con cobertura 0 y la compra reciente
  // a Celesa (hace 40 días, 4 u.) como aviso. C vendió 1: no es constante.
  const cons = bi.inventario.data.constantes;
  assert.deepEqual(cons.lista.map(b => b.isbn), [A, B]);
  assert.equal(cons.lista[1].u365p, 5);
  assert.equal(cons.lista[1].ritmo, 73);
  assert.equal(cons.lista[1].cobertura, 73);
  assert.equal(cons.lista[1].pedir, 1);
  assert.equal(cons.lista[1].mercado.estado, 'sin_dato', 'sin tablas de competencia no se inventa stock inmediato');
  assert.equal(cons.lista[0].stock, 0);
  assert.equal(cons.lista[0].compras.ultima.dias, 40);
  assert.equal(cons.lista[0].compras.ultima.cantidad, 4);
  assert.equal(cons.lista[0].compras.ultima.proveedor, 'CELESA');
  assert.equal(cons.lista[0].compras.ultima.vendidasDesde, 28, 'A: 14 ventas de 2 u. desde la compra de hace 40 días');
  assert.deepEqual(bi.inventario.data.faltanCompras, ['CELESA', 'ARNOIA', 'CASASSA_Y_LORENZO', 'AMAZON_COM'], 'sin cobertura cargada faltan todos los proveedores obligatorios');
  const sinStockA = bi.inventario.data.aSinStock[0];
  assert.equal(sinStockA.u30p, 20); assert.equal(sinStockA.pedir, 3, "ritmo 1 cada 8 días y 40 vendidas en 90: objetivo 3 con stock 0");
  assert.equal(sinStockA.compras.ultima.vendidasDesde, 28);
  const html = renderBi(bi);
  assert.match(html, /Lentos pero constantes/);
  assert.match(html, /1 cada 73 d/);
  for (const h of ['Cómo va el negocio', 'Tendencia semanal', 'Qué libros hacen la plata', 'Dónde se pierde plata', 'Cómo rinden las compras', 'Editoriales', 'competencia', 'conviene reponer', '1 en 12 meses', 'subirles el precio']) assert.match(html, new RegExp(h));
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
  assert.match(await res.text(), /Brújula Amado/);
});

test('margen por libro: costo de la última compra con descuento y envío de la factura, al cambio de hoy, menos comisión de ML', async t => {
  const db = await seed(t);
  const { FX_SCHEMA } = await import('../../worker-sync/fx-rates.js');
  await db.batch(FX_SCHEMA.map(sql => db.prepare(sql)));
  db.sqlite.prepare("INSERT INTO fx_rates(rate_date,currency,uyu_per_unit,fetched_at) VALUES('2026-10-24','EUR',45,0)").run();
  // Factura en euros: A a 20 € con 25% de descuento; la factura suma 10% (envío).
  await importPurchases(db, { supplier: 'Celesa', document_type: 'invoice', document_number: 'F2', currency: 'EUR', total_amount: 16.5, document_date: new Date(NOW - 10 * 864e5).toISOString().slice(0, 10), items: [{ isbn: A, title: 'Libro A', quantity: 1, unit_price: 20, discount_pct: 25 }] }, NOW);
  // Comisión: 5 ventas de una unidad al 12%.
  db.sqlite.prepare('UPDATE ml_sales_items SET sale_fee=unit_price*0.12 WHERE quantity=1').run();
  const bi = await loadBi(db, catalog, NOW);
  assert.ok(bi.margen.ok, bi.margen.error);
  const m = bi.margen.data;
  assert.equal(m.feeRate, 0.12);
  const a = m.top.find(b => b.isbn === A);
  assert.equal(a.cost, Math.round(20 * 0.75 * 1.1 * 45)); // 743
  assert.equal(a.price, 1000);
  assert.equal(a.fee, 120);
  assert.equal(a.margin, 1000 - 120 - 743);
  const fila = bi.inventario.data.aSinStock.find(b => b.isbn === A);
  assert.equal(fila.costo, 743);
  assert.equal(fila.margen.margin, 137);
  const html = renderBi(bi);
  assert.match(html, /Cuánto deja cada libro/);
  assert.match(html, /comisión de ML 12%/);
});

test('precios: lista los libros muy por debajo del más barato, sugiere 2% debajo y suma lo que entraría por mes', () => {
  const facts = new Map([
    ['a', { competidores: 3, competidores_comparables: 3, precio_minimo: 2160, tu_precio: null }],
    ['b', { competidores: 2, competidores_comparables: 2, precio_minimo: 1000, tu_precio: 950 }],
    ['c', { competidores: 0, competidores_comparables: 0, precio_minimo: null, tu_precio: 1500 }],
    ['d', { competidores: 4, competidores_comparables: 4, precio_minimo: 1200, tu_precio: 900 }],
  ]);
  const books = [
    { isbn: 'a', title: 'Agotado barato', avgPrice: 628, u90: 6, stock: 0 },
    { isbn: 'b', title: 'Casi igual', avgPrice: 950, u90: 9, stock: 2 },
    { isbn: 'c', title: 'Solo yo', avgPrice: 1500, u90: 3, stock: 1 },
    { isbn: 'd', title: 'Con stock barato', avgPrice: 900, u90: 30, stock: 4 },
  ];
  const model = { costs: new Map([['d', { cost: 500 }]]), feeRate: null };
  const r = priceRaises(facts, books, model);
  assert.equal(r.total, 2, 'b está a 95% del más barato: no entra');
  assert.equal(r.conStock, 1);
  const d = r.lista.find(x => x.isbn === 'd');
  assert.equal(d.sugerido, 1170);
  assert.equal(d.ganaMes, (1170 - 900) * 10);
  assert.equal(d.margenSugerido.margin, 670);
  const a = r.lista.find(x => x.isbn === 'a');
  assert.equal(a.agotado, true);
  assert.equal(a.actual, 628);
  assert.equal(a.sugerido, 2110);
  assert.equal(r.lista[0].isbn, 'a', 'ordenado por plata extra por mes');
  assert.equal(r.solosTotal, 1);
  assert.equal(r.solos[0].sugerido, 1650);
  assert.equal(priceRaises(null, books), null);
});

test('brujulaDigest: toma lo accionable de cada bloque y nada si no hay nada', async () => {
  const { brujulaDigest } = await import('../_shared/panel-bi.js');
  const NOW = Date.parse('2026-11-18T15:00:00Z');
  const sinStock = (isbn, title, extra = {}) => ({ isbn, title, now: NOW, stock: 0, u30p: 3, u90p: 8, u90: 8, u365p: 21, ritmo: 17, pedir: 3, avgPrice: 1250, lastMs: Date.parse('2026-11-12T15:00:00Z'), lastOwnMs: Date.parse('2026-11-12T15:00:00Z'),
    compras: { enCamino: 0, sinIsbn: 0, ultima: { fecha: '2026-09-02', dias: 77, cantidad: 4, proveedor: 'CELESA', vendidasDesde: 11 } }, ...extra });
  const bi = {
    inventario: { ok: true, data: { faltanCompras: [], aSinStock: [
      sinStock('a', 'A', { mercado: { estado: 'sostenible', nacionales: 1, min: 1100, vendedor: 'Librería Pocho', margenAlMin: 1100 } }),
      sinStock('b', 'B', { mercado: { estado: 'no_conviene' } }),
      sinStock('c', 'C', { mercado: { estado: 'solo', aPedido: 1 }, compras: { enCamino: 4, sinIsbn: 0, ultima: { fecha: '2026-11-10', dias: 8, cantidad: 4, proveedor: 'CELESA', vendidasDesde: 0 } } }),
      sinStock('z', 'Z sólo encargo', { mercado: { estado: 'solo' }, u365p: 0, u90p: 0 }),
    ], coberturaBaja: [{ isbn: 'd', title: 'D', stock: 1, dias: 13 }],
    constantes: { total: 2, enCamino: 0, faltan: ['ARNOIA'], now: NOW, lista: [
      sinStock('a', 'A', { mercado: { estado: 'solo' } }),
      sinStock('k', 'Klein', { stock: 1, cobertura: 61, u30p: 0, u90p: 1, u90: 1, u365p: 6, ritmo: 61, pedir: 1, avgPrice: 1700, mercado: { estado: 'con_stock', nacionales: 2, min: 1600, vendedor: 'Librería Pocho' },
        compras: { enCamino: 0, sinIsbn: 0, ultima: { fecha: '2026-10-29', dias: 20, cantidad: 2, proveedor: 'CELESA', vendidasDesde: 1 } } }),
    ] } } },
    precios: { ok: true, data: { lista: [{ isbn: 'e', title: 'E', agotado: true, actual: 600, sugerido: 2000, subaPct: 233, min: 2050 }, { isbn: 'f', title: 'F', agotado: false, actual: 900, sugerido: 1170, subaPct: 30, min: 1200 }] } },
    margen: { ok: true, data: { peores: [{ isbn: 'g', title: 'G', margin: -387, price: 1809, cost: 2196 }, { isbn: 'h', title: 'H', margin: 17, price: 596, cost: 579 }] } },
  };
  const d = brujulaDigest(bi);
  assert.deepEqual(d.reponer.map(r => r.isbn), ['a'], 'C ya está pedido, B no conviene y Z sólo vende por encargo');
  assert.equal(d.reponer[0].detalle, 'Sin stock: última venta el 12/11/26 (hace 6 días). Vendiste 3 en 30 días, 8 en 90 y 21 en 12 meses (1 cada 17 días), a $ 1.250. Pedí 3. Última compra: 4 u. el 02/09/26 (Celesa), hace 77 días; desde entonces vendiste 11: se vendió todo lo que entró. 1 lo tiene con entrega inmediata en Uruguay (Librería Pocho a $ 1.100); a ese precio ganás $ 1.100 por libro.');
  assert.deepEqual(d.pedidos.map(r => r.isbn), ['c']);
  assert.match(d.pedidos[0].detalle, /YA PEDIDO: compraste 4 u\. el 10\/11\/26 \(Celesa\), hace 8 días; puede estar en camino/);
  assert.match(d.pedidos[0].detalle, /Nadie más lo tiene con entrega inmediata en Uruguay \(1 lo venden a pedido\)/);
  assert.deepEqual(d.subir.map(r => r.isbn), ['f'], 'sólo los que tienen stock: se puede subir hoy');
  assert.match(d.agotan[0].detalle, /13 días/);
  assert.deepEqual(d.perdida.map(r => r.isbn), ['g']);
  assert.deepEqual(d.ultimo.map(r => r.isbn), ['k'], 'A ya salió en "Conviene reponer": no se repite');
  assert.equal(d.ultimo[0].detalle, 'Queda 1, alcanza unos 61 días; última venta el 12/11/26. Vendiste 0 en 30 días, 1 en 90 y 6 en 12 meses (1 cada 61 días), a $ 1.700. Pedí 1. Última compra: 2 u. el 29/10/26 (Celesa), hace 20 días; desde entonces vendiste 1. 2 lo tienen con entrega inmediata en Uruguay (Librería Pocho a $ 1.600).');
  assert.equal(d.ultimoTotal, 1);
  assert.equal(brujulaDigest({}), null);
  const soloUltimo = brujulaDigest({ inventario: { ok: true, data: { aSinStock: [], coberturaBaja: [], constantes: { now: NOW, faltan: ['CELESA', 'AMAZON_COM'], lista: [sinStock('z', 'Z', { u30p: 0, u90p: 0, u90: 0, u365p: 6, ritmo: 61, pedir: 2, avgPrice: null, lastOwnMs: null, lastMs: null, mercado: { estado: 'sin_dato' }, compras: { enCamino: 0, sinIsbn: 1, ultima: null } })] } } } });
  assert.equal(soloUltimo.ultimo[0].detalle, 'Sin stock. Vendiste 0 en 30 días, 0 en 90 y 6 en 12 meses (1 cada 61 días). Pedí 2. Sin compras registradas, pero faltan cargar las de Celesa, Amazon.com: confirmá que no esté pedido. Hay 1 compra sin ISBN que podría ser este libro. Sin dato de competencia en Mercado Libre.');
});

test('comprasTexto: no afirma "no hay compras" sin avisar qué proveedores faltan cargar, ni da por llegado lo que no se sabe', () => {
  assert.match(comprasTexto(undefined), /No pude consultar las compras/);
  assert.equal(comprasTexto({ enCamino: 0, sinIsbn: 0, ultima: null }, []), 'Sin compras registradas en los últimos 12 meses');
  assert.match(comprasTexto({ enCamino: 0, sinIsbn: 0, ultima: { fecha: '2026-11-01', dias: 17, cantidad: 3, proveedor: 'ARNOIA', vendidasDesde: 1 } }, [], 0), /desde entonces vendiste 1: faltarían 2 por vender, revisá si llegaron/);
  assert.doesNotMatch(comprasTexto({ enCamino: 0, sinIsbn: 0, ultima: { fecha: '2026-11-01', dias: 17, cantidad: 3, proveedor: 'ARNOIA', vendidasDesde: 1 } }, [], 2), /faltarían/, 'con stock el resto está en la góndola');
  assert.equal(mercadoCorto({ estado: 'solo', aPedido: 0 }), 'nadie más lo tiene con entrega inmediata en Uruguay');
});

test('lentos pero constantes: 2+ ventas propias al año y stock para 75 días o menos; 1 cada 60 días con el último ejemplar avisa, 1 cada 120 no', () => {
  const books = [
    { isbn: 'bleichmar', title: 'Fundación', u365p: 6, u90p: 1, stock: 1, avgPrice: 2650 }, // 1 cada 61 días, queda 1 → 61 ≤ 75: avisa
    { isbn: 'lento', title: 'Lento', u365p: 3, u90p: 0, stock: 1, avgPrice: 900 }, // 1 cada 122 días, queda 1 → 122: no avisa (se repone al venderse)
    { isbn: 'rapido', title: 'Rápido', u365p: 24, u90p: 6, stock: 2, avgPrice: 500 }, // 1 cada 15, quedan 2 → 30 días: avisa y el objetivo es 3
    { isbn: 'agotado', title: 'Agotado', u365p: 4, u90p: 1, stock: 0, avgPrice: 1000 }, // sin stock y constante: primero
    { isbn: 'unico', title: 'Una venta', u365p: 1, u90p: 1, stock: 0, avgPrice: 1000 }, // una sola venta: no es constante
    { isbn: 'cubierto', title: 'Cubierto', u365p: 12, u90p: 3, stock: 4, avgPrice: 1000 }, // 1 cada 30, quedan 4 → 120 días: tranquilo
  ];
  const r = constantesEnRiesgo(books);
  assert.deepEqual(r.map(b => b.isbn), ['agotado', 'rapido', 'bleichmar']);
  const b = r.find(x => x.isbn === 'bleichmar');
  assert.equal(b.ritmo, 61); assert.equal(b.cobertura, 61); assert.equal(b.objetivo, 2); assert.equal(b.pedir, 1);
  const rap = r.find(x => x.isbn === 'rapido');
  assert.equal(rap.objetivo, 3); assert.equal(rap.pedir, 1);
  const ag = r.find(x => x.isbn === 'agotado');
  assert.equal(ag.cobertura, 0); assert.equal(ag.ritmo, 91); assert.equal(ag.pedir, 1, 'ritmo 91: objetivo 1 y mínimo 1');
  assert.equal(stockObjetivo(10, 5), 3); assert.equal(stockObjetivo(10, 2), 2); assert.equal(stockObjetivo(60), 2); assert.equal(stockObjetivo(75), 2); assert.equal(stockObjetivo(76), 1);
  assert.match(detalleReposicion({ ...b, now: Date.parse('2026-11-18T15:00:00Z'), mercado: { estado: 'solo' }, compras: undefined }), /^Queda 1, alcanza unos 61 días\. Vendiste 0 en 30 días, 1 en 90 y 6 en 12 meses \(1 cada 61 días\), a \$ 2\.650\. Pedí 1\. No pude consultar las compras: confirmá que no esté pedido\. Nadie más/);
});

test('precios: si sos el único con entrega inmediata, el sugerido sale de los que venden a pedido', () => {
  const facts = new Map([['x', { competidores: 3, competidores_comparables: 0, competidores_a_pedido: 3, precio_minimo: null, precio_minimo_a_pedido: 5000, tu_precio: 2800 }]]);
  const r = priceRaises(facts, [{ isbn: 'x', title: 'Ciencias', avgPrice: 2800, u90: 6, stock: 2 }]);
  assert.equal(r.total, 1);
  assert.equal(r.lista[0].aPedido, true);
  assert.equal(r.lista[0].sugerido, 4900);
  assert.equal(r.solosTotal, 0);
});

test('libros vigilados sin ventas en 12 meses: entran a "muy barato" con el stock del catálogo y el correo dice cuántos son', () => {
  const facts = new Map([
    // Vendido: nadie más inmediato, a pedido desde 5.000.
    ['A', { tu_precio: 2000, competidores_comparables: 0, competidores_inmediatos: 0, competidores_a_pedido: 1, precio_minimo_a_pedido: 5000 }],
    // Sin ventas, con stock: único inmediato a 1.395, a pedido desde 1.890.
    ['B', { tu_precio: 1395, competidores_comparables: 0, competidores_inmediatos: 0, competidores_a_pedido: 2, precio_minimo_a_pedido: 1890 }],
    // Sin ventas y sin stock en el catálogo: no entra.
    ['C', { tu_precio: 500, competidores_comparables: 0, competidores_inmediatos: 0, competidores_a_pedido: 1, precio_minimo_a_pedido: 2000 }],
  ]);
  const table = {
    books: [{ isbn: 'A', title: 'Vendido', u90: 3, stock: 1 }],
    meta: new Map([['B', { title: 'Cola larga' }], ['C', { title: 'Agotado' }]]),
    stock: new Map([['B', { stock_propio: 2 }], ['C', { stock_propio: 0 }]]),
  };
  const books = withUnsoldBooks(facts, table);
  assert.deepEqual(books.map(b => b.isbn), ['A', 'B']);
  const r = priceRaises(facts, books);
  assert.deepEqual(r.lista.map(b => b.isbn), ['A', 'B'], 'primero lo que más deja por mes');
  const b = r.lista[1];
  assert.equal(b.title, 'Cola larga');
  assert.equal(b.sugerido, 1850);
  assert.equal(b.subaPct, 33);
  assert.equal(b.ganaMes, 0);
  assert.equal(b.aPedido, true);
  assert.equal(r.conStock, 2);
  const digest = brujulaDigest({ precios: { ok: true, data: r } });
  assert.equal(digest.subirTotal, 2);
  assert.match(digest.subir[1].detalle, /de \$ 1\.395 a \$ 1\.850 \(\+33%; sos el único con entrega inmediata/);
  assert.equal(withUnsoldBooks(null, table), table.books);
});
