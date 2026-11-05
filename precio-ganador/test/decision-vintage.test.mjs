import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidir, objetivoDe } from '../src/decision.mjs';

// Regla de Vintage (Seba, 05/11/2026): <= 400, 99 % del ganador, piso 1.200, sólo contra a demanda.
const V = { umbral: 400, umbralInclusivo: true, descuento: 0.01, topePct: null, piso: 1200 };
const item = (o = {}) => ({ id: 'MLU1', price: 2000, currency_id: 'UYU', variaciones: false, demanda: true, available_quantity: 1, ...o });
const demanda = ganador => ({ marcada: true, compite: true, ganador, estado: 'competing', entrega_ganador: 'demanda' });
const inmediato = ganador => ({ marcada: false, compite: true, ganador, estado: 'competing', entrega_ganador: 'inmediato', bloqueo: 'ganador_inmediato' });
const sinDato = ganador => ({ marcada: false, compite: true, ganador, estado: 'competing', entrega_ganador: 'sin_dato', bloqueo: 'ganador_sin_dato' });

test('2000 contra 1601: baja al 99 % del ganador', () => {
  const d = decidir({ item: item(), comp: demanda(1601), ...V });
  assert.deepEqual([d.accion, d.precio], ['bajar', 1584]);
  assert.equal(objetivoDe(1601, 0.01), 1584);
});
test('diferencia exacta de 400 baja; 401 no', () => {
  assert.equal(decidir({ item: item(), comp: demanda(1600), ...V }).accion, 'bajar');
  assert.equal(decidir({ item: item(), comp: demanda(1599), ...V }).accion, 'sin_tocar_umbral');
});
test('ganador de entrega inmediata: no tocar', () => {
  assert.equal(decidir({ item: item(), comp: inmediato(1900), ...V }).accion, 'saltear_ganador_inmediato');
});
test('sin dato del plazo del ganador: no tocar y registrar', () => {
  const d = decidir({ item: item(), comp: sinDato(1900), ...V });
  assert.equal(d.accion, 'saltear_ganador_sin_dato');
  assert.match(d.motivo, /sin dato/);
});
test('resultado menor a 1.200: saltear_piso', () => {
  assert.equal(decidir({ item: item({ price: 1500 }), comp: demanda(1210), ...V }).accion, 'saltear_piso');
  assert.equal(decidir({ item: item({ price: 1500 }), comp: demanda(1213), ...V }).precio, 1200);
});
test('nunca sube con esta regla', () => {
  assert.equal(decidir({ item: item(), comp: demanda(2100), ...V }).accion, 'sin_marcar');
  assert.equal(decidir({ item: item(), comp: demanda(2000), ...V }).accion, 'sin_marcar');
});
test('sin tope de porcentaje: 702 contra 400 baja (diferencia 302)', () => {
  assert.equal(decidir({ item: item({ price: 1700 }), comp: demanda(1398), ...V }).accion, 'bajar');
});

const previo = { precio_original: 2000, precio_aplicado: 1584, stock_original: 1 };
test('ya bajada: sigue al ganador a demanda al 99 %, nunca sobre el original', () => {
  const d = decidir({ item: item({ price: 1584 }), comp: demanda(1700), previo, ...V });
  assert.deepEqual([d.accion, d.precio], ['ajustar', 1683]);
  assert.equal(decidir({ item: item({ price: 1584 }), comp: demanda(2100), previo, ...V }).accion, 'restaurar');
});
test('ya bajada y el ganador de hoy entrega de inmediato: vuelve hacia el original y restaura el stock', () => {
  const d = decidir({ item: item({ price: 1584, available_quantity: 5 }), comp: { ...inmediato(1500), techo: null }, previo, tocarStock: true, ...V });
  assert.deepEqual([d.accion, d.precio, d.stock], ['restaurar', 2000, 1]);
});
test('subida limitada al 99 % del competidor a demanda más barato', () => {
  const d = decidir({ item: item({ price: 1584 }), comp: { marcada: false, compite: false, estado: 'winning', techo: 1782, techo_de: 1800 }, previo, ...V });
  assert.deepEqual([d.accion, d.precio], ['subir', 1782]);
  assert.equal(decidir({ item: item({ price: 1782 }), comp: { marcada: false, estado: 'winning', techo: 1782, techo_de: 1800 }, previo: { ...previo, precio_aplicado: 1782 }, ...V }).accion, 'mantener');
});
test('Libros sigue igual: < 360, 30 %, un peso abajo', () => {
  assert.equal(decidir({ item: item({ price: 1000, demanda: false }), comp: { marcada: true, ganador: 701 } }).accion, 'bajar');
  assert.equal(decidir({ item: item({ price: 1000, demanda: false }), comp: { marcada: true, ganador: 701 } }).precio, 701);
  assert.equal(decidir({ item: item({ price: 1000, demanda: false }), comp: { marcada: true, ganador: 699 } }).accion, 'sin_tocar_pct');
  assert.equal(decidir({ item: item({ price: 1000, demanda: false }), comp: { marcada: true, ganador: 640 } }).accion, 'sin_tocar_umbral');
  assert.equal(decidir({ item: item({ price: 800, demanda: false }), comp: { marcada: false, techo: 949 }, previo: { precio_original: 1000, precio_aplicado: 800 } }).precio, 949);
});

test('subida mínima de 10 pesos: 1 peso no se mueve, 15 sí', () => {
  const p = { precio_original: 2000, precio_aplicado: 1751 };
  assert.equal(decidir({ item: item({ price: 1751 }), comp: { marcada: false, estado: 'winning', techo: 1752, techo_de: 1770 }, previo: p, pasoMinimoSubida: 10, ...V }).accion, 'mantener');
  assert.equal(decidir({ item: item({ price: 1751 }), comp: { marcada: false, estado: 'winning', techo: 1766, techo_de: 1784 }, previo: p, pasoMinimoSubida: 10, ...V }).accion, 'subir');
});
