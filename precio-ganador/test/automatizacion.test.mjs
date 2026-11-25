import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limites, elegirRegla, esAutomatizable } from '../src/automatizacion.mjs';

test('límites: mínimo 60 % y máximo 145 % del precio de lista, en pesos enteros', () => {
  assert.deepEqual(limites(2000), { min_price: 1200, max_price: 2900 });
  assert.deepEqual(limites(1046), { min_price: 628, max_price: 1516 });
  assert.equal(limites(0), null); assert.equal(limites('x'), null);
});

test('regla: prefiere INT_EXT, después INT; si no hay ninguna conocida, nada', () => {
  assert.equal(elegirRegla([{ rule_id: 'INT' }, { rule_id: 'INT_EXT' }]), 'INT_EXT');
  assert.equal(elegirRegla([{ rule_id: 'INT' }]), 'INT');
  assert.equal(elegirRegla(['INT']), 'INT');
  assert.equal(elegirRegla([]), null); assert.equal(elegirRegla([{ rule_id: 'OTRA' }]), null);
});

test('automatizable: activa, en pesos, con stock, con regla y sin automatización puesta', () => {
  const f = { estado: 'active', moneda: 'UYU', variaciones: false, stock: 2, regla_elegida: 'INT', automatizada: false };
  assert.equal(esAutomatizable(f), true);
  assert.equal(esAutomatizable({ ...f, automatizada: true }), false);
  assert.equal(esAutomatizable({ ...f, regla_elegida: null }), false);
  assert.equal(esAutomatizable({ ...f, stock: 0 }), false);
  assert.equal(esAutomatizable({ ...f, estado: 'paused' }), false);
});
