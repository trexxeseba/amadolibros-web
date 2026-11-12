import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSubida } from '../src/subir.mjs';

const item = (price, o = {}) => ({ id: 'MLU1', price, currency_id: 'UYU', status: 'active', variaciones: false, precio_dinamico: false, original_price: null, ...o });
const ok = (precio, min, o = {}) => planSubida({ aprobado: precio, item: item(precio), minExterno: min, ptwStatus: 'winning', promo: false, ...o });

test('sube al 97 % del competidor: El Hombre y sus Símbolos 3950 contra 5093 → 4940', () => {
  const p = ok(3950, 5093);
  assert.deepEqual([p.accion, p.objetivo], ['subir', 4940]);
});
test('no sube más de 30 % de una vez ni más de 3 veces el precio', () => {
  assert.match(ok(3300, 6160).motivo, /más de un paso/);
  assert.match(ok(2750, 40900).motivo, /sospechoso/);
});
test('controles de último momento: precio cambiado, promo, ya no gana, competidor cercano', () => {
  assert.match(planSubida({ aprobado: 3950, item: item(3800), minExterno: 5093, ptwStatus: 'winning', promo: false }).motivo, /el precio cambió/);
  assert.match(ok(3950, 5093, { promo: true }).motivo, /promoción activa/);
  assert.match(ok(3950, 5093, { promo: null }).motivo, /no se pudo confirmar/);
  assert.match(ok(3950, 5093, { ptwStatus: 'competing' }).motivo, /ya no gana/);
  assert.match(ok(3950, 4500).motivo, /ya no está tan arriba/);
});
test('descuento a la vista, precio administrado y variaciones no se tocan', () => {
  assert.equal(planSubida({ aprobado: 3950, item: item(3950, { original_price: 4500 }), minExterno: 5093, ptwStatus: 'winning', promo: false }).accion, 'omitir');
  assert.equal(planSubida({ aprobado: 3950, item: item(3950, { precio_dinamico: true }), minExterno: 5093, ptwStatus: 'winning', promo: false }).accion, 'omitir');
  assert.equal(planSubida({ aprobado: 3950, item: null, minExterno: 5093, ptwStatus: 'winning', promo: false }).accion, 'omitir');
});
