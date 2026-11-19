import test from 'node:test';
import assert from 'node:assert/strict';
import {ofertaDeHermes, estadoFicha, cambioDePrecio, fallaGeneral, ultimosPorFicha, armarResumen} from '../../hermes-monitor/lib.mjs';
import {correr} from '../../hermes-monitor/chequeo.mjs';

test('ofertaDeHermes encuentra al vendedor de Hermes o devuelve null', () => {
  assert.equal(ofertaDeHermes([{seller_id: 1}, {seller_id: 471589392, price: 10}]).price, 10);
  assert.equal(ofertaDeHermes([{seller_id: 1}]), null);
  assert.equal(ofertaDeHermes(undefined), null);
});

test('estadoFicha: un error nunca cuenta como sin oferta', () => {
  assert.equal(estadoFicha({error: 'http_500'}), 'error');
  assert.equal(estadoFicha({oferta: null}), 'sin_oferta');
  assert.equal(estadoFicha({oferta: {price: 1}}), 'ofrece');
});

test('cambioDePrecio solo avisa por más del 5 %', () => {
  assert.equal(cambioDePrecio(1000, 1040), null);
  assert.ok(cambioDePrecio(1000, 1060) > 0.05);
  assert.ok(cambioDePrecio(1000, 900) < -0.05);
  assert.equal(cambioDePrecio(null, 900), null);
});

test('fallaGeneral frena cuando casi todas desaparecen', () => {
  assert.equal(fallaGeneral(Array(30).fill('sin_oferta')), true);
  assert.equal(fallaGeneral([...Array(28).fill('ofrece'), 'sin_oferta', 'sin_oferta']), false);
  assert.equal(fallaGeneral(['sin_oferta', 'sin_oferta']), false);
});

function mlFalso({ofrecen, items = {}}) {
  const puts = [];
  return {puts, get: async p => {
    const m = p.match(/\/products\/(MLU\d+)\/items/);
    if (m) return {paging: {total: 1}, results: ofrecen.includes(m[1]) ? [{seller_id: 471589392, price: 1000, item_id: 'MLU1'}] : [{seller_id: 9, price: 500}]};
    const it = p.match(/\/items\/(MLU\d+)$/)?.[1];
    return items[it] ?? null;
  }, put: async (p, b) => { puts.push([p, b]); items[p.split('/').pop()] = {...items[p.split('/').pop()], status: b.status}; return {}; }};
}
const fichas = n => Array.from({length: n}, (_, i) => ({n: i + 1, titulo: `L${i + 1}`, producto: `MLU${100 + i}`, mi_mlu: i === 0 ? 'MLU900' : null}));

test('pausa la publicación mía solo si Hermes dejó de ofrecer y es de Amado Libros', async () => {
  const f = fichas(25);
  const ml = mlFalso({ofrecen: f.slice(1).map(x => x.producto), items: {MLU900: {seller_id: 2341378249, status: 'active'}}});
  const r = await correr({fichas: f, historial: [], real: true, ml, pausaMs: 0});
  assert.equal(r.pausadas.length, 1);
  assert.deepEqual(ml.puts, [['/items/MLU900', {status: 'paused'}]]);
  assert.match(r.resumen, /1 sin oferta/);
});

test('sin --real no pausa y no toca publicaciones de otra cuenta', async () => {
  const f = fichas(25);
  const ml = mlFalso({ofrecen: f.slice(1).map(x => x.producto), items: {MLU900: {seller_id: 2341378249, status: 'active'}}});
  const r = await correr({fichas: f, historial: [], real: false, ml, pausaMs: 0});
  assert.equal(ml.puts.length, 0);
  assert.equal(r.pausadas[0].resultado, 'se_pausaria');
  const ml2 = mlFalso({ofrecen: f.slice(1).map(x => x.producto), items: {MLU900: {seller_id: 123, status: 'active'}}});
  const r2 = await correr({fichas: f, historial: [], real: true, ml: ml2, pausaMs: 0});
  assert.equal(ml2.puts.length, 0);
  assert.equal(r2.pausadas[0].resultado, 'no_es_de_vintage_no_se_toca');
});

test('si casi todas desaparecen de golpe no pausa nada', async () => {
  const f = fichas(30);
  const ml = mlFalso({ofrecen: [], items: {MLU900: {seller_id: 2341378249, status: 'active'}}});
  const r = await correr({fichas: f, historial: [], real: true, ml, pausaMs: 0});
  assert.equal(r.falla, true);
  assert.equal(ml.puts.length, 0);
});

test('detecta cambio de precio contra el historial', async () => {
  const f = fichas(1).map(x => ({...x, mi_mlu: null}));
  const ml = mlFalso({ofrecen: [f[0].producto]});
  const r = await correr({fichas: f, historial: [{fecha: '2026-11-17', producto: f[0].producto, precio: 800}], real: false, ml, pausaMs: 0});
  assert.equal(r.cambios.length, 1);
  assert.match(r.resumen, /de \$800 a \$1000/);
});

import {precioMio, armarPayload} from '../../hermes-monitor/lib.mjs';
test('precioMio es 1 % menos que Hermes, en pesos enteros', () => {
  assert.equal(precioMio(1810), 1792);
  assert.equal(precioMio(1000), 990);
});
test('armarPayload: catálogo directo, 1 unidad, UYU, nuevo, sin tocar nada más', () => {
  const p = armarPayload({producto: 'MLU1', precio: 990, categoria: 'MLU1196', nombre: 'Libro', familyName: 'Fam', usaFamilyName: false, isbn: '978'});
  assert.equal(p.available_quantity, 1);
  assert.equal(p.catalog_listing, true);
  assert.equal(p.catalog_product_id, 'MLU1');
  assert.equal(p.currency_id, 'UYU');
  assert.equal(p.title, 'Libro');
  assert.equal(armarPayload({producto: 'MLU1', precio: 1, categoria: 'x', nombre: 'a', familyName: 'Fam', usaFamilyName: true}).family_name, 'Fam');
});

import {CUENTA_HERMES, inicioDiaUy} from '../../hermes-monitor/lib.mjs';
import {CUENTAS} from '../../precio-ganador/src/config.mjs';
test('Hermes va siempre a Amado Vintage y nunca a Amado Libros', () => {
  assert.equal(CUENTA_HERMES, 'vintage');
  assert.equal(CUENTAS[CUENTA_HERMES].sellerId, '2341378249');
});
test('inicioDiaUy cae a las 00:00 de Montevideo (03:00 UTC)', () => {
  const i = inicioDiaUy(Date.UTC(2026, 10, 18, 13, 0));
  assert.equal(new Date(i).toISOString(), '2026-11-18T03:00:00.000Z');
});

test('armarPayload con plazo declara disponibilidad a demanda y una sola unidad', () => {
  const p = armarPayload({producto: 'MLU1', precio: 2040, categoria: 'MLU1196', nombre: 'Libro', familyName: 'Fam', usaFamilyName: false, isbn: '978', plazoDias: 20});
  assert.deepEqual(p.sale_terms, [{id: 'MANUFACTURING_TIME', value_name: '20 días'}]);
  assert.equal(p.available_quantity, 1);
  assert.equal(armarPayload({producto: 'MLU1', precio: 1, categoria: 'x', nombre: 'a', familyName: 'f', usaFamilyName: false}).sale_terms, undefined);
});
test('la lista de Arnoia: 395 libros, EAN únicos y precios sobre el mínimo de Vintage', async () => {
  const fs = await import('node:fs');
  const d = JSON.parse(fs.readFileSync('hermes-monitor/data/arnoia-semana-45.json', 'utf8'));
  assert.equal(d.libros.length, 395);
  assert.equal(new Set(d.libros.map(l => l.ean)).size, 395);
  assert.ok(d.libros.every(l => /^\d{13}$/.test(l.ean) && l.precio >= 1200));
  assert.equal(d.plazo_dias, 20);
});

import {armarPayloadTradicional, paqueteDeVendedor, normalizarTitulo, normalizarAutor} from '../../hermes-monitor/lib.mjs';
test('publicación normal de Arnoia: sin catálogo, con portada, medidas del paquete y plazo', () => {
  const p = armarPayloadTradicional({ean: '9788408328834', titulo: 'HORA ANTES DEL ALBA, LA (PREMIO PLANETA 2026)', autor: 'ALLENDE, ISABEL', editorial: 'PLANETA', precio: 2630, plazoDias: 20, usaFamilyName: false, imagenes: ['https://x/y.jpg'], pesoGramos: 500});
  assert.equal(p.catalog_listing, false);
  assert.equal(p.catalog_product_id, undefined);
  assert.equal(p.title, 'La Hora Antes Del Alba - Isabel Allende');
  assert.equal(p.available_quantity, 1);
  assert.deepEqual(p.pictures, [{source: 'https://x/y.jpg'}]);
  assert.deepEqual(p.sale_terms, [{id: 'MANUFACTURING_TIME', value_name: '20 días'}]);
  assert.ok(['SELLER_PACKAGE_HEIGHT', 'SELLER_PACKAGE_LENGTH', 'SELLER_PACKAGE_WIDTH', 'SELLER_PACKAGE_WEIGHT'].every(id => p.attributes.some(a => a.id === id)));
  assert.equal(paqueteDeVendedor(500).find(a => a.id === 'SELLER_PACKAGE_WEIGHT').value_name, '800 g');
  assert.equal(normalizarAutor('ALLENDE, ISABEL'), 'Isabel Allende');
  assert.equal(normalizarTitulo('MURDOKU: 80 ACERTIJOS'), 'Murdoku: 80 Acertijos');
});

test('la lista nueva de Arnoia (19/11): libros disponibles, sin riesgo de propiedad intelectual, sobre el mínimo, con ranking primero', async () => {
  const fs = await import('node:fs');
  const d = JSON.parse(fs.readFileSync('hermes-monitor/data/arnoia-catalogo-19-11.json', 'utf8'));
  assert.ok(d.libros.length > 4000);
  assert.equal(new Set(d.libros.map(l => l.ean)).size, d.libros.length);
  assert.ok(d.libros.every(l => /^\d{13}$/.test(l.ean) && l.precio >= 1200 && l.peso_g > 0));
  assert.ok(d.libros[0].unidades >= d.libros[100].unidades);
  assert.equal(d.plazo_dias, 20);
});

test('la lista de Arnoia solo trae libros disponibles', async () => {
  const fs = await import('node:fs');
  const d = JSON.parse(fs.readFileSync('hermes-monitor/data/arnoia-catalogo-19-11.json', 'utf8'));
  assert.match(d.nota, /Disponible/);
});

test('los 15 libros aprobados por Seba solo se eximen del grupo copia', async () => {
  const fs = await import('node:fs');
  const {ipRisk} = await import('../../worker-sync/ip-risk.js');
  const d = JSON.parse(fs.readFileSync('hermes-monitor/data/arnoia-catalogo-19-11.json', 'utf8'));
  const ap = d.libros.filter(l => l.aprobado_por_seba);
  assert.equal(ap.length, 15);
  for (const l of ap) assert.equal(ipRisk(`${l.titulo} ${l.autor ?? ''}`, l.editorial), 'copia', l.titulo);
  assert.match(fs.readFileSync('hermes-monitor/publicar.mjs', 'utf8'), /riesgo && !\(ctx\.aprobado && riesgo === 'copia'\)/);
});
