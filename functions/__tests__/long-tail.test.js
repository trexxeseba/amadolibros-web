import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { clasificarTitulo, paresCatalogo, longTailReview, loadVisitsIndex, diasDisponibles, CATEGORIAS } from '../../worker-sync/long-tail.js';
import { ownStockIndex } from '../../worker-sync/reposicion-facts.js';

const NOW = Date.parse('2026-10-27T12:00:00Z'), DAY = 864e5;
const iso = daysAgo => new Date(NOW - daysAgo * DAY).toISOString();
const A = '9780306406157', B = '9788420412146', C = '9781418599942', D = '9780997419900';

test('clasificación: quiebre, con ventas, lentas (mantener 1), sin evidencia, visitas desconocidas no son 0, poca exposición y visitas sin conversión', () => {
  const c = o => clasificarTitulo({ isbn: A, nowMs: NOW, ...o }).categoria;
  assert.equal(c({ stock: 0, u90: 2, u365: 5 }), 'quiebre');
  assert.equal(c({ stock: 0, u90: 0, u365: 2 }), 'quiebre', 'dos ventas en el año sin stock también es quiebre');
  assert.equal(c({ stock: 0, u90: 0, u365: 1 }), 'sin_stock_sin_demanda');
  assert.equal(c({ stock: 1, u90: 1, u365: 1 }), 'oferta_con_ventas');
  // Sin ventas en 90 días pero sí en el año: no está muerto, se mantiene 1.
  const lenta = clasificarTitulo({ isbn: A, stock: 1, u90: 0, u365: 1, nowMs: NOW });
  assert.equal(lenta.categoria, 'ventas_lentas'); assert.match(lenta.accion, /mantener 1 unidad/);
  // Publicado hace 60 días sin ventas: evidencia insuficiente, no "sin demanda".
  assert.equal(c({ stock: 1, u90: 0, u365: 0, start: iso(60) }), 'sin_ventas_reciente');
  assert.equal(c({ stock: 1, u90: 0, u365: 0, start: null }), 'sin_ventas_reciente', 'sin fecha de alta no se sabe cuánto estuvo disponible');
  assert.equal(c({ stock: 1, u90: 0, u365: 0, start: iso(400), ventana_365_completa: false }), 'sin_ventas_reciente', 'con menos de un año de ventas cargadas tampoco');
  // 180+ días sin ventas y sin visitas conocidas: no se distingue exposición de demanda.
  const sinVisitas = clasificarTitulo({ isbn: A, stock: 3, u90: 0, u365: 0, start: iso(400), nowMs: NOW });
  assert.equal(sinVisitas.categoria, 'sin_ventas_sin_visitas'); assert.equal(sinVisitas.visitas, 'desconocidas'); assert.equal(sinVisitas.visitas_90d, null);
  assert.equal(sinVisitas.dias_disponibles_365, 365, 'techo de la ventana');
  // Con visitas observadas: bajas → poca exposición; altas → visitas sin conversión.
  assert.equal(c({ stock: 3, u90: 0, u365: 0, start: iso(400), visitas_90d: 4 }), 'poca_exposicion');
  assert.equal(c({ stock: 3, u90: 0, u365: 0, start: iso(400), visitas_90d: 120 }), 'visitas_sin_conversion');
  assert.equal(c({ stock: 3, u90: 0, u365: 0, start: iso(400), visitas_90d: 0 }), 'poca_exposicion', 'cero observado sí es cero');
  assert.equal(diasDisponibles(iso(10), NOW, 90), 10);
  assert.equal(diasDisponibles('no-es-fecha', NOW, 90), null);
  assert.equal(Object.keys(CATEGORIAS).length, 8);
});

test('parejas catálogo / no catálogo: se listan con sus diferencias y nunca se suman', () => {
  const catalog = { items: [
    { id: 'MLU1', isbn: A, title: 'A', status: 'active', catalog_listing: true, price: 1000, available_quantity: 1 },
    { id: 'MLU2', isbn: A, status: 'active', catalog_listing: false, price: 1200, available_quantity: 1 },
    { id: 'MLU3', isbn: B, title: 'B', status: 'active', catalog_listing: true, price: 900, available_quantity: 2 },
    { id: 'MLU4', isbn: B, status: 'active', catalog_listing: false, price: 900, available_quantity: 2 },
    { id: 'MLU5', isbn: C, status: 'active', catalog_listing: false, price: 500, available_quantity: 1 },
    { id: 'MLU6', isbn: D, status: 'paused', catalog_listing: true, price: 500, available_quantity: 1 },
    { id: 'MLU7', isbn: D, status: 'active', catalog_listing: false, price: 500, available_quantity: 1 },
  ] };
  const pares = paresCatalogo(catalog);
  assert.deepEqual(pares.map(p => [p.isbn, p.revisar, p.motivos]), [[A, true, ['precios distintos']], [B, false, []]]);
  assert.equal(ownStockIndex(catalog).get(A).stock_propio, 1, 'stock compartido: máximo, no 2');
});

test('revisión de todo el catálogo: conteos, listas, capital y visitas desde D1', async t => {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  const db = { prepare: sql => ({ bind: (...a) => ({ async all() { return { results: sqlite.prepare(sql).all(...a) }; } }) }) };
  sqlite.exec('CREATE TABLE comp_item_visits(snap_date TEXT,item_id TEXT,isbn TEXT,date_from TEXT,date_to TEXT,visits INTEGER,fetched_at INTEGER)');
  sqlite.prepare('INSERT INTO comp_item_visits VALUES(?,?,?,?,?,?,?)').run('2026-10-27', 'MLU3', C, '2026-07-29', '2026-10-27', 80, NOW);
  sqlite.prepare('INSERT INTO comp_item_visits VALUES(?,?,?,?,?,?,?)').run('2026-10-27', 'MLU3b', C, '2026-07-29', '2026-10-27', 50, NOW);
  sqlite.prepare('INSERT INTO comp_item_visits VALUES(?,?,?,?,?,?,?)').run('2026-10-27', 'MLU4', D, '2026-07-29', '2026-10-27', null, NOW);
  sqlite.prepare('INSERT INTO comp_item_visits VALUES(?,?,?,?,?,?,?)').run('2026-10-01', 'MLU9', A, '2026-07-03', '2026-10-01', 999, NOW - 26 * DAY);
  const visits = await loadVisitsIndex(db, NOW);
  assert.equal(visits.get(C), 80, 'dos publicaciones del mismo ISBN: máximo, no suma (pueden ser la misma ficha)');
  assert.equal(visits.has(D), false, 'visitas null = desconocidas');
  assert.equal(visits.has(A), false, 'una lectura vieja no cuenta');
  const catalog = { items: [
    { id: 'MLU1', isbn: A, title: 'A', status: 'active', available_quantity: 0, start_time: iso(500) },
    { id: 'MLU2', isbn: B, title: 'B', status: 'active', available_quantity: 2, start_time: iso(500) },
    { id: 'MLU3', isbn: C, title: 'C', status: 'active', available_quantity: 1, start_time: iso(500), catalog_listing: true, price: 100 },
    { id: 'MLU3b', isbn: C, status: 'active', available_quantity: 1, start_time: iso(300), catalog_listing: false, price: 100 },
    { id: 'MLU4', isbn: D, title: 'D', status: 'active', available_quantity: 4, start_time: iso(500) },
  ] };
  const books = [{ isbn: A, title: 'A', u90: 3, u365: 8, stock: 0 }, { isbn: B, title: 'B', u90: 0, u365: 1, stock: 2 }];
  const stock = ownStockIndex(catalog);
  const meta = new Map(catalog.items.filter(i => i.title).map(i => [i.isbn, { title: i.title, start: i.start_time }]));
  const r = longTailReview({ books, stock, meta, visits, catalog, nowMs: NOW });
  assert.equal(r.titulos_revisados, 4);
  assert.deepEqual({ q: r.conteo.quiebre, l: r.conteo.ventas_lentas, v: r.conteo.visitas_sin_conversion, s: r.conteo.sin_ventas_sin_visitas }, { q: 1, l: 1, v: 1, s: 1 });
  assert.equal(r.listas.quiebre[0].isbn, A);
  assert.equal(r.listas.visitas_sin_conversion[0].isbn, C);
  assert.equal(r.listas.sin_ventas_sin_visitas[0].isbn, D);
  assert.equal(r.visitas_observadas, 1);
  assert.deepEqual(r.capital, { ventas_lentas_unidades: 2, sin_ventas_largo_unidades: 5 });
  assert.equal(r.pares.length, 1); assert.equal(r.pares[0].revisar, false);
});
