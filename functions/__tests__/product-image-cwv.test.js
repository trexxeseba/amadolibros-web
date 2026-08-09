import test from 'node:test';
import assert from 'node:assert/strict';

import { renderPage } from '../libro/[[path]].js';

function item(overrides = {}) {
  return {
    id: 'MLU123456789',
    title: 'Libro de prueba',
    author: 'Autora Real',
    isbn: '9781234567897',
    price: 2500,
    available_quantity: 2,
    status: 'active',
    condition: 'new',
    permalink: 'https://articulo.mercadolibre.com.uy/MLU-123456789',
    pictures: [
      'https://http2.mlstatic.com/cover-a.jpg',
      'https://http2.mlstatic.com/cover-b.jpg',
    ],
    ...overrides,
  };
}

function html(overrides = {}) {
  return renderPage(item(overrides), 'libro-de-prueba', false, '');
}

test('la portada principal es la unica imagen prioritaria de la ficha', () => {
  const body = html();
  const main = body.match(/<img class="cover-main"[^>]*>/)?.[0] || '';
  const logo = body.match(/<img src="\/images\/logo-amado\.webp"[^>]*>/)?.[0] || '';
  assert.match(main, /fetchpriority="high"/);
  assert.match(main, /loading="eager"/);
  assert.match(main, /decoding="async"/);
  assert.match(main, /width="260"/);
  assert.match(main, /height="390"/);
  assert.doesNotMatch(logo, /fetchpriority="high"/);
});

test('el lightbox oculto no descarga una segunda copia antes de abrirse', () => {
  const body = html();
  const lightbox = body.match(/<img class="lb-img"[^>]*>/)?.[0] || '';
  assert.ok(lightbox);
  assert.doesNotMatch(lightbox, /\ssrc=/);
  assert.match(lightbox, /decoding="async"/);
  assert.ok(body.indexOf('updateLb();lb.removeAttribute(\'hidden\')') > -1);
});

test('la portada reserva una relacion 2:3 y evita saltos de layout', () => {
  const body = html();
  assert.match(body, /\.cover-main\{[^}]*aspect-ratio:2\/3[^}]*object-fit:contain/s);
});

test('en stock, carrito domina y WhatsApp queda como accion secundaria', () => {
  const body = html();
  const cartAt = body.indexOf('class="btn btn-cart"');
  const waAt = body.indexOf('class="btn btn-wa btn-secondary"');
  assert.ok(cartAt > -1 && waAt > -1 && cartAt < waAt);
  assert.match(body, /\.btn-wa\.btn-secondary\{/);
});

test('en pausadas WhatsApp conserva rol de CTA principal', () => {
  const body = html({ status: 'paused', available_quantity: 0 });
  assert.match(body, /class="btn btn-wa"/);
  assert.doesNotMatch(body, /class="btn btn-wa btn-secondary"/);
});
