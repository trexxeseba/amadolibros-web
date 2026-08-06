import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cart = readFileSync(
  new URL('../../astro-front/src/pages/carrito.astro', import.meta.url),
  'utf8',
);

test('TRANSFERENCIA-H1 mantiene transferencia y tarjeta como opciones explícitas', () => {
  assert.match(cart, /name="payment-method" value="transfer" checked/);
  assert.match(cart, /name="payment-method" value="card"/);
  assert.match(cart, /MEJOR PRECIO/);
  assert.match(cart, /Mercado Pago/);
  assert.match(cart, /12% menos en los libros/);
  assert.match(cart, /Hasta 12 cuotas/);
});

test('TRANSFERENCIA-H1 incluye las cuatro cuentas entregadas por Amado Libros', () => {
  assert.match(cart, /data-bank-detail="brou"/);
  assert.match(cart, /00065582200001/);
  assert.match(cart, /1960816881/);
  assert.match(cart, /data-bank-detail="itau"/);
  assert.match(cart, /8969114/);
  assert.match(cart, /data-bank-detail="oca-blue"/);
  assert.match(cart, /2373466/);
  assert.match(cart, /data-bank-detail="prex"/);
  assert.match(cart, /57211/);
  assert.match(cart, /28688206/);
});

test('el prototipo no envía transferencias al endpoint de órdenes', () => {
  const handlerStart = cart.indexOf("var btnTransferPreview = document.getElementById('btn-transfer-preview')");
  const handlerEnd = cart.indexOf('syncTransferBank();', handlerStart);
  assert.ok(handlerStart > -1 && handlerEnd > handlerStart);
  const handler = cart.slice(handlerStart, handlerEnd);
  assert.doesNotMatch(handler, /fetch\s*\(/);
  assert.doesNotMatch(handler, /\/api\/orders/);
  assert.match(handler, /pedido no creado/);
});

test('la interfaz declara sin ambigüedad que no reserva ni confirma pagos', () => {
  assert.match(cart, /este Preview no registra ni reserva pedidos por transferencia y no confirma pagos/);
  assert.match(cart, /no crea ni reserva el pedido/);
});

test('el descuento se aplica a productos y no reduce el envío', () => {
  assert.match(cart, /var transferProducts = Math\.round\(subtotal \* 0\.88\)/);
  assert.match(cart, /transferProducts \+ shippingCost/);
  assert.match(cart, /transferProducts - RETIRO_DISCOUNT/);
});

