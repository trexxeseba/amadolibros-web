import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidirRegla, ofertasAjenas, conteos } from '../src/regla-inmediata.mjs';

const o = (price, entrega, item_id = 'MLU' + price) => ({ item_id, price, entrega });

test('con un inmediato más barato: baja a 1 % por debajo', () => {
  const r = decidirRegla({ precio: 1000, base: 1000, ofertas: [o(800, 'demanda'), o(900, 'inmediato')] });
  assert.equal(r.accion, 'bajar'); assert.equal(r.objetivo, 891); assert.equal(r.inmediato, 900);
});

test('con un inmediato más caro: sube hasta 1 % por debajo, con tope del 75 % sobre la base', () => {
  assert.deepEqual([decidirRegla({ precio: 1000, base: 1000, ofertas: [o(1500, 'inmediato')] })].map(r => [r.accion, r.objetivo]), [['subir_bajo_inmediato', 1485]]);
  assert.equal(decidirRegla({ precio: 1000, base: 1000, ofertas: [o(5000, 'inmediato')] }).objetivo, 1750);
});

test('sin inmediato: sube 75 % sobre la base, una sola vez', () => {
  const r = decidirRegla({ precio: 1000, base: 1000, ofertas: [] });
  assert.equal(r.accion, 'subir_75'); assert.equal(r.objetivo, 1750); assert.equal(r.queda_detras_de_demanda, false);
  // Ya subida: la base sigue siendo el original, no se acumula.
  assert.equal(decidirRegla({ precio: 1750, base: 1000, ofertas: [] }).accion, 'igual');
  // El sistema la había bajado: el 75 % se calcula sobre el original.
  assert.equal(decidirRegla({ precio: 900, base: 1000, ofertas: [] }).objetivo, 1750);
});

test('sin inmediato pero con vendedor a demanda más barato que el precio subido: avisa', () => {
  const r = decidirRegla({ precio: 1000, base: 1000, ofertas: [o(1200, 'demanda')] });
  assert.equal(r.accion, 'subir_75'); assert.equal(r.queda_detras_de_demanda, true); assert.equal(r.demanda_mas_barata, 1200);
  assert.equal(decidirRegla({ precio: 1000, base: 1000, ofertas: [o(2000, 'demanda')] }).queda_detras_de_demanda, false);
});

test('un plazo que no se pudo leer no se estima: no se toca', () => {
  assert.equal(decidirRegla({ precio: 1000, base: 1000, ofertas: [o(900, 'sin_dato')] }).accion, 'sin_dato');
  assert.equal(decidirRegla({ precio: 1000, base: 1000, ofertas: [o(800, 'sin_dato'), o(900, 'inmediato')] }).accion, 'sin_dato');
  assert.equal(decidirRegla({ precio: 1000, base: 1000, ofertas: [o(800, 'demanda'), { item_id: 'MLU9', price: 950 }] }).accion, 'sin_dato');
  // Un sin dato más caro que el primer inmediato no importa.
  assert.equal(decidirRegla({ precio: 1000, base: 1000, ofertas: [o(900, 'inmediato'), o(950, 'sin_dato')] }).accion, 'bajar');
});

test('ofertas ajenas: fuera las propias, las de la casa, las usadas y las sin precio; ordenadas', () => {
  const item = { id: 'MLU1' };
  const r = ofertasAjenas(item, [
    { item_id: 'MLU1', seller_id: 1, price: 10 }, { item_id: 'MLU2', seller_id: 1, price: 20 }, { item_id: 'MLU3', seller_id: 7, price: 30 },
    { item_id: 'MLU4', seller_id: 2, price: 50 }, { item_id: 'MLU5', seller_id: 3, price: 40 }, { item_id: 'MLU6', seller_id: 4, price: 5, condition: 'used' }, { item_id: 'MLU7', seller_id: 5, price: 0 },
  ], { sellerId: 1, casa: new Set(['7']) });
  assert.deepEqual(r.map(x => x.item_id), ['MLU5', 'MLU4']);
});

test('conteos por acción y avisos de quedar detrás de un vendedor a demanda', () => {
  assert.deepEqual(conteos([{ accion: 'bajar' }, { accion: 'subir_75', queda_detras_de_demanda: true }, { accion: 'subir_75' }]), { medidas: 3, bajar: 1, subir_75: 2, subir_75_detras_de_demanda: 1 });
});
