import test from 'node:test';
import assert from 'node:assert/strict';
import { pctVisible, tramo } from '../src/parte-operador.mjs';

test('descuento visible: regular contra final, sin descuento da cero', () => {
  assert.equal(pctVisible(1000, 740), 26);
  assert.equal(pctVisible(1000, 1000), 0);
  assert.equal(pctVisible(0, 500), 0);
  assert.equal(pctVisible(1000, 1200), 0);
});

test('tramos de descuento', () => {
  assert.equal(tramo(0), '0');
  assert.equal(tramo(16), '1-16');
  assert.equal(tramo(19.9), '16-20');
  assert.equal(tramo(26), '20-26');
  assert.equal(tramo(31), '30+');
});
