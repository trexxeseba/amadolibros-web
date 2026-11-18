import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.PRECIO_GANADOR_SOLO_IMPORTAR = '1';
process.argv.push('--cuenta', 'vintage');
const { precioNormal } = await import('../src/auditoria.mjs');

test('con promo activa se compara el precio normal, no el de la promo', () => {
  assert.equal(precioNormal({ price: 570, original_price: 1154 }), 1154);
});
test('sin promo se usa el precio de la publicación', () => {
  assert.equal(precioNormal({ price: 900, original_price: null }), 900);
  assert.equal(precioNormal({ price: 900 }), 900);
  assert.equal(precioNormal({ price: 900, original_price: 900 }), 900);
});
test('sin la publicación devuelve null', () => {
  assert.equal(precioNormal(undefined), null);
});
