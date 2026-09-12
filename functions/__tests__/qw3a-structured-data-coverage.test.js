import test from 'node:test';
import assert from 'node:assert/strict';

import { renderPage } from '../libro/[[path]].js';

// QW3A (Merchant, Gran Apuesta en curso): dar a Google más información
// bibliográfica REAL en el JSON-LD y en la ficha técnica visible, usando
// exclusivamente datos que ya existen en el catálogo. La investigación de
// esta sesión confirmó que el mapeo de campos (isbn, author, publisher,
// inLanguage, numberOfPages, bookFormat, datePublished, edition) YA estaba
// implementado en functions/libro/[[path]].js; estos tests bloquean esa
// cobertura para que no se pierda, y verifican el único gap real encontrado:
// el ISBN se publicaba sin validar contra el mismo criterio que ya usa el
// feed de Merchant (normalizeIsbnToGtin).

function productSchemaFromHtml(html) {
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const parsed = JSON.parse(match[1]);
    const types = Array.isArray(parsed['@type']) ? parsed['@type'] : [parsed['@type']];
    if (types.includes('Product')) return parsed;
  }
  throw new Error('Product JSON-LD no encontrado');
}

function fullItem(overrides = {}) {
  return {
    id: 'MLU123456789',
    title: 'Libro de prueba completo',
    author: 'Autora Real',
    isbn: '9788496836693',
    publisher: 'Editorial Real',
    price: 1500,
    currency: 'UYU',
    available_quantity: 2,
    status: 'active',
    condition: 'new',
    pages: 320,
    permalink: 'https://articulo.mercadolibre.com.uy/MLU-123456789',
    pictures: ['https://http2.mlstatic.com/test.jpg'],
    bibliographic: {
      language: 'Español',
      format: 'Tapa blanda',
      edition: '2ª edición',
      publication_year: '2021',
    },
    ...overrides,
  };
}

test('QW3A: ISBN válido se publica en isbn y gtin (mismo dato, dos identificadores)', () => {
  const schema = productSchemaFromHtml(renderPage(fullItem(), 'libro-de-prueba', false, ''));
  assert.equal(schema.isbn, '9788496836693');
  assert.equal(schema.gtin, '9788496836693');
});

test('QW3A: ISBN-10 válido se normaliza a ISBN-13 en isbn/gtin (sin inventar dígitos)', () => {
  // 0307474720 es un ISBN-10 real y válido (equivalente a 9780307474728).
  const schema = productSchemaFromHtml(renderPage(
    fullItem({ isbn: '0307474720' }),
    'libro-de-prueba',
    false,
    '',
  ));
  assert.equal(schema.isbn, '9780307474728');
  assert.equal(schema.gtin, '9780307474728');
});

test('QW3A: ISBN mal formado (dígito verificador incorrecto) NO se publica — no se inventa ni corrige', () => {
  const schema = productSchemaFromHtml(renderPage(
    fullItem({ isbn: '9788496836699' }), // mismo prefijo, dígito verificador roto
    'libro-de-prueba',
    false,
    '',
  ));
  assert.equal('isbn' in schema, false);
  assert.equal('gtin' in schema, false);
});

test('QW3A: sin ISBN en catálogo, no se publica isbn/gtin (no hay fallback inventado)', () => {
  const schema = productSchemaFromHtml(renderPage(
    fullItem({ isbn: null }),
    'libro-de-prueba',
    false,
    '',
  ));
  assert.equal('isbn' in schema, false);
  assert.equal('gtin' in schema, false);
});

test('QW3A: author/publisher/inLanguage/numberOfPages/bookFormat/bookEdition/datePublished ya mapeados y presentes cuando hay dato real', () => {
  const schema = productSchemaFromHtml(renderPage(fullItem(), 'libro-de-prueba', false, ''));
  assert.equal(schema.author.name, 'Autora Real');
  assert.deepEqual(schema.publisher, { '@type': 'Organization', name: 'Editorial Real' });
  assert.equal(schema.inLanguage, 'Español');
  assert.equal(schema.numberOfPages, 320);
  assert.equal(schema.bookFormat, 'Tapa blanda');
  assert.equal(schema.bookEdition, '2ª edición');
  assert.equal(schema.datePublished, '2021');
});

test('QW3A: campos ausentes no generan basura — nunca null, vacío, "N/A" ni "desconocido"', () => {
  const schema = productSchemaFromHtml(renderPage(
    fullItem({
      author: null,
      publisher: null,
      isbn: null,
      pages: null,
      bibliographic: {},
    }),
    'libro-de-prueba',
    false,
    '',
  ));
  for (const key of ['author', 'publisher', 'isbn', 'gtin', 'numberOfPages', 'bookFormat', 'bookEdition', 'datePublished', 'inLanguage']) {
    assert.equal(key in schema, false, `no debe existir la clave "${key}" sin dato real`);
  }
  const serialized = JSON.stringify(schema);
  assert.doesNotMatch(serialized, /\bN\/A\b|desconocid[oa]|unknown/i);
});

test('QW3A: ficha sin bibliographic en absoluto sigue renderizando sin romperse', () => {
  const { bibliographic, ...withoutBibliographic } = fullItem();
  const html = renderPage(withoutBibliographic, 'libro-de-prueba', false, '');
  assert.match(html, /<!doctype html>/i);
  const schema = productSchemaFromHtml(html);
  assert.equal(schema.sku, 'MLU123456789');
});

test('QW3A: JSON-LD sigue siendo parseable y el Offer (QW1) convive sin conflicto', () => {
  const html = renderPage(fullItem(), 'libro-de-prueba', false, '');
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.ok(blocks.length >= 1);
  for (const block of blocks) {
    assert.doesNotThrow(() => JSON.parse(block[1]));
  }
  const schema = productSchemaFromHtml(html);
  assert.ok(schema.offers, 'el Offer de QW1 debe seguir presente');
  assert.equal(schema.offers.price, '1500');
});

test('QW3A: Offer.url sigue coincidiendo con el canonical de la ficha (sin regresión)', () => {
  const html = renderPage(fullItem(), 'otro-slug', false, '');
  const canonicalMatch = html.match(/<link rel="canonical" href="([^"]+)">/);
  const schema = productSchemaFromHtml(html);
  assert.equal(schema.offers.url, canonicalMatch[1]);
});

test('QW3A: la ficha técnica visible ya existe y muestra los campos reales sin filas vacías', () => {
  const html = renderPage(fullItem(), 'libro-de-prueba', false, '');
  assert.match(html, /Autora Real/);
  assert.match(html, />Idioma<[\s\S]*?Español/);
  assert.match(html, />Formato<[\s\S]*?Tapa blanda/);
  assert.match(html, />Edición<[\s\S]*?2ª edición/);
  assert.match(html, />Año<[\s\S]*?2021/);
});

test('QW3A: sin datos bibliográficos, la ficha técnica omite la fila entera (no la deja vacía)', () => {
  const html = renderPage(
    fullItem({ author: null, publisher: null, isbn: null, pages: null, bibliographic: {} }),
    'libro-de-prueba',
    false,
    '',
  );
  assert.doesNotMatch(html, /<dt>Idioma<\/dt>/);
  assert.doesNotMatch(html, /<dt>Formato<\/dt>/);
  assert.doesNotMatch(html, /<dt>ISBN<\/dt>/);
  assert.doesNotMatch(html, /<dt>Editorial<\/dt>/);
  assert.doesNotMatch(html, /<dt>Autor<\/dt>/);
});

test('QW3A: mobile no se rompe — el viewport meta y el bloque de ficha técnica siguen presentes', () => {
  const html = renderPage(fullItem(), 'libro-de-prueba', false, '');
  assert.match(html, /<meta name="viewport" content="width=device-width/);
  assert.match(html, /class="detail-row"/);
});
