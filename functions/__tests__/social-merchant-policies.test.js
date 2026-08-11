import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderPage } from '../libro/[[path]].js';

const root = rel => fileURLToPath(new URL('../../' + rel, import.meta.url));
const read = rel => readFileSync(root(rel), 'utf8');

function productSchemaFromHtml(html) {
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const parsed = JSON.parse(match[1]);
    const types = Array.isArray(parsed['@type']) ? parsed['@type'] : [parsed['@type']];
    if (types.includes('Product')) return parsed;
  }
  throw new Error('Product JSON-LD no encontrado');
}

function item(overrides = {}) {
  return {
    id: 'MLU123456789',
    title: 'Libro de prueba',
    author: 'Autora Real',
    isbn: '9781234567897',
    publisher: 'Editorial Real',
    price: 1500,
    available_quantity: 2,
    status: 'active',
    condition: 'new',
    permalink: 'https://articulo.mercadolibre.com.uy/MLU-123456789',
    pictures: ['https://http2.mlstatic.com/test.jpg'],
    ...overrides,
  };
}

test('BaseLayout completa Open Graph y Twitter para las páginas Astro', () => {
  const layout = read('astro-front/src/layouts/BaseLayout.astro');
  for (const property of ['og:type', 'og:locale', 'og:site_name', 'og:title', 'og:description', 'og:url', 'og:image', 'og:image:alt']) {
    assert.match(layout, new RegExp(`property="${property}"`));
  }
  for (const name of ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image', 'twitter:image:alt']) {
    assert.match(layout, new RegExp(`name="${name}"`));
  }
});

test('la política global de envíos modela exactamente el umbral de $1.500', () => {
  const page = read('astro-front/src/pages/envios.astro');
  assert.match(page, /'@type': 'ShippingService'/);
  assert.match(page, /maxValue: 1499\.99/);
  assert.match(page, /minValue: 1500/);
  assert.match(page, /value: 250, currency: 'UYU'/);
  assert.match(page, /value: 0, currency: 'UYU'/);
  assert.match(page, /addressCountry: 'UY'/);
});

test('la política global de devoluciones refleja la página visible', () => {
  const page = read('astro-front/src/pages/devoluciones.astro');
  assert.match(page, /'@type': 'MerchantReturnPolicy'/);
  assert.match(page, /merchantReturnDays: 5/);
  assert.match(page, /ReturnFeesCustomerResponsibility/);
  assert.match(page, /devoluciones#merchant-return-policy/);
});

test('las ofertas activas referencian la política global y las pausadas no crean Offer', () => {
  const active = productSchemaFromHtml(renderPage(item(), 'libro-de-prueba', false, ''));
  assert.deepEqual(active.offers.hasMerchantReturnPolicy, {
    '@id': 'https://www.amadolibros.com/devoluciones#merchant-return-policy',
  });
  assert.deepEqual(active.offers.seller, {
    '@type': 'Organization',
    name: 'Amado Libros',
    url: 'https://www.amadolibros.com',
  });

  const paused = productSchemaFromHtml(renderPage(
    item({ status: 'paused', available_quantity: 0 }),
    'libro-de-prueba',
    false,
    '',
  ));
  assert.equal(paused.offers, undefined);
});
