import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const carrito = readFileSync(path.join(ROOT, 'astro-front/src/pages/carrito.astro'), 'utf8');
const migration = readFileSync(path.join(ROOT, 'migrations/0006_orders_buyer_email.sql'), 'utf8');

test('email-compra-2: checkout pide correo con ayuda y error accesible', () => {
  assert.match(carrito, /id="buyer-email"[^>]*type="email"|type="email"[^>]*id="buyer-email"/);
  assert.match(carrito, /id="buyer-email"[^>]*\brequired\b/);
  assert.match(carrito, /id="buyer-email-help"/);
  assert.match(carrito, /aria-describedby="buyer-email-help err-buyer-email"/);
  assert.match(carrito, /id="err-buyer-email"[^>]*role="alert"/);
  assert.match(carrito, /buyer:\s*\{ name: name, phone: phone, email: email \}/);
  assert.match(carrito, /buyer:\s*\{ name: prepName, phone: prepPhone, email: prepEmail \}/);
});

test('email-compra-2: correo permanece sólo en el borrador de esta pestaña', () => {
  assert.match(carrito, /'buyer-name', 'buyer-phone', 'buyer-email'/);
  assert.match(carrito, /sessionStorage\.setItem\(CHECKOUT_DRAFT_KEY/);
  assert.doesNotMatch(carrito, /localStorage[^\n]*buyer-email/);
});

test('email-compra-2: migración agrega buyer_email sin alterar órdenes históricas', () => {
  assert.match(migration, /ALTER TABLE orders ADD COLUMN buyer_email TEXT/);
  assert.doesNotMatch(migration, /NOT NULL/);
});
