import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esCandidata, ordenarPorVisitas } from '../src/top-visitas.mjs';

test('candidata: activa, en pesos, sin variaciones, con stock y no de catálogo', () => {
  const it = { status: 'active', currency_id: 'UYU', variaciones: false, catalog_listing: false, available_quantity: 1 };
  assert.equal(esCandidata(it), true);
  assert.equal(esCandidata({ ...it, catalog_listing: true }), false);
  assert.equal(esCandidata({ ...it, available_quantity: 0 }), false);
  assert.equal(esCandidata({ ...it, status: 'paused' }), false);
  assert.equal(esCandidata({ ...it, variaciones: true }), false);
});

test('orden por visitas; las no leídas al final; desempata por stock; corta en el tope', () => {
  const r = ordenarPorVisitas([{ id: 'a', visitas: 5, stock: 1 }, { id: 'b', visitas: null, stock: 9 }, { id: 'c', visitas: 20, stock: 1 }, { id: 'd', visitas: 5, stock: 3 }], 3);
  assert.deepEqual(r.map(x => x.id), ['c', 'd', 'a']);
});
