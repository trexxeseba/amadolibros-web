import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const carrito = readFileSync(path.join(ROOT, 'astro-front/src/pages/carrito.astro'), 'utf8');
const cartJs = readFileSync(path.join(ROOT, 'astro-front/public/cart.js'), 'utf8');
const ordersHandler = readFileSync(path.join(ROOT, 'functions/api/_orders_handler.js'), 'utf8');
const ordersRoute = readFileSync(path.join(ROOT, 'functions/api/orders.js'), 'utf8');

test('el carrito revalida al abrir y antes de transferencia, Mercado Pago y WhatsApp', () => {
  assert.match(carrito, /refreshCartAvailability\(\{ initial: true \}\)/);
  assert.ok((carrito.match(/refreshCartAvailability\(\{ beforePayment: true \}\)/g) || []).length >= 3);
  assert.match(carrito, /fetch\('\/api\/cart\/validate'/);
});

test('agotados quedan visibles, no suman y ofrecen encargo por WhatsApp', () => {
  assert.match(carrito, /Vendimos todos los ejemplares de/);
  assert.match(carrito, /Buscarlo por encargo/);
  assert.match(carrito, /cart-item-unavailable/);
  assert.match(carrito, /getSellableSubtotal/);
  assert.match(carrito, /paymentItemsPayload\(cart\)/);
});

test('precio y stock del navegador se reemplazan sólo con respuesta validada', () => {
  assert.match(cartJs, /syncValidated: function/);
  assert.match(cartJs, /current\.price_uyu/);
  assert.match(cartJs, /current\.available_quantity/);
  const syncStart = cartJs.indexOf('syncValidated: function');
  const syncBlock = cartJs.slice(syncStart, syncStart + 2200);
  assert.doesNotMatch(syncBlock, /item\.title\s*=/);
  assert.match(syncBlock, /status === 'sin_stock'/);
});

test('la validación final ya no responde el error genérico y usa el índice vigente', () => {
  assert.doesNotMatch(ordersHandler, /Productos con problemas\./);
  assert.match(ordersHandler, /code: 'CART_CHANGED'/);
  assert.match(ordersRoute, /fetchCheckoutCatalog/);
  assert.doesNotMatch(ordersRoute, /fetchCatalog\s*}/);
});

test('una caída técnica nunca se comunica como agotado', () => {
  assert.match(carrito, /No pudimos verificar la disponibilidad/);
  assert.match(carrito, /cartValidationFailed = true/);
  assert.match(carrito, /syncPaymentAvailability/);
});
