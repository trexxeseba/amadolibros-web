import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cuponMaximo, precioConTopes, cuponesDeDetalle } from '../src/promo-masiva.mjs';

// Los cupones vigentes del 26/11/2026.
const cupones = cuponesDeDetalle([
  { status: 'started', fixed_amount: 400, min_purchase_amount: 2700 },
  { status: 'started', fixed_amount: 300, min_purchase_amount: 2000 },
  { status: 'started', fixed_percentage: 20, min_purchase_amount: 3500, max_purchase_amount: 700 },
  { status: 'started', fixed_amount: 500, min_purchase_amount: 3500 },
  { status: 'finished', fixed_amount: 900, min_purchase_amount: 100 },
]);

test('el cupón sólo cuenta si la compra llega al mínimo y el de porcentaje respeta su tope', () => {
  assert.equal(cupones.length, 4);
  assert.equal(cuponMaximo(1900, cupones), 0);
  assert.equal(cuponMaximo(2500, cupones), 300);
  assert.equal(cuponMaximo(3000, cupones), 400);
  assert.equal(cuponMaximo(5000, cupones), 700);
});
test('un libro barato llega al 16 % porque no le entra ningún cupón', () => {
  const r = precioConTopes({ regular: 1500, techo: 1425, cupones });
  assert.equal(r.precio, 1260); assert.equal(r.pct, 16);
});
test('con cupón posible el total no pasa el 25 %', () => {
  for (const R of [2500, 3000, 4000, 4500, 5000, 9000]) {
    const r = precioConTopes({ regular: R, techo: R * 0.95, cupones });
    assert.ok(!r.error, String(R));
    assert.ok(r.pct <= 16 && r.total_pct <= 25, `${R}: ${r.pct} ${r.total_pct}`);
    assert.ok((R - r.precio + cuponMaximo(r.precio, cupones)) / R <= 0.25 + 1e-9);
  }
});
test('nunca sube el precio: si el tope no permite bajar más que hoy, no toca', () => {
  const r = precioConTopes({ regular: 5000, techo: 4300, cupones });
  assert.equal(precioConTopes({ regular: 5000, techo: 4000, cupones }).error, 'sin_rango');
  assert.equal(r.error, 'pasa_el_tope_con_cupon');
});
test('respeta el rango de la promo y el piso del 60 %', () => {
  const r = precioConTopes({ regular: 1000, techo: 950, min: 900, cupones: [] });
  assert.equal(r.precio, 900);
  assert.equal(precioConTopes({ regular: 1000, techo: 950, max: 800, cupones: [] }).error, 'sin_rango');
});
