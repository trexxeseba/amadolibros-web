import test from 'node:test';
import assert from 'node:assert/strict';

import { renderPage } from '../libro/[[path]].js';
import { normalizeProductSnippetSchemaHtml } from '../libro/_middleware.js';

function item(overrides = {}) {
  return {
    id: 'MLU123456789',
    title: 'Artículo de prueba',
    price: 1200,
    currency: 'UYU',
    status: 'active',
    available_quantity: 1,
    condition: 'new',
    thumbnail: 'https://http2.mlstatic.com/D_123-MLU-O.jpg',
    pictures: ['https://http2.mlstatic.com/D_123-MLU-O.jpg'],
    permalink: 'https://articulo.mercadolibre.com.uy/MLU-123456789-x',
    ...overrides,
  };
}

function productSchema(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]))
    .find((schema) => schema?.sku === 'MLU123456789');
}

const BOOK = {
  domain_id: 'MLU-BOOKS',
  author: 'Autora Prueba',
  isbn: '9788432214721',
  publisher: 'Editorial Real',
  pages: 320,
};

const ANTIQUE = {
  title: 'Candelabro antiguo de bronce',
  domain_id: 'MLU-CANDELABRAS',
  condition: 'used',
  publisher: 'Genérica',
  author: 'Desconocido',
  pages: 12,
  bibliographic: { language: 'Español', format: 'Tapa blanda', genre: 'Decoración' },
};

test('un libro sigue saliendo como Product + Book con sus datos bibliográficos', () => {
  const schema = productSchema(renderPage(item(BOOK), 'libro', false, ''));
  assert.deepEqual(schema['@type'], ['Product', 'Book']);
  assert.equal(schema.isbn, '9788432214721');
  assert.equal(schema.gtin, '9788432214721');
  assert.equal(schema.author.name, 'Autora Prueba');
  assert.equal(schema.publisher.name, 'Editorial Real');
  assert.equal(schema.numberOfPages, 320);
  assert.equal(schema.offers.itemCondition, 'https://schema.org/NewCondition');
});

test('una antigüedad vendible sale como Product, sin propiedades de libro', () => {
  const schema = productSchema(renderPage(item(ANTIQUE), 'candelabro', false, ''));
  assert.equal(schema['@type'], 'Product');
  for (const key of ['isbn', 'author', 'publisher', 'numberOfPages', 'inLanguage', 'bookFormat', 'genre']) {
    assert.equal(schema[key], undefined, `${key} no corresponde a un producto que no es libro`);
  }
  assert.equal(schema.offers.price, '1200');
  assert.equal(schema.offers.priceCurrency, 'UYU');
  assert.equal(schema.offers.itemCondition, 'https://schema.org/UsedCondition');
  assert.ok(schema.name && schema.sku);
});

test('un mazo con código de barras válido conserva gtin pero no isbn', () => {
  const schema = productSchema(renderPage(item({
    title: 'Mazo de tarot 78 cartas',
    domain_id: 'MLU-TAROT_CARDS',
    isbn: '9788432214721',
  }), 'mazo', false, ''));
  assert.equal(schema['@type'], 'Product');
  assert.equal(schema.gtin, '9788432214721');
  assert.equal(schema.isbn, undefined);
});

test('lo que no es libro y no tiene oferta vendible no declara Product ni Book', () => {
  const html = renderPage(item({ ...ANTIQUE, status: 'paused', available_quantity: 0 }), 'candelabro', false, '');
  const schema = productSchema(html);
  assert.equal(schema['@type'], 'Thing');
  assert.equal(schema.offers, undefined);
  // El middleware no lo vuelve a convertir en Book.
  assert.equal(productSchema(normalizeProductSnippetSchemaHtml(html))['@type'], 'Thing');
});

test('sin dominio (fichas pausadas) no se degrada un libro por falta de datos', () => {
  const html = renderPage(item({ status: 'paused', available_quantity: 0, author: 'Autora Prueba' }), 'libro', false, '');
  assert.deepEqual(productSchema(html)['@type'], ['Product', 'Book']);
  assert.equal(productSchema(normalizeProductSnippetSchemaHtml(html))['@type'], 'Book');
});
