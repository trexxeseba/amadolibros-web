import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidir } from '../src/decision.mjs';

const item = (o = {}) => ({ id: 'MLU1', price: 1000, currency_id: 'UYU', variaciones: false, demanda: false, available_quantity: 1, ...o });
const marcada = ganador => ({ marcada: true, ganador, estado: 'competing' });

test('baja al ganador si la diferencia es menor a 360', () => {
  assert.deepEqual(decidir({ item: item(), comp: marcada(700) }).accion, 'bajar');
  assert.equal(decidir({ item: item(), comp: marcada(700) }).precio, 700);
});
test('no toca con diferencia de 360 o más', () => {
  assert.equal(decidir({ item: item({ price: 2000 }), comp: marcada(1640) }).accion, 'sin_tocar_umbral');
  assert.equal(decidir({ item: item({ price: 2000 }), comp: marcada(1641) }).accion, 'bajar');
});
test('no toca las que ganan o comparten', () => {
  assert.equal(decidir({ item: item(), comp: { marcada: false, estado: 'winning' } }).accion, 'sin_marcar');
});
test('saltea promoción activa o desconocida', () => {
  assert.equal(decidir({ item: item(), comp: marcada(900), promo: true }).accion, 'saltear_promo');
  assert.equal(decidir({ item: item(), comp: marcada(900), promo: null }).accion, 'saltear_promo_desconocida');
});
test('respeta el piso', () => {
  assert.equal(decidir({ item: item(), comp: marcada(900), piso: 950 }).accion, 'saltear_piso');
});
test('redondea hacia abajo un ganador con decimales', () => {
  assert.equal(decidir({ item: item(), comp: marcada(899.5) }).precio, 899);
});
test('saltea otra moneda y variaciones', () => {
  assert.equal(decidir({ item: item({ currency_id: 'USD' }), comp: marcada(900) }).accion, 'saltear_moneda');
  assert.equal(decidir({ item: item({ variaciones: true }), comp: marcada(900) }).accion, 'saltear_variaciones');
});
test('stock fijo en a demanda sólo si la cuenta lo permite', () => {
  const d = decidir({ item: item({ demanda: true, available_quantity: 50 }), comp: marcada(900), tocarStock: true });
  assert.equal(d.stock, 5);
  assert.equal(decidir({ item: item({ demanda: true, available_quantity: 50 }), comp: marcada(900), tocarStock: false }).stock, undefined);
  assert.equal(decidir({ item: item({ demanda: false, available_quantity: 1 }), comp: marcada(900), tocarStock: true }).stock, undefined);
});

const previo = { precio_original: 1000, precio_aplicado: 800, stock_original: 50 };
test('reversión: sigue al ganador hacia arriba sin pasar el original', () => {
  assert.deepEqual([decidir({ item: item({ price: 800 }), comp: marcada(900), previo }).accion, decidir({ item: item({ price: 800 }), comp: marcada(900), previo }).precio], ['ajustar', 900]);
  assert.equal(decidir({ item: item({ price: 800 }), comp: marcada(800), previo }).accion, 'mantener');
});
test('reversión: el ganador bajó más de 360 desde el original, se mantiene', () => {
  assert.equal(decidir({ item: item({ price: 800 }), comp: marcada(600), previo }).accion, 'mantener_umbral');
});
test('reversión: ya no marcada, sube hasta un peso abajo del competidor', () => {
  const d = decidir({ item: item({ price: 800 }), comp: { marcada: false, techo: 949 }, previo });
  assert.deepEqual([d.accion, d.precio], ['subir', 949]);
});
test('reversión: sin competidor vuelve al original y restaura stock', () => {
  const d = decidir({ item: item({ price: 800, demanda: true, available_quantity: 5 }), comp: { marcada: false, techo: null }, previo, tocarStock: true });
  assert.deepEqual([d.accion, d.precio, d.stock], ['restaurar', 1000, 50]);
});
test('reversión: nunca pasa el original', () => {
  const d = decidir({ item: item({ price: 800 }), comp: { marcada: false, techo: 5000 }, previo });
  assert.equal(d.precio, 1000);
});
test('editada a mano: se libera sin tocar', () => {
  assert.equal(decidir({ item: item({ price: 1200 }), comp: marcada(900), previo }).accion, 'liberar_editada');
});
test('error de consulta no cambia nada', () => {
  assert.equal(decidir({ item: item(), comp: { error: 'http_500' } }).accion, 'error_consulta');
});

test('tope del 30 %: no baja más que eso aunque la diferencia sea menor a 360', () => {
  assert.equal(decidir({ item: item({ price: 702 }), comp: marcada(391) }).accion, 'sin_tocar_pct');
  assert.equal(decidir({ item: item({ price: 1000 }), comp: marcada(700) }).accion, 'bajar');
  assert.equal(decidir({ item: item({ price: 1000 }), comp: marcada(699) }).accion, 'sin_tocar_pct');
});
test('tope del 30 % también en la reversión, contra el original', () => {
  assert.equal(decidir({ item: item({ price: 800 }), comp: marcada(690), previo: { precio_original: 1000, precio_aplicado: 800 } }).accion, 'mantener_umbral');
});
test('ganador nulo no se toma como cero', () => {
  assert.equal(decidir({ item: item(), comp: { marcada: true, ganador: null } }).accion, 'saltear_sin_precio');
});

test('promoción visible: no libera una que bajamos, no baja una nueva', () => {
  assert.equal(decidir({ item: item({ price: 720, original_price: 800 }), comp: marcada(700), previo: { precio_original: 1000, precio_aplicado: 800 } }).accion, 'mantener_promo');
  assert.equal(decidir({ item: item({ original_price: 1200 }), comp: marcada(900) }).accion, 'saltear_promo');
});

test('regla simple de Vintage: umbral 400, sin tope de porcentaje, mínimo 1500 como piso', () => {
  assert.equal(decidir({ item: item({ price: 2000 }), comp: marcada(1601), umbral: 400, topePct: null, piso: 1500 }).accion, 'bajar');
  assert.equal(decidir({ item: item({ price: 2000 }), comp: marcada(1600), umbral: 400, topePct: null, piso: 1500 }).accion, 'sin_tocar_umbral');
  assert.equal(decidir({ item: item({ price: 1800 }), comp: marcada(1450), umbral: 400, topePct: null, piso: 1500 }).accion, 'saltear_piso');
  assert.equal(decidir({ item: item({ price: 702 }), comp: marcada(391), umbral: 400, topePct: null }).accion, 'bajar');
});
