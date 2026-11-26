import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pedido = readFileSync(new URL('../../astro-front/src/pages/pedido.astro', import.meta.url), 'utf8');
const carrito = readFileSync(new URL('../../astro-front/src/pages/carrito.astro', import.meta.url), 'utf8');

test('carrito: la clave de la compra también se guarda en localStorage', () => {
  assert.match(carrito, /localStorage\.setItem\('amado-mp-auth', mpAuth\)/);
  assert.match(carrito, /sessionStorage\.setItem\('amado-mp-auth', mpAuth\)/);
});

test('pedido: si no hay clave en la sesión, usa la de localStorage', () => {
  assert.match(pedido, /localStorage\.getItem\('amado-mp-auth'\)/);
});

test('pedido: sin clave no queda "verificando" para siempre', () => {
  assert.match(pedido, /Volviste desde Mercado Pago/);
  assert.match(pedido, /te llega la confirmación por correo y te escribimos por WhatsApp/);
});

test('pedido: el mensaje de WhatsApp no lleva emoji ni parámetros de Mercado Pago', () => {
  assert.doesNotMatch(pedido, /quería consultarles 😊/);
  assert.doesNotMatch(pedido, /page: window\.location\.href/);
  assert.match(pedido, /page: code \? '\/pedido\/\?code=' \+ encodeURIComponent\(code\)/);
});
