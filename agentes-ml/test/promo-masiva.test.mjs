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
test('la corrida diaria toma las promos vigentes o que empiezan en 3 días, nunca cupones ni liquidación', async () => {
  const { promosDelDia } = await import('../src/promo-masiva.mjs');
  const ahora = new Date('2026-11-26T15:00:00Z');
  const p = (name, type, status, start, finish) => ({ name, type, status, start_date: start, finish_date: finish });
  const r = promosDelDia([
    p('black friday', 'DEAL', 'pending', '2026-11-27T03:00:00Z', '2026-12-01T02:00:00Z'),
    p('Amado 15', 'SELLER_CAMPAIGN', 'started', '2026-11-01T00:00:00', '2026-12-01T00:00:00'),
    p('NAVIDAD Y REYES', 'DEAL', 'pending', '2026-12-01T03:00:00Z', '2027-01-07T00:00:00Z'),
    p('Seguidores 400', 'SELLER_COUPON_CAMPAIGN', 'started', '2026-10-30T00:00:00', '2026-11-29T00:00:00'),
    p('Amado Liquidación 40', 'SELLER_CAMPAIGN', 'started', '2026-11-01T00:00:00', '2026-12-01T00:00:00'),
    p('Potenciá tus ventas', 'SMART', 'started', '2026-08-04T00:00:00', '2027-02-04T00:00:00'),
    p('vieja', 'DEAL', 'started', '2026-11-01T00:00:00Z', '2026-11-20T00:00:00Z'),
  ], ahora);
  assert.deepEqual(r.map(x => x.name), ['black friday', 'Amado 15']);
});
test('reintenta lo que Mercado Libre suelta solo y no lo que es definitivo', async () => {
  const { reintentable } = await import('../src/promo-masiva.mjs');
  assert.equal(reintentable({ status: 400, detalle: { message: 'Errors: OFFER_SIBLING_CREATION_IN_PROCESS - Creation of sibling offer in process' } }), true);
  assert.equal(reintentable({ status: 423, detalle: {} }), true);
  assert.equal(reintentable({ status: 500 }), true);
  assert.equal(reintentable({ status: 400, detalle: { message: 'ERROR_CREDIBILITY_DISCOUNTED_PRICE' } }), false);
});
