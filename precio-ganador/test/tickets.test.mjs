import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compras, analizar } from '../src/tickets.mjs';

test('compras junta las órdenes del mismo carrito y analizar simula el cupón', () => {
  const l = compras([
    { order_id: '1', pack_id: 'P', total_amount: 3000, unidades: 1, lineas: 1 },
    { order_id: '2', pack_id: 'P', total_amount: 2500, unidades: 1, lineas: 1 },
    { order_id: '3', pack_id: null, total_amount: 4000, unidades: 2, lineas: 2 },
    { order_id: '4', pack_id: null, total_amount: 800, unidades: 1, lineas: 1 },
  ]);
  assert.equal(l.length, 3);
  const a = analizar(l, { cupones: [{ umbral: 5000, descuento: 700 }] });
  assert.equal(a.compras, 3);
  assert.equal(a.con_2_o_mas_libros, 2);
  assert.deepEqual(a.cupones[0], { umbral: 5000, descuento: 700, pct: 14, ya_pasan: 1, cerca_60pct: 1, costo_regalado: 700 });
  assert.equal(a.tramos['5000-6000'].compras, 1);
});
