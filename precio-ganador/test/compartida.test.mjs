// Comparte el primer lugar: 1 % para ganar sola (Seba, 11/11/2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidir } from '../src/decision.mjs';

const AHORA = Date.parse('2026-11-11T15:00:00Z');
const item = (price) => ({ id: 'MLU884315176', price, currency_id: 'UYU', variaciones: false, demanda: false, available_quantity: 1 });
const comparte = { marcada: false, compite: false, estado: 'sharing_first_place' };
const L = { ganarCompartida: true, ahora: AHORA, pasoMinimoSubida: 10 };

test('nueva que comparte: baja 1 % (hacia abajo al peso) y anota la fecha', () => {
  const d = decidir({ item: item(2869), comp: comparte, ...L });
  assert.deepEqual([d.accion, d.precio], ['bajar', 2840]);
  assert.equal(d.memoria.compartida_fecha, new Date(AHORA).toISOString());
});
test('apagado (Vintage o sin la opción): no se toca', () => {
  assert.equal(decidir({ item: item(2869), comp: comparte, ahora: AHORA }).accion, 'sin_marcar');
});
test('ya bajada que comparte: 1 % una vez; si el otro iguala, no lo persigue por 3 días', () => {
  const previo = { precio_original: 2899, precio_aplicado: 2869 };
  const d = decidir({ item: item(2869), comp: comparte, previo, ...L });
  assert.deepEqual([d.accion, d.precio], ['ajustar', 2840]);
  const otra = decidir({ item: item(2840), comp: comparte, previo: { ...previo, precio_aplicado: 2840, compartida_fecha: new Date(AHORA - 3600e3).toISOString() }, ...L });
  assert.equal(otra.accion, 'mantener');
  const despues = decidir({ item: item(2840), comp: comparte, previo: { ...previo, precio_aplicado: 2840, compartida_fecha: new Date(AHORA - 4 * 86400e3).toISOString() }, ...L });
  assert.deepEqual([despues.accion, despues.precio], ['ajustar', 2811]);
});
test('respeta piso, promo y tope contra el original', () => {
  assert.equal(decidir({ item: item(2869), comp: comparte, piso: 2860, ...L }).accion, 'saltear_piso');
  assert.equal(decidir({ item: item(2869), comp: comparte, promo: true, ...L }).accion, 'saltear_promo');
  assert.equal(decidir({ item: item(1000), comp: comparte, previo: { precio_original: 1400, precio_aplicado: 1000 }, ...L }).accion, 'mantener_umbral');
});
test('la que gana sola no se toca', () => {
  assert.equal(decidir({ item: item(2869), comp: { marcada: false, estado: 'winning' }, ...L }).accion, 'sin_marcar');
});
