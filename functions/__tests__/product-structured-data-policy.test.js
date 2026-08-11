import test from 'node:test';
import assert from 'node:assert/strict';

import { renderPage } from '../libro/[[path]].js';

function productSchemaFromHtml(html) {
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  for (const match of scripts) {
    const parsed = JSON.parse(match[1]);
    const types = Array.isArray(parsed['@type']) ? parsed['@type'] : [parsed['@type']];
    if (types.includes('Product') || types.includes('Book')) return parsed;
  }
  throw new Error('Product/Book JSON-LD not found');
}

function item(overrides = {}) {
  return {
    id: 'MLU123456789',
    title: 'Libro de prueba',
    author: 'Autora Real',
    isbn: '9781234567897',
    publisher: 'Editorial Real',
    price: 2500,
    available_quantity: 2,
    status: 'active',
    condition: 'new',
    permalink: 'https://articulo.mercadolibre.com.uy/MLU-123456789',
    pictures: ['https://http2.mlstatic.com/test.jpg'],
    ...overrides,
  };
}

test('oferta activa enlaza la política real de devoluciones sin inventar ventana', () => {
  const schema = productSchemaFromHtml(renderPage(item(), 'libro-de-prueba', false, ''));
  assert.ok(schema.offers);
  assert.deepEqual(schema.offers.hasMerchantReturnPolicy, {
    '@type': 'MerchantReturnPolicy',
    merchantReturnLink: 'https://www.amadolibros.com/devoluciones',
  });
  assert.equal(schema.offers.priceValidUntil, undefined);
  assert.equal(schema.offers.shippingDetails, undefined);
});

test('mantiene publisher real y no lo convierte artificialmente en brand', () => {
  const schema = productSchemaFromHtml(renderPage(item(), 'libro-de-prueba', false, ''));
  assert.deepEqual(schema.publisher, { '@type': 'Organization', name: 'Editorial Real' });
  assert.equal(schema.brand, undefined);
});

test('ficha pausada sigue siendo Book/Product sin Offer ni política comercial ficticia', () => {
  const schema = productSchemaFromHtml(renderPage(item({ status: 'paused', available_quantity: 0 }), 'libro-de-prueba', false, ''));
  assert.equal(schema.offers, undefined);
});
