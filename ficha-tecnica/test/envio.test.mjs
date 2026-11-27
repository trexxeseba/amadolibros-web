import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cuenta, tramo, mediana } from '../src/envio.mjs';

test('cuenta: lo que queda después de comisión y envío gratis', () => {
  assert.deepEqual(cuenta({ precio: 1000, comision: 140, envio: 300 }), { queda_sin_envio: 860, queda_con_envio: 560, envio_pct: 30 });
  assert.deepEqual(cuenta({ precio: 1000, comision: null, envio: 300 }), { queda_sin_envio: null, queda_con_envio: null, envio_pct: null });
});

test('tramo y mediana', () => {
  assert.equal(tramo(10), 'hasta_15'); assert.equal(tramo(30), '16_a_30'); assert.equal(tramo(45), '31_a_50'); assert.equal(tramo(80), 'mas_de_50'); assert.equal(tramo(null), 'sin_dato');
  assert.equal(mediana([3, 1, 2]), 2); assert.equal(mediana([]), null);
});
