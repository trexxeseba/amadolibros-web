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

test('pickup-cx-2: los beneficios se anuncian dentro de su opción', () => {
  assert.match(carrito, /value="pickup"[\s\S]*?Ahorrás \$150 retirando aquí/);
  assert.match(carrito, /value="shipping"[\s\S]*?Envío gratis en compras desde \$2\.000/);
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
});

test('pickup-cx-2: elegir entrega recalcula y habilita el pago', () => {
  assert.match(carrito, /getSellableItems\(cart\)\.length > 0 && !!getDeliveryType\(\)/);
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
