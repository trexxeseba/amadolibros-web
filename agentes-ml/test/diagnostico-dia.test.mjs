import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ventasPorDia, promedio } from '../src/diagnostico-dia.mjs';

test('cuenta órdenes y unidades por día de Montevideo y deja afuera las canceladas', () => {
  const d = ventasPorDia([
    { status: 'paid', date_created: '2026-11-26T02:00:00Z', total_amount: 100, order_items: [{ quantity: 2 }] },
    { status: 'paid', date_created: '2026-11-26T15:00:00Z', total_amount: 50, order_items: [{ quantity: 1 }] },
    { status: 'cancelled', date_created: '2026-11-26T15:00:00Z', order_items: [{ quantity: 5 }] },
  ]);
  assert.deepEqual(d['2026-11-25'], { ordenes: 1, unidades: 2, monto: 100 });
  assert.deepEqual(d['2026-11-26'], { ordenes: 1, unidades: 1, monto: 50 });
});
test('el promedio no cuenta el día de hoy y llena con cero los días sin venta', () => {
  const dias = { '2026-11-25': { ordenes: 4 }, '2026-11-24': { ordenes: 2 }, '2026-11-26': { ordenes: 100 } };
  assert.equal(promedio(dias, '2026-11-26', 2, 'ordenes'), 3);
  assert.equal(promedio(dias, '2026-11-26', 4, 'ordenes'), 1.5);
});
