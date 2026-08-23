import assert from 'node:assert/strict';
import test from 'node:test';

import {
  meaningfulDescription,
  renderPage,
} from '../libro/[[path]].js';

function book(overrides = {}) {
  return {
    id: 'MLU123456789',
    title: 'Biblia Reina-Valera 1960 letra grande',
    author: 'Sociedades Bíblicas Unidas',
    isbn: '9780000000002',
    publisher: 'Editorial de prueba',
    pages: 1280,
    price: 2490,
    currency: 'UYU',
    status: 'active',
    available_quantity: 2,
    condition: 'new',
    pictures: ['https://http2.mlstatic.com/D_TEST-O.jpg'],
    thumbnail: '',
    permalink: 'https://articulo.mercadolibre.com.uy/MLU123456789',
    description: 'Edición de prueba con referencias y mapas. Revisá los datos físicos antes de comprar.',
    bibliographic: {
      language: 'Español',
      format: 'Tapa dura',
      edition: 'Reina-Valera 1960',
      publication_year: '2024',
    },
    ...overrides,
  };
}

function jsonLd(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/g)]
    .map(match => JSON.parse(match[1]));
}

test('muestra autor y datos verificables de la edición en HTML visible, no en details', () => {
  const html = renderPage(book(), 'biblia-reina-valera-1960-letra-grande', true, '');

  assert.match(html, /class="product-byline">de [\s\S]*Sociedades Bíblicas Unidas/);
  assert.match(html, /<section class="edition-facts"[^>]*>/);
  assert.match(html, /<h2 id="edition-facts-title">Datos de esta edición<\/h2>/);
  assert.match(html, /<dt>ISBN<\/dt><dd>9780000000002<\/dd>/);
  assert.match(html, /<dt>Editorial<\/dt><dd>Editorial de prueba<\/dd>/);
  assert.match(html, /<dt>Idioma<\/dt><dd>Español<\/dd>/);
  assert.match(html, /<dt>Formato<\/dt><dd>Tapa dura<\/dd>/);
  assert.match(html, /<dt>Edición<\/dt><dd>Reina-Valera 1960<\/dd>/);
  assert.doesNotMatch(html, /<details class="book-more"/);
  assert.ok(html.indexOf('Agregar al carrito') < html.indexOf('Datos de esta edición'));
});

test('suprime una descripción que sólo repite el título y conserva una descripción real', () => {
  assert.equal(
    meaningfulDescription('Biblia RVR 1960', '  Biblia RVR 1960  '),
    '',
  );
  assert.equal(
    meaningfulDescription('Biblia RVR 1960', 'Edición con letra grande y mapas.'),
    'Edición con letra grande y mapas.',
  );

  const duplicated = renderPage(book({
    description: 'Biblia Reina-Valera 1960 letra grande',
  }), 'biblia-reina-valera-1960-letra-grande', true, '');
  assert.doesNotMatch(duplicated, /class="book-description"/);

  const useful = renderPage(book(), 'biblia-reina-valera-1960-letra-grande', true, '');
  assert.match(useful, /Descripción de esta edición/);
  assert.match(useful, /Edición de prueba con referencias y mapas/);
});

test('la promesa logística visible queda condicionada y no promete dos horas a todo el stock', () => {
  const html = renderPage(book(), 'biblia-reina-valera-1960-letra-grande', true, '');

  assert.match(html, /Entregas rápidas en Montevideo, según zona, horario y disponibilidad/);
  assert.doesNotMatch(html, /Entrega en 2 horas en Montevideo/);
});

test('Product\/Book identifica URL canónica y breadcrumb completo', () => {
  const html = renderPage(book(), 'biblia-reina-valera-1960-letra-grande', true, '');
  const schemas = jsonLd(html);
  const product = schemas.find(schema => Array.isArray(schema['@type']));
  const breadcrumb = schemas.find(schema => schema['@type'] === 'BreadcrumbList');

  assert.ok(product);
  assert.deepEqual(product['@type'], ['Product', 'Book']);
  assert.equal(
    product.url,
    'https://www.amadolibros.com/libro/MLU123456789/biblia-reina-valera-1960-letra-grande',
  );
  assert.equal(product.isbn, '9780000000002');
  assert.equal(product.offers.url, product.url);

  assert.ok(breadcrumb);
  assert.deepEqual(
    breadcrumb.itemListElement.map(row => [row.position, row.name]),
    [
      [1, 'Inicio'],
      [2, 'Catálogo'],
      [3, 'Biblia Reina-Valera 1960 letra grande'],
    ],
  );
  assert.match(html, /<a href="\/catalogo">Catálogo<\/a>/);
});
