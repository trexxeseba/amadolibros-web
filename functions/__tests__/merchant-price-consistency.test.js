import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('las cards priorizan el precio web y dejan transferencia como beneficio', () => {
  const card = read('astro-front/src/components/BookCard.astro');
  const base = card.indexOf('Precio web / tarjeta:');
  const transfer = card.indexOf('Transferencia:');

  assert.ok(base !== -1, 'falta el precio web en la card');
  assert.ok(transfer !== -1, 'falta el precio de transferencia en la card');
  assert.ok(base < transfer, 'transferencia no debe ser el precio principal');
  assert.match(card, /data-price=\{book\.price\}/);
  assert.match(card, /ahorrás 12%/);
});

test('feed, datos estructurados, carrito y Mercado Pago parten del precio base', () => {
  const feed = read('functions/feed.xml.js');
  const book = read('functions/libro/[[path]].js');
  const cart = read('astro-front/src/pages/carrito.astro');
  const orders = read('functions/api/_orders_logic.js');
  const mp = read('functions/api/_mp_handler.js');

  assert.match(feed, /const price = item\.price \? `\$\{item\.price\} \$\{currency\}`/);
  assert.match(book, /'price':\s+String\(price\)/);
  assert.match(book, /data-price="\$\{price\}"/);
  assert.match(cart, /item\.price \* item\.quantity/);
  assert.match(orders, /const rawPrice = Number\(catalogItem\.price\)/);
  assert.match(mp, /unit_price:\s+order\.payable_total_uyu/);
});

test('el umbral público de envío gratis queda unificado en 2.000 pesos', () => {
  const catalog = read('functions/catalogo.js');
  const book = read('functions/libro/[[path]].js');
  const shipping = read('astro-front/src/pages/envios.astro');
  const cart = read('astro-front/src/pages/carrito.astro');
  const logic = read('functions/api/_orders_logic.js');

  assert.match(catalog, /envío gratis desde \$2\.000/);
  assert.match(book, /Envío gratis desde \$2\.000/);
  assert.match(shipping, /gratis desde \$2\.000 UYU/);
  assert.match(cart, /FREE_SHIPPING_THRESHOLD_UYU = 2000/);
  assert.match(logic, /FREE_SHIPPING_THRESHOLD = 2000/);

  for (const source of [catalog, book, shipping, cart, logic]) {
    assert.doesNotMatch(source, /envío gratis desde \$1\.500/i);
  }
});
