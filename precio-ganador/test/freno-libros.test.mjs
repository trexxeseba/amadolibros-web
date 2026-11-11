// Libros sin freno de $360 (Seba, 12/11/2026), con red: 50 % y $500.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CUENTAS } from '../src/config.mjs';
import { decidir } from '../src/decision.mjs';

const L = CUENTAS.libros;
const reglas = { umbral: L.umbral, topePct: L.topePct, umbralInclusivo: L.umbralInclusivo === true, descuento: L.descuento ?? 0, pasoMinimoSubida: L.pasoMinimoSubida };
const item = price => ({ id: 'MLU1', price, currency_id: 'UYU', variaciones: false, demanda: false, available_quantity: 1 });
const pierde = ganador => ({ marcada: true, ganador, estado: 'competing' });

test('baja aunque la diferencia pase $360 (Fantastic Mr. Fox: 1400 → 747)', () => {
  const d = decidir({ item: item(1400), comp: pierde(747), piso: L.minimo, ...reglas });
  assert.deepEqual([d.accion, d.precio], ['bajar', 747]);
});
test('no baja más del 50 % (A mí no me va a pasar: 2800 vs 671)', () => {
  assert.equal(decidir({ item: item(2800), comp: pierde(671), piso: L.minimo, ...reglas }).accion, 'sin_tocar_pct');
});
test('nunca por debajo de $500', () => {
  assert.equal(decidir({ item: item(900), comp: pierde(480), piso: L.minimo, ...reglas }).accion, 'saltear_piso');
});
