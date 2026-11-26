import test from 'node:test';
import assert from 'node:assert/strict';
import { listaItems, sePuedeReactivar } from '../src/reactivar.mjs';

test('lista de items: limpia, sin repetidos', () => {
  assert.deepEqual(listaItems('mlu123456, MLU123456;MLU999999 x'), ['MLU123456', 'MLU999999']);
});

test('sólo reactiva pausadas de esta cuenta con stock', () => {
  assert.equal(sePuedeReactivar({ seller_id: 1, status: 'paused', available_quantity: 2 }, 1), null);
  assert.equal(sePuedeReactivar({ seller_id: 2, status: 'paused', available_quantity: 2 }, 1), 'otra_cuenta');
  assert.equal(sePuedeReactivar({ seller_id: 1, status: 'active', available_quantity: 2 }, 1), 'ya_activa');
  assert.equal(sePuedeReactivar({ seller_id: 1, status: 'closed', available_quantity: 2 }, 1), 'estado_closed');
  assert.equal(sePuedeReactivar({ seller_id: 1, status: 'paused', available_quantity: 0 }, 1), 'sin_stock');
});
