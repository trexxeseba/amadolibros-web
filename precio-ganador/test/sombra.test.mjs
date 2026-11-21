import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isbn13, encuadernacion, editorial, edicionDe, compararEdicion, evaluar, frenos, resumirCorrida, bajasMasGrandes, markdownRevisar, markdownSemana, tipoMotivo, SOMBRA_DEFAULT } from '../src/sombra.mjs';
import { CUENTAS } from '../src/config.mjs';

const item = (o = {}) => ({ id: 'MLU1', seller_custom_field: 'AMADO-AR-9789500000001', attributes: [
  { id: 'GTIN', value_name: '9789500000001' }, { id: 'BOOK_COVER', value_name: 'Blanda' },
  { id: 'BOOK_PUBLISHER', value_name: 'Editorial Anagrama' }, { id: 'PAGES_NUMBER', value_name: '320 páginas', value_struct: { number: 320 } }], ...o });

test('normaliza ISBN-10 a 13, tapas y editoriales', () => {
  assert.equal(isbn13('84-339-6000-0'), '9788433960009');
  assert.equal(isbn13('978-84-339-6000-9'), '9788433960009');
  assert.equal(isbn13('123'), null);
  assert.equal(encuadernacion('Tapa blanda'), 'blanda');
  assert.equal(encuadernacion('Rústica'), 'blanda');
  assert.equal(encuadernacion('Hardcover'), 'dura');
  assert.equal(editorial('Editorial Anagrama S.A.'), 'anagrama');
  assert.equal(editorial('ANAGRAMA'), 'anagrama');
});

test('compara la edición: igual, distinta y sin datos', () => {
  const nuestra = edicionDe(item());
  assert.deepEqual(nuestra.isbn, ['9789500000001']);
  assert.equal(compararEdicion(nuestra, edicionDe(item({ id: 'MLU2', seller_custom_field: null, attributes: [{ id: 'GTIN', value_name: '9789500000001' }, { id: 'BOOK_PUBLISHER', value_name: 'Anagrama' }] }))).resultado, 'igual');
  const tapa = compararEdicion(nuestra, edicionDe(item({ attributes: [{ id: 'GTIN', value_name: '9789500000001' }, { id: 'BOOK_COVER', value_name: 'Tapa dura' }] })));
  assert.equal(tapa.resultado, 'distinta');
  assert.match(tapa.diferencias[0], /tapa blanda \/ dura/);
  assert.equal(compararEdicion(nuestra, edicionDe(item({ seller_custom_field: null, attributes: [{ id: 'GTIN', value_name: '9780000000002' }] }))).resultado, 'distinta');
  // Páginas: tolera 10 % (o 10 páginas); más que eso es otra edición.
  assert.equal(compararEdicion(nuestra, edicionDe(item({ attributes: [{ id: 'GTIN', value_name: '9789500000001' }, { id: 'PAGES_NUMBER', value_name: '340' }] }))).resultado, 'igual');
  assert.equal(compararEdicion(nuestra, edicionDe(item({ attributes: [{ id: 'GTIN', value_name: '9789500000001' }, { id: 'PAGES_NUMBER', value_name: '480' }] }))).resultado, 'distinta');
  assert.equal(compararEdicion(nuestra, edicionDe({ id: 'MLU3', attributes: [] })).resultado, 'sin_datos');
  assert.equal(compararEdicion(nuestra, null).resultado, 'sin_datos');
});

// Cotizador falso: costo 1000, comisión 17 %.
const cot = { costo: 1000, queda: p => Math.round(p * 0.83 - 1000), sobre_costo: p => Math.round(((p * 0.83 - 1000) / 1000) * 1000) / 10 };
const fila = (o = {}) => ({ id: 'MLU1', titulo: 'Libro', precio: 2000, compite: true, ganador: 1700, ganador_item: 'MLU9', ganador_vendedor: 'JUANPEBOOKS', entrega_ganador: 'demanda', accion: 'sin_tocar_umbral', moneda: 'UYU', ...o });
const igual = { resultado: 'igual', diferencias: [], faltan: [] };
const opciones = { ...SOMBRA_DEFAULT, excluidos: new Set(['pocholib']) };

test('regla nueva vs actual: el margen manda en la nueva, los $400 en la actual', () => {
  const mem = { bajo_desde: 1, bajo_en: 1 };
  // Ganador 1700 → objetivo 1683: queda 1683*0.83-1000 = 397 (39.7 %); diferencia 300.
  let r = evaluar(fila(), { cot, edicion: igual, mem, corrida: 2, hoy: '2026-11-22', opciones }).fila;
  assert.equal(r.objetivo, 1683);
  assert.equal(r.actual.baja, true);
  assert.equal(r.nueva.baja, true);
  assert.equal(r.nueva.precio, 1683);
  // Diferencia 700: la actual no, la nueva sí (queda 37 %).
  r = evaluar(fila({ precio: 2400 }), { cot, edicion: igual, mem, corrida: 2, hoy: '2026-11-22', opciones }).fila;
  assert.equal(r.actual.baja, false);
  assert.match(r.actual.motivo, /diferencia 700 > 400/);
  assert.equal(r.nueva.baja, true);
  // Ganador 1400 → objetivo 1386: queda 150 (15 %), menos del 18 %.
  r = evaluar(fila({ precio: 1700, ganador: 1400 }), { cot, edicion: igual, mem, corrida: 2, hoy: '2026-11-22', opciones }).fila;
  assert.equal(r.actual.baja, true);
  assert.equal(r.nueva.baja, false);
  assert.match(r.nueva.motivo, /margen flaco/);
  // Sin costo: la nueva no baja.
  r = evaluar(fila(), { cot: null, edicion: igual, mem, corrida: 2, hoy: '2026-11-22', opciones }).fila;
  assert.match(r.nueva.motivo, /sin costo/);
});

test('las dos reglas respetan vendedor excluido, entrega inmediata, sin dato y piso', () => {
  const mem = { bajo_desde: 1, bajo_en: 1 };
  const ev = o => evaluar(fila(o), { cot, edicion: igual, mem, corrida: 2, hoy: '2026-11-22', opciones }).fila;
  assert.match(ev({ ganador_vendedor: 'POCHOLIB' }).nueva.motivo, /no competir/);
  assert.match(ev({ entrega_ganador: 'inmediato' }).nueva.motivo, /inmediato/);
  assert.match(ev({ entrega_ganador: null }).actual.motivo, /sin dato del plazo/);
  assert.match(ev({ precio: 1300, ganador: 1200 }).nueva.motivo, /piso de 1200/);
});

test('freno de edición: con otra edición no se propone bajar', () => {
  const r = evaluar(fila(), { cot, edicion: { resultado: 'distinta', diferencias: ['tapa blanda / dura'], faltan: [] }, mem: { bajo_desde: 1, bajo_en: 1 }, corrida: 2, hoy: '2026-11-22', opciones }).fila;
  assert.equal(r.nueva.baja, false);
  assert.equal(r.nueva.sin_frenos, true);
  assert.equal(r.nueva.freno, 'edicion');
  assert.equal(r.actual.freno, 'edicion');
});

test('freno de persistencia: hacen falta 2 corridas seguidas con el rival bajo', () => {
  const hoy = '2026-11-22';
  // Primera vez que se ve bajo: espera.
  const a = evaluar(fila(), { cot, edicion: igual, mem: null, corrida: 5, hoy, opciones });
  assert.equal(a.fila.nueva.baja, false);
  assert.equal(a.fila.nueva.freno, 'persistencia');
  assert.deepEqual([a.mem.bajo_desde, a.mem.bajo_en], [5, 5]);
  // Corrida siguiente, sigue bajo: baja.
  const b = evaluar(fila(), { cot, edicion: igual, mem: a.mem, corrida: 6, hoy, opciones });
  assert.equal(b.fila.nueva.baja, true);
  assert.equal(b.mem.bajo_desde, 5);
  // Si se salteó una corrida (dejó de perder en el medio), vuelve a empezar.
  const c = evaluar(fila(), { cot, edicion: igual, mem: { bajo_desde: 5, bajo_en: 5 }, corrida: 7, hoy, opciones });
  assert.equal(c.fila.nueva.freno, 'persistencia');
  assert.equal(c.mem.bajo_desde, 7);
});

test('freno de una bajada por día por publicación', () => {
  const b = evaluar(fila(), { cot, edicion: igual, mem: { bajo_desde: 1, bajo_en: 1 }, corrida: 2, hoy: '2026-11-22', opciones });
  assert.equal(b.mem.baja_nueva, '2026-11-22');
  const c = evaluar(fila(), { cot, edicion: igual, mem: b.mem, corrida: 3, hoy: '2026-11-22', opciones });
  assert.equal(c.fila.nueva.baja, false);
  assert.equal(c.fila.nueva.freno, 'una_por_dia');
  const d = evaluar(fila(), { cot, edicion: igual, mem: c.mem, corrida: 4, hoy: '2026-11-23', opciones });
  assert.equal(d.fila.nueva.baja, true);
  assert.equal(frenos(fila(), { edicion: null, mem: { bajo_desde: 1, bajo_en: 1 }, corrida: 2, hoy: 'x', clave: 'baja_nueva' }), null);
});

test('resumen, las bajas más grandes y los informes', () => {
  const mem = { bajo_desde: 1, bajo_en: 1 };
  const filas = [fila(), fila({ id: 'MLU2', precio: 2600 }), fila({ id: 'MLU3', precio: 1700, ganador: 1400 }), fila({ id: 'MLU4', entrega_ganador: 'inmediato' })]
    .map(f => evaluar(f, { cot, edicion: igual, mem, corrida: 2, hoy: '2026-11-22', opciones }).fila);
  const r = resumirCorrida(filas);
  assert.equal(r.pierden, 4);
  assert.equal(r.actual.con_frenos, 2);
  assert.equal(r.nueva.con_frenos, 2);
  assert.equal(r.ambas, 1);
  assert.equal(r.solo_nueva, 1);
  assert.equal(r.solo_actual, 1);
  assert.equal(r.nueva.motivos_no['margen flaco'], 1);
  const corridas = [{ fecha: '2026-11-22T12:00:00Z', resumen: r, filas }, { fecha: '2026-11-23T00:00:00Z', resumen: r, filas: filas.slice(0, 1) }];
  const top = bajasMasGrandes(corridas, 100);
  assert.deepEqual(top.map(f => f.id), ['MLU2', 'MLU1']);
  assert.equal(top.find(f => f.id === 'MLU1').veces, 2);
  assert.equal(bajasMasGrandes(corridas, 1).length, 1);
  assert.match(markdownRevisar(top), /MLU-2/);
  assert.match(markdownSemana({ inicio: '2026-11-22T12:00:00Z', dias: 7, corridas, top }), /Corridas registradas: 2/);
  assert.equal(tipoMotivo('diferencia 700 > 400'), 'diferencia');
  assert.equal(tipoMotivo('perderíamos plata (queda -3)'), 'perderíamos plata');
  assert.equal(tipoMotivo('bajo el piso de 1200 (objetivo 1100)'), 'bajo el piso de');
});

test('el modo sombra nunca escribe en Mercado Libre y no cambia la regla real de Vintage', () => {
  const src = readFileSync(new URL('../src/sombra.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\.put\(|method:\s*'PUT'|method:\s*'POST'/);
  assert.match(src, /\/users\/me/);
  assert.equal(CUENTAS.vintage.umbral, 400);
  assert.equal(CUENTAS.vintage.pisoPorCosto, false);
  assert.equal(CUENTAS.vintage.sombra.margen, 18);
});

test('corrida completa con Mercado Libre falso: registra, espera la segunda corrida y nunca escribe', async () => {
  const { mkdtempSync, readFileSync: leer, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { correrSombra } = await import('../src/sombra.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'sombra-'));
  const atributos = {
    MLU1: item(), MLU9: item({ id: 'MLU9', seller_custom_field: null }),
    MLU2: item({ id: 'MLU2' }), MLU8: item({ id: 'MLU8', seller_custom_field: null, attributes: [{ id: 'GTIN', value_name: '9789500000001' }, { id: 'BOOK_COVER', value_name: 'Tapa dura' }] }),
  };
  const llamadas = [];
  const ml = { get: async path => {
    llamadas.push(path);
    if (path === '/users/me') return { id: 2341378249 };
    const ids = /ids=([^&]+)/.exec(path)[1].split(',');
    return ids.map(id => ({ status_code: 200, body: atributos[id] }));
  }, put: () => { throw new Error('no debería escribir'); } };
  const filasRun = [fila(), fila({ id: 'MLU2', ganador_item: 'MLU8', precio: 2600 }), fila({ id: 'MLU5', compite: false })];
  const cargarCotizador = async () => ({ cotizar: () => cot, info: { lista_sbs: '2026-11-21', dias_lista: 0, comision: 0.17 } });
  const base = { ml, cargarCotizador, filasRun, dirEstado: join(dir, 'state'), salida: join(dir, 'sombra') };
  // 21 h de Montevideo (00 UTC del día siguiente): el archivo lleva la fecha de Montevideo.
  const a = await correrSombra({ ...base, ahora: new Date('2026-11-22T00:05:00Z') });
  assert.equal(a.corrida, 1);
  assert.equal(a.resumen.pierden, 2);
  assert.equal(a.resumen.nueva.con_frenos, 0);
  assert.equal(a.resumen.nueva.frenos.persistencia, 1);
  assert.equal(a.resumen.nueva.frenos.edicion, 1);
  assert.ok(existsSync(join(dir, 'sombra', 'vintage', '2026-11-21-21h.json')));
  const b = await correrSombra({ ...base, ahora: new Date('2026-11-22T12:05:00Z') });
  assert.equal(b.corrida, 2);
  assert.equal(b.resumen.nueva.con_frenos, 1);
  assert.equal(b.resumen.nueva.frenos.edicion, 1);
  assert.equal(b.top, 1);
  assert.match(leer(join(dir, 'sombra', 'vintage-semana.md'), 'utf8'), /Corridas registradas: 2/);
  assert.match(leer(join(dir, 'sombra', 'vintage-revisar.md'), 'utf8'), /MLU-1/);
  const mem = JSON.parse(leer(join(dir, 'state', 'vintage-sombra.json'), 'utf8'));
  assert.equal(mem.publicaciones.MLU1.baja_nueva, '2026-11-22');
  assert.ok(llamadas.every(p => p === '/users/me' || p.startsWith('/items/bulk?')));
  // Pasada la semana, no registra más.
  const c = await correrSombra({ ...base, ahora: new Date('2026-11-30T12:05:00Z') });
  assert.equal(c.terminada, true);
  // Token de otra cuenta: se corta.
  await assert.rejects(correrSombra({ ...base, ml: { ...ml, get: async () => ({ id: 123 }) }, dirEstado: join(dir, 'otra') }), /token_de_otra_cuenta/);
});
