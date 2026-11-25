import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidir } from '../src/decision.mjs';
import { normalizar } from '../src/publicaciones.mjs';

const item = (o = {}) => ({ id: 'MLU1', price: 898, currency_id: 'UYU', variaciones: false, demanda: false, available_quantity: 1, precio_dinamico: false, ...o });
const marcada = ganador => ({ marcada: true, compite: true, ganador, estado: 'competing' });

test('el tag dynamic_standard_price marca la publicación y no se intenta bajarla', () => {
  const n = normalizar({ id: 'MLU660973661', price: 898, currency_id: 'UYU', tags: ['user_product_listing', 'dynamic_standard_price'] });
  assert.equal(n.precio_dinamico, true);
  assert.equal(decidir({ item: item({ precio_dinamico: true }), comp: marcada(875) }).accion, 'saltear_precio_dinamico');
  assert.equal(normalizar({ id: 'MLU2', price: 1, currency_id: 'UYU', tags: ['catalog_boost'] }).precio_dinamico, false);
});
test('una publicación con precio administrado que no cambiaría nada sigue como sin_marcar', () => {
  assert.equal(decidir({ item: item({ precio_dinamico: true }), comp: { marcada: false, estado: 'winning' } }).accion, 'sin_marcar');
});
test('las normales se bajan como siempre', () => {
  assert.equal(decidir({ item: item(), comp: marcada(875) }).accion, 'bajar');
});
