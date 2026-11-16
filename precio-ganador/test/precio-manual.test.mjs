import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planManual, parsearCambios } from '../src/precio-manual.mjs';

const item = (price, o = {}) => ({ id: 'MLU1', price, currency_id: 'UYU', status: 'active', variaciones: false, precio_dinamico: false, original_price: null, ...o });

test('parsea la lista de cambios y rechaza lo mal escrito', () => {
  const c = parsearCambios('MLU643926671=1500, mlu683139340 = 1100');
  assert.deepEqual([...c], [['MLU643926671', 1500], ['MLU683139340', 1100]]);
  assert.throws(() => parsearCambios('MLU1=abc'), /cambio_invalido/);
  assert.throws(() => parsearCambios('MLU643926671=1500,MLU643926671=1600'), /id_repetido/);
  assert.throws(() => parsearCambios(''), /sin_cambios/);
});
test('cambia cuando la publicación está limpia: Mafalda 720 → 1500, Riso 1350 → 1100', () => {
  assert.deepEqual(planManual({ item: item(720), precio: 1500, promo: false, minimo: 500 }), { accion: 'cambiar', objetivo: 1500, motivo: '720 → 1500' });
  assert.equal(planManual({ item: item(1350), precio: 1100, promo: false, minimo: 500 }).objetivo, 1100);
});
test('no toca publicaciones pausadas, con promoción, con descuento, administradas o con variaciones', () => {
  assert.match(planManual({ item: item(720, { status: 'paused' }), precio: 1500, promo: false }).motivo, /no está activa/);
  assert.match(planManual({ item: item(720), precio: 1500, promo: true }).motivo, /promoción activa/);
  assert.match(planManual({ item: item(720), precio: 1500, promo: null }).motivo, /no se pudo confirmar/);
  assert.match(planManual({ item: item(720, { original_price: 900 }), precio: 1500, promo: false }).motivo, /descuento a la vista/);
  assert.match(planManual({ item: item(720, { precio_dinamico: true }), precio: 1500, promo: false }).motivo, /administrado/);
  assert.match(planManual({ item: item(720, { variaciones: true }), precio: 1500, promo: false }).motivo, /variaciones/);
  assert.match(planManual({ item: null, precio: 1500, promo: false }).motivo, /no se pudo leer/);
});
test('respeta el piso de la cuenta y no repite un precio que ya está', () => {
  assert.match(planManual({ item: item(720), precio: 450, promo: false, minimo: 500 }).motivo, /piso/);
  assert.match(planManual({ item: item(1500), precio: 1500, promo: false, minimo: 500 }).motivo, /ya tiene ese precio/);
});
