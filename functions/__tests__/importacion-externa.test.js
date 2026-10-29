import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { parseCsv, validarMapeo, importarExterno, listImports, externalSignals, radarExterno, stockDiscrepancies, opportunitiesFromStockDiscrepancies, PLANTILLAS, num } from '../../worker-sync/importacion-externa.js';
import { opportunitiesFromRadar, cantidadSugerida } from '../../worker-sync/oportunidades.js';
import { createImportarExternoPanel } from '../panel/importar-externo.js';
import { createSessionToken, deriveSessionSecret, sessionCookieHeader } from '../_shared/panel-auth.js';

function database(t) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  const statement = (sql, args = []) => ({ sql, args, bind(...values) { return statement(sql, values); }, async first() { return sqlite.prepare(sql).get(...args) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; }, async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; } });
  return { prepare: sql => statement(sql), async batch(items) { sqlite.exec('BEGIN'); try { const r = items.map(s => ({ results: sqlite.prepare(s.sql).all(...s.args) })); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }, sqlite };
}
const NOW = Date.parse('2026-10-27T13:00:00Z'), DAY = 864e5;
const A = '9780306406157', B = '9788420412146', C = '9781418599942', D = '9780997419900';

// Archivo DE PRUEBA con la forma vista en pantalla de Administrado; no es un export real.
const CSV_ADM = `Publicación;Competidor;Precio;Vendidas ayer;Vendidas 7d;Logística
"Libro A, edición nueva";Vendedor Uno;"1.200";1;5;Full
Libro B;Vendedor Dos;990;0;2;Normal
Libro B;Vendedor Dos;990;0;2;Normal
;;;;;
`;

test('parseCsv: comillas, separador detectado, BOM y filas vacías', () => {
  const r = parseCsv('﻿' + CSV_ADM);
  assert.equal(r.delimiter, ';');
  assert.deepEqual(r.headers, ['Publicación', 'Competidor', 'Precio', 'Vendidas ayer', 'Vendidas 7d', 'Logística']);
  assert.equal(r.rows.length, 3, 'la fila vacía no cuenta');
  assert.equal(r.rows[0].fila, 2); assert.equal(r.rows[0].celdas['Publicación'], 'Libro A, edición nueva'); assert.equal(r.rows[0].celdas.Precio, '1.200');
  const c = parseCsv('a,b\n"x, y","l1\nl2"\n');
  assert.deepEqual(c.rows[0].celdas, { a: 'x, y', b: 'l1\nl2' });
});

test('num: números como los escriben las fuentes locales', () => {
  assert.deepEqual(['1.200', '1.200,50', '990', '1,5', '$ 2.350', '12.345.678', '1200.50', '', 'x'].map(num), [1200, 1200.5, 990, 1.5, 2350, 12345678, 1200.5, null, null]);
});

test('validarMapeo: sin acentos ni mayúsculas, y dice qué falta y qué encontró', () => {
  const ok = validarMapeo(['PUBLICACION', 'competidor'], { titulo: 'Publicación', vendedor: 'Competidor' });
  assert.equal(ok.ok, true); assert.deepEqual(ok.encontradas, { titulo: 'PUBLICACION', vendedor: 'competidor' });
  const bad = validarMapeo(['Título', 'Precio'], { isbn: 'GTIN', titulo: 'Título' });
  assert.equal(bad.ok, false); assert.deepEqual(bad.faltantes, ['isbn (GTIN)']); assert.deepEqual(bad.cabeceras, ['Título', 'Precio']);
});

test('importar: original con hash, trazabilidad por fila, duplicados dentro del archivo, mismo archivo no se carga dos veces, plantilla no verificada avisa', async t => {
  const db = database(t);
  const r = await importarExterno(db, { plantilla: 'administrado_competidores_ventas', extraccion: '2026-10-27', periodo_desde: '2026-10-20', periodo_hasta: '2026-10-26', completitud: 'completa', nombre_archivo: 'ventas-ayer.csv', csv: CSV_ADM }, NOW);
  assert.equal(r.duplicado, false);
  assert.deepEqual({ t: r.filas_total, v: r.filas_validas, i: r.filas_invalidas, d: r.filas_duplicadas }, { t: 3, v: 3, i: 0, d: 1 });
  assert.equal(r.plantilla_verificada, false); assert.match(r.advertencia, /no verificada/);
  assert.equal(r.columnas.titulo, 'Publicación');
  const rows = db.sqlite.prepare('SELECT fila,titulo,vendedor,precio,vendidas,vendidas_ayer,ventana_dias,logistica,estimado,valida,duplicada_de,isbn FROM ext_rows ORDER BY fila').all().map(x => ({ ...x }));
  assert.deepEqual(rows[0], { fila: 2, titulo: 'Libro A, edición nueva', vendedor: 'Vendedor Uno', precio: 1200, vendidas: 5, vendidas_ayer: 1, ventana_dias: 7, logistica: 'Full', estimado: 1, valida: 1, duplicada_de: null, isbn: null });
  assert.equal(rows[2].duplicada_de, 3, 'la tercera fila repite la segunda');
  assert.match(db.sqlite.prepare('SELECT raw_json FROM ext_rows WHERE fila=2').get().raw_json, /"Precio":"1\.200"/, 'la línea cruda queda guardada');
  const imp = db.sqlite.prepare('SELECT * FROM ext_imports').get();
  assert.equal(imp.original_text, CSV_ADM); assert.equal(imp.completitud, 'completa'); assert.equal(imp.fuente, 'administrado'); assert.equal(imp.ventana_dias, 7);
  assert.match(imp.id, /^[a-f0-9]{64}$/);
  // Mismo archivo otra vez: no se duplica.
  const again = await importarExterno(db, { plantilla: 'administrado_competidores_ventas', csv: CSV_ADM }, NOW + DAY);
  assert.equal(again.duplicado, true); assert.equal(again.import_id, r.import_id);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM ext_imports').get().n, 1);
  assert.equal((await listImports(db)).length, 1);
  // Columnas que no están: error con las cabeceras encontradas, nada cargado.
  await assert.rejects(() => importarExterno(db, { plantilla: 'nubimetrics_competidor_publicaciones', csv: 'Titulo,Precio\nx,1\n' }, NOW), e => e.code === 'columnas_faltantes' && e.detail.faltantes.join() === 'isbn (gtin),precio (precio promedio)' && e.detail.cabeceras_encontradas.join() === 'Titulo,Precio');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM ext_imports').get().n, 1);
  await assert.rejects(() => importarExterno(db, { fuente: 'otra', tipo: 'otro', csv: 'a\n1\n' }, NOW), /mapeo_requerido/);
  await assert.rejects(() => importarExterno(db, { fuente: 'x', tipo: 'otro', csv: 'a\n1\n', mapeo: { columnas: { titulo: 'a' } } }, NOW), /fuente_invalida/);
  await assert.rejects(() => importarExterno(db, { plantilla: 'administrado_competidores_ventas', csv: CSV_ADM, extraccion: '27/10/2026' }, NOW), /fechas_invalidas/);
  assert.equal(PLANTILLAS.administrado_competidores_ventas.verificado, false);
});

test('señales externas por ISBN: última observación por fuente y ventana, nunca sumadas; radar de ISBN externos con cruces propios', async t => {
  const db = database(t);
  const nubi = (vend, days) => `Título,GTIN,Precio promedio\nLibro A,${A},${days}00\nLibro Nuevo,${B},${days}50\n`;
  // Dos exportes de Nubimetrics del mismo vendedor en días distintos, y uno de Administrado con "vendidas 7d".
  await importarExterno(db, { plantilla: 'nubimetrics_competidor_publicaciones', vendedor: 'RIVAL', extraccion: '2026-10-20', csv: nubi('RIVAL', 1) }, NOW - 7 * DAY);
  await importarExterno(db, { plantilla: 'nubimetrics_competidor_publicaciones', vendedor: 'RIVAL', extraccion: '2026-10-27', csv: nubi('RIVAL', 2) }, NOW);
  await importarExterno(db, { fuente: 'administrado', tipo: 'competidores_ventas', ventana_dias: 7, extraccion: '2026-10-27', mapeo: { columnas: { isbn: 'ISBN', vendedor: 'Competidor', vendidas: 'Vendidas 7d' } }, csv: `ISBN,Competidor,Vendidas 7d\n${A},RIVAL,4\n${B},RIVAL,9\n${B},OTRO,3\n` }, NOW);
  const sig = await externalSignals(db, [A, B, '9781418599942']);
  const a = sig.get(A);
  assert.equal(a.length, 2, 'una por fuente/vendedor/ventana');
  const n = a.find(x => x.fuente === 'nubimetrics');
  assert.equal(n.precio, 200, 'la observación más reciente, no la suma ni el promedio'); assert.equal(n.etiqueta, 'estimado'); assert.equal(n.extraccion, '2026-10-27');
  const adm = a.find(x => x.fuente === 'administrado');
  assert.deepEqual({ v: adm.vendidas, w: adm.ventana_dias, vend: adm.vendedor }, { v: 4, w: 7, vend: 'RIVAL' });
  assert.equal(sig.get(B).length, 3, 'dos vendedores de Administrado y uno de Nubimetrics');
  assert.equal(sig.has('9781418599942'), false);
  // Radar: B no está en nuestro catálogo; lo buscaron en la web y alguien está en lista de espera.
  db.sqlite.exec(`CREATE TABLE search_misses(date TEXT,query TEXT,count INTEGER,first_seen TEXT,last_seen TEXT); INSERT INTO search_misses VALUES('2026-10-25','libro nuevo',3,'x','x'); INSERT INTO search_misses VALUES('2026-01-01','libro nuevo',9,'x','x');
    CREATE TABLE stock_waitlist(id TEXT,product_id TEXT,product_title TEXT,email TEXT,status TEXT); INSERT INTO stock_waitlist VALUES('1','p','Libro Nuevo','a@x','waiting'); INSERT INTO stock_waitlist VALUES('2','p','Libro Nuevo','b@x','notified');`);
  const radar = await radarExterno(db, { items: [{ isbn: A, status: 'active' }] }, { nowMs: NOW });
  assert.equal(radar.length, 1); assert.equal(radar[0].isbn, B);
  assert.deepEqual({ f: radar[0].fuentes, v: radar[0].vendedores, max: radar[0].vendidas_max, b: radar[0].buscado_sin_resultado, e: radar[0].lista_espera }, { f: 2, v: 2, max: 9, b: 3, e: 1 });
  // A la bandeja: prueba de 1, provisional; nunca 2 o 3 por una señal externa.
  const ops = opportunitiesFromRadar(radar, { nowMs: NOW });
  assert.equal(ops.length, 1); assert.equal(ops[0].cantidad, 1); assert.equal(ops[0].cantidad_nivel, 'provisional'); assert.equal(ops[0].confianza, 'media');
  assert.match(ops[0].evidencia.texto, /según administrado y nubimetrics|según nubimetrics y administrado/);
  assert.match(ops[0].evidencia.texto, /3 búsquedas sin resultado en la web \(libro nuevo\); 1 en lista de espera; 2 fuentes externas distintas/);
  assert.equal(opportunitiesFromRadar([{ ...radar[0], buscado_sin_resultado: 0, lista_espera: 0, fuentes: 1 }]).length, 0, 'una fuente sola sin cruce propio no entra');
  assert.equal(cantidadSugerida({ senal_externa: true, u90: 0, u365: 0 }).cantidad, 1);
});

test('panel de importación: exige sesión, carga un CSV y muestra el error de columnas con las cabeceras encontradas', async t => {
  const db = database(t);
  const env = { APP_ENV: 'production', PANEL_PASSWORD: 'una-clave-larga', ORDERS_DB: db };
  const handler = createImportarExternoPanel({ now: () => NOW });
  assert.equal((await handler({ request: new Request('https://www.amadolibros.com/panel/importar-externo'), env })).status, 303);
  const cookie = sessionCookieHeader(await createSessionToken(await deriveSessionSecret(env.PANEL_PASSWORD))).split(';')[0];
  const get = await handler({ request: new Request('https://www.amadolibros.com/panel/importar-externo', { headers: { cookie } }), env });
  assert.equal(get.status, 200); assert.match(await get.text(), /administrado_competidores_ventas \(no verificada\)/);
  const post = body => handler({ request: new Request('https://www.amadolibros.com/panel/importar-externo', { method: 'POST', headers: { cookie, origin: 'https://www.amadolibros.com', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }), env });
  const ok = await post({ plantilla: 'administrado_competidores_ventas', fuente: 'administrado', tipo: 'competidores_ventas', completitud: 'parcial', extraccion: '2026-10-27', csv: CSV_ADM, nombre_archivo: 'x.csv' });
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.match(html, /3 filas válidas, 0 inválidas, 1 duplicadas/); assert.match(html, /Plantilla no verificada/); assert.match(html, /x\.csv/);
  const bad = await post({ fuente: 'otra', tipo: 'otro', completitud: 'desconocida', mapeo: '{"columnas":{"isbn":"GTIN"}}', csv: 'Codigo,Nombre\n1,2\n' });
  assert.equal(bad.status, 422); assert.match(await bad.text(), /columnas_faltantes.*Codigo.*Nombre/s);
  assert.equal((await post({ fuente: 'otra', tipo: 'otro', completitud: 'desconocida', mapeo: '{no json', csv: 'a\n1' })).status, 400);
  const foreign = await handler({ request: new Request('https://www.amadolibros.com/panel/importar-externo', { method: 'POST', headers: { cookie, origin: 'https://otro.example' }, body: new URLSearchParams({ csv: 'a' }) }), env });
  assert.equal(foreign.status, 403);
});

test('cruce con proveedores: compra previa y stock de SBS convierten el hallazgo externo en "sabemos dónde conseguirlo"', async t => {
  const db = database(t);
  const { importPurchases } = await import('../../worker-sync/purchases.js');
  // B: no está en nuestro catálogo, Nubimetrics lo ve, y ya lo compramos antes a Celesa.
  await importarExterno(db, { plantilla: 'nubimetrics_competidor_publicaciones', vendedor: 'RIVAL', extraccion: '2026-10-27', csv: `Título,GTIN,Precio promedio\nLibro Nuevo,${B},900\n` }, NOW);
  await importPurchases(db, { supplier: 'Celesa', document_type: 'invoice', document_number: 'F9', document_date: '2026-09-01', items: [{ isbn: B, title: 'Libro Nuevo', quantity: 3 }] }, NOW);
  let radar = await radarExterno(db, { items: [] }, { nowMs: NOW });
  assert.equal(radar.length, 1);
  assert.equal(radar[0].proveedores_conocidos.length, 1);
  assert.equal(radar[0].proveedores_conocidos[0].proveedor, 'CELESA');
  assert.equal(radar[0].sbs, null);
  // El proveedor conocido también cuenta como cruce propio: entra sin búsqueda ni lista de espera.
  let ops = opportunitiesFromRadar(radar, { nowMs: NOW });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].confianza, 'media');
  assert.match(ops[0].accion, /^Probar con 1: ya lo compramos antes a CELESA$/);
  assert.deepEqual(ops[0].evidencia.faltantes, ['costo', 'ventas_propias']);
  assert.match(ops[0].evidencia.cruces.join(';'), /ya lo compramos antes: CELESA \(2026-09-01\)/);
  // Ahora aparece en el feed vigente de SBS con stock: abastecimiento inmediato, confianza alta.
  db.sqlite.exec(`CREATE TABLE sbs_supplier_feeds(id TEXT PRIMARY KEY,source_date TEXT,source_sha256 TEXT,state TEXT,expected_rows INTEGER,created_at INTEGER,checked_at INTEGER);
    CREATE TABLE sbs_supplier_stock(feed_id TEXT,isbn TEXT,data_json TEXT);`);
  db.sqlite.prepare('INSERT INTO sbs_supplier_feeds VALUES(?,?,?,?,?,?,?)').run('f1', '2026-10-26', 'x', 'ready', 1, 0, 0);
  db.sqlite.prepare('INSERT INTO sbs_supplier_stock VALUES(?,?,?)').run('f1', B, JSON.stringify({ isbn: B, stock: '5' }));
  radar = await radarExterno(db, { items: [] }, { nowMs: NOW });
  assert.deepEqual(radar[0].sbs, { disponible: '5', feed_fecha: '2026-10-26' });
  ops = opportunitiesFromRadar(radar, { nowMs: NOW });
  assert.equal(ops[0].confianza, 'alta');
  assert.equal(ops[0].accion, 'Pedir 1 a SBS (disponible hoy)');
  assert.ok(!ops[0].evidencia.faltantes.includes('proveedor'));
  assert.match(ops[0].evidencia.cruces.join(';'), /SBS lo tiene disponible hoy \(5 u\., feed del 2026-10-26\)/);
  // Sin proveedor ni SBS, "proveedor" queda entre los faltantes y la acción lo dice.
  const sinProveedor = { isbn: 'X', titulo: 'Y', fuentes: 1, fuentes_lista: ['nubimetrics'], vendedores: 1, vendidas_max: null, ventana_dias: null, precio_min: null, buscado_sin_resultado: 2, busquedas: ['y'], lista_espera: 0, proveedores_conocidos: [], sbs: null };
  const op2 = opportunitiesFromRadar([sinProveedor], { nowMs: NOW })[0];
  assert.ok(op2.evidencia.faltantes.includes('proveedor'));
  assert.match(op2.accion, /sin proveedor conocido, conseguir uno antes de pedir/);
  // Sin compras cargadas en absoluto (tabla ni existe): no revienta, cruce vacío.
  const db2 = database(t);
  await importarExterno(db2, { plantilla: 'nubimetrics_competidor_publicaciones', vendedor: 'RIVAL', extraccion: '2026-10-27', csv: `Título,GTIN,Precio promedio\nOtro,${B},900\n` }, NOW);
  const radar2 = await radarExterno(db2, { items: [] }, { nowMs: NOW });
  assert.deepEqual(radar2[0].proveedores_conocidos, []);
  assert.equal(radar2[0].sbs, null);
});

// Pedido de reposición de Administrado (DE PRUEBA: títulos y cifras
// inventados con la misma forma que confirmó Seba el 28/10/2026: FULL =
// Mercado Envíos Full, Depósito = stock normal, "sin stock" cuando ninguno
// de los dos tiene.
const CSV_REPOSICION = `Publicación;SKU;Número;FULL;Depósito;Ventas por día;Días de stock;Pedir (u.) · 30 días + 15 de demora
Libro A de Prueba;${A};MLU1000001;;;0,07;sin stock;4
Libro B de Prueba;${B};MLU1000002;1;0;0,12;8,5;5
Libro C de Prueba;${C};MLU1000003;3;2;0,1;30,6;2
Libro D de Prueba;${D};MLU1000004;;;0,05;sin stock;3
`;

test('plantilla administrado_pedido_reposicion: FULL/Depósito/Pedir se leen como números, "sin stock" como ausencia (no como cero)', async t => {
  const db = database(t);
  const r = await importarExterno(db, { plantilla: 'administrado_pedido_reposicion', extraccion: '2026-10-28', csv: CSV_REPOSICION }, NOW);
  assert.equal(r.duplicado, false);
  assert.equal(r.plantilla_verificada, true, 'Seba confirmó FULL/Depósito: esta plantilla no queda marcada como sin verificar');
  assert.equal(r.filas_validas, 4);
  const rows = db.sqlite.prepare('SELECT isbn,mlu,full_stock,deposito_stock,dias_stock,pedir_sugerido FROM ext_rows WHERE import_id=? ORDER BY fila').all(r.import_id).map(x => ({ ...x }));
  assert.deepEqual(rows[0], { isbn: A, mlu: 'MLU1000001', full_stock: null, deposito_stock: null, dias_stock: null, pedir_sugerido: 4 });
  assert.deepEqual(rows[1], { isbn: B, mlu: 'MLU1000002', full_stock: 1, deposito_stock: 0, dias_stock: 8.5, pedir_sugerido: 5 });
});

test('stockDiscrepancies: sólo marca cuando una fuente dice "hay" y la otra "no hay"; una diferencia de cantidad entre las dos no alcanza', async t => {
  const db = database(t);
  await importarExterno(db, { plantilla: 'administrado_pedido_reposicion', extraccion: '2026-10-28', csv: CSV_REPOSICION }, NOW - 2 * DAY);
  const catalog = { updated_at: new Date(NOW - 6 * 3600000).toISOString(), items: [
    { id: 'MLU1', isbn: A, status: 'active', available_quantity: 2, catalog_listing: false }, // catálogo dice 2, Administrado dice "sin stock": discrepancia
    { id: 'MLU2', isbn: B, status: 'paused', available_quantity: 5 }, // pausada no cuenta: catálogo dice 0; Administrado dice 1: discrepancia
    { id: 'MLU3', isbn: C, status: 'active', available_quantity: 1 }, // las dos dicen "hay", aunque las cantidades no coincidan (1 vs 5): no se marca
    { id: 'MLU4', isbn: D, status: 'active', available_quantity: 0 }, // las dos dicen "no hay": no se marca
  ] };
  const result = await stockDiscrepancies(db, catalog, { nowMs: NOW });
  assert.equal(result.import.extraccion, '2026-10-28');
  const byIsbn = Object.fromEntries(result.discrepancias.map(d => [d.isbn, d]));
  assert.deepEqual(Object.keys(byIsbn).sort(), [A, B]);
  assert.equal(byIsbn[A].motivo, 'catalogo_tiene_administrado_no');
  assert.deepEqual([byIsbn[A].catalogo_stock, byIsbn[A].administrado_total], [2, 0]);
  assert.equal(byIsbn[B].motivo, 'administrado_tiene_catalogo_no');
  assert.deepEqual([byIsbn[B].catalogo_stock, byIsbn[B].administrado_full, byIsbn[B].administrado_deposito], [0, 1, 0]);
  assert.equal(byIsbn[A].catalogo_actualizado, catalog.updated_at);
  // Sin ninguna carga de tipo stock_propio: no hay nada que cruzar, no revienta.
  const vacio = await stockDiscrepancies(database(t), catalog, { nowMs: NOW });
  assert.deepEqual(vacio, { import: null, discrepancias: [] });
});

test('opportunitiesFromStockDiscrepancies: confianza alta siempre (dos fuentes independientes), muestra las dos cifras con su antigüedad y nunca dice cuál tiene razón', async t => {
  const db = database(t);
  await importarExterno(db, { plantilla: 'administrado_pedido_reposicion', extraccion: '2026-10-28', csv: CSV_REPOSICION }, NOW - 2 * DAY);
  const catalog = { updated_at: new Date(NOW - 2 * DAY).toISOString(), items: [
    { id: 'MLU1', isbn: A, status: 'active', available_quantity: 2 },
    { id: 'MLU2', isbn: B, status: 'paused', available_quantity: 5 },
    { id: 'MLU3', isbn: C, status: 'active', available_quantity: 1 }, // las dos dicen "hay": no entra a la bandeja
    { id: 'MLU4', isbn: D, status: 'active', available_quantity: 0 }, // las dos dicen "no hay": no entra a la bandeja
  ] };
  const result = await stockDiscrepancies(db, catalog, { nowMs: NOW });
  const ops = opportunitiesFromStockDiscrepancies(result, { nowMs: NOW });
  assert.equal(ops.length, 2);
  const a = ops.find(o => o.isbn === A), b = ops.find(o => o.isbn === B);
  assert.equal(a.tipo, 'revisar_stock'); assert.equal(a.confianza, 'alta'); assert.equal(a.impacto_mes, null);
  assert.equal(a.accion, 'Revisar: el catálogo tiene 2 pero Administrado dice sin stock');
  assert.equal(a.evidencia.catalogo_antiguedad_dias, 2); assert.equal(a.evidencia.administrado_antiguedad_dias, 2);
  assert.match(a.evidencia.texto, /Nuestro catálogo \(actualizado hace 2 días\) dice 2 en stock; el pedido de reposición de Administrado \(de hace 2 días\) dice 0 \(FULL 0 \+ Depósito 0\)/);
  assert.equal(a.enlaces.ml, 'https://articulo.mercadolibre.com.uy/MLU-1000001');
  assert.equal(b.accion, 'Revisar: Administrado dice 1 pero el catálogo tiene 0');
  assert.deepEqual(opportunitiesFromStockDiscrepancies({ import: null, discrepancias: [] }), []);
});
