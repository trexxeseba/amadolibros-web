import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cuponMaximo, precioConTopes, cuponesDeDetalle, TOPES } from '../src/promo-masiva.mjs';

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
test('libro: promo hasta 26 %', () => {
  const r = precioConTopes({ regular: 1500, techo: 1425, cupones });
  assert.equal(r.precio, 1110); assert.equal(r.pct, 26);
});
test('lo que no es libro: hasta 20 %', () => {
  const r = precioConTopes({ regular: 1500, techo: 1425, cupones, topes: { ...TOPES, visibleMaxPct: TOPES.visibleNoLibroMaxPct } });
  assert.equal(r.pct, 20);
});
test('con el cupón más fuerte el total nunca baja del 60 % del regular', () => {
  for (const R of [2500, 3000, 4000, 4800, 5000, 9000]) {
    const r = precioConTopes({ regular: R, techo: R * 0.95, cupones });
    assert.ok(!r.error, String(R));
    assert.ok(r.pct <= 26, `${R}: ${r.pct}`);
    assert.ok(r.precio - cuponMaximo(r.precio, cupones) >= R * 0.6 - 1e-9, `${R}: ${r.precio}`);
  }
});
test('nunca sube el precio y respeta el rango de la promo', () => {
  assert.equal(precioConTopes({ regular: 5000, techo: 3600, cupones }).error, 'sin_rango');
  assert.equal(precioConTopes({ regular: 1000, techo: 950, min: 900, cupones: [] }).precio, 900);
  assert.equal(precioConTopes({ regular: 1000, techo: 950, max: 700, cupones: [] }).error, 'sin_rango');
});
