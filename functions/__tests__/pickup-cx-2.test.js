import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const carrito = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'pages', 'carrito.astro'),
  'utf8',
);

test('pickup-cx-2: ninguna forma de entrega viene preseleccionada', () => {
  const deliveryInputs = carrito.match(/<input type="radio" name="delivery"[^>]*>/g) || [];
  assert.equal(deliveryInputs.length, 2);
  for (const input of deliveryInputs) assert.doesNotMatch(input, /\schecked(?:\s|>)/);
  assert.match(carrito, /return checked \? checked\.value : '';/);
});

test('pickup-cx-2: el beneficio de retiro se aplica desde $1.300 de compra total', () => {
  assert.match(carrito, /value="pickup"[\s\S]*?Ahorrás \$150 en compras desde \$1\.300/);
  assert.match(carrito, /PICKUP_DISCOUNT_MIN_PRODUCTS_TOTAL_UYU = 1300/);
  assert.match(carrito, /Number\(subtotal\) >= PICKUP_DISCOUNT_MIN_PRODUCTS_TOTAL_UYU/);
  assert.match(carrito, /value="shipping"[\s\S]*?Envío gratis en compras desde \$1\.500/);
});

test('pickup-cx-2: sin selección o sin productos comprables no muestra descuentos', () => {
  const start = carrito.indexOf('function updateTotals');
  const end = carrito.indexOf('// ── Construir fila de item', start);
  const fn = carrito.slice(start, end);
  assert.match(fn, /if \(!deliveryType \|\| subtotal <= 0\)/);
  assert.match(fn, /discountLineEl\.hidden\s*=\s*true/);
  assert.match(fn, /totalLineEl\.hidden\s*=\s*true/);
  assert.match(fn, /shippingCostLineEl\.hidden\s*=\s*true/);
  assert.match(fn, /totalShippingLineEl\.hidden\s*=\s*true/);
  assert.match(fn, /pickupDiscount = pickupEligible \? RETIRO_DISCOUNT : 0/);
  assert.match(fn, /discountLineEl\.hidden\s*=\s*pickupDiscount === 0/);
});

test('pickup-cx-2: elegir entrega recalcula totales y el aviso de guía (V1.1: la entrega ya no bloquea el CTA, sólo oculta el aviso)', () => {
  assert.match(carrito, /var hasDelivery = !!getDeliveryType\(\);/);
  const start = carrito.indexOf("radio.addEventListener('change', function () {");
  const listener = carrito.slice(start, start + 300);
  assert.match(listener, /updateTotals\(\)/);
  assert.match(listener, /syncPaymentAvailability\(\)/);
});

test('pickup-cx-2: invalida el borrador viejo que guardaba retiro por defecto', () => {
  assert.match(carrito, /amado-checkout-draft-v2/);
  assert.doesNotMatch(carrito, /amado-checkout-draft-v1/);
});

test('pickup-cx-2: los tres caminos exigen una elección explícita', () => {
  assert.match(carrito, /function requireDeliveryType/);
  assert.match(carrito, /Elegí envío o retiro para continuar/);
  const calls = carrito.match(/requireDeliveryType\(\)/g) || [];
  assert.ok(calls.length >= 4, 'definición + WhatsApp + transferencia + Mercado Pago');
});
