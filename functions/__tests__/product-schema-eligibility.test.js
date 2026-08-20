import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeProductSnippetSchemaHtml,
  onRequest,
} from '../libro/_middleware.js';

const PRODUCT_ID = 'MLU123456789';

function htmlWithSchema({
  productType = ['Product', 'Book'],
  offers,
  review,
  aggregateRating,
  active = false,
  paused = false,
  robots = 'index, follow',
} = {}) {
  const product = {
    '@context': 'https://schema.org',
    '@type': productType,
    name: 'Libro de prueba',
    sku: PRODUCT_ID,
    isbn: '9780000000001',
    author: { '@type': 'Person', name: 'Autora Prueba' },
    ...(offers ? { offers } : {}),
    ...(review ? { review } : {}),
    ...(aggregateRating ? { aggregateRating } : {}),
  };
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Inicio', item: 'https://www.amadolibros.com/' },
      { '@type': 'ListItem', position: 2, name: 'Libro de prueba' },
    ],
  };
  const commercial = active
    ? '<span class="badge in-stock">✓ En stock</span><div class="price-box">$1.000 UYU</div>'
    : paused
      ? '<div class="order-box"><strong>¿Buscás este libro?</strong><span>Podemos intentar conseguirlo por encargo. Consultanos y verificamos disponibilidad, edición y precio.</span></div>'
      : '<span class="badge in-stock">✓ En stock</span><div class="order-box"><strong>Precio publicado: USD 10</strong><span>Esta publicación no se convierte automáticamente a UYU. Consultanos para confirmar precio y forma de pago, o comprala directamente en MercadoLibre.</span></div>';

  return `<!doctype html><html><head>
    <meta name="robots" content="${robots}">
    <link rel="canonical" href="https://www.amadolibros.com/libro/${PRODUCT_ID}/libro-de-prueba">
    <script type="application/ld+json">${JSON.stringify(product)}</script>
    <script type="application/ld+json">${JSON.stringify(breadcrumb)}</script>
    <style>main{display:grid}</style>
  </head><body>
    <nav><a href="/">Inicio</a> › <span>Libro de prueba</span></nav>
    <main>${commercial}</main>
  </body></html>`;
}

function jsonLd(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]));
}

function productSchema(html) {
  return jsonLd(html).find((schema) => schema?.sku === PRODUCT_ID);
}

test('ficha activa vendible conserva Product + Book + Offer real', () => {
  const offer = {
    '@type': 'Offer',
    priceCurrency: 'UYU',
    price: '1000',
    availability: 'https://schema.org/InStock',
  };
  const source = htmlWithSchema({ active: true, offers: offer });
  const result = normalizeProductSnippetSchemaHtml(source);
  const schema = productSchema(result);

  assert.deepEqual(schema['@type'], ['Product', 'Book']);
  assert.deepEqual(schema.offers, offer);
});

test('ficha por encargo sin Offer queda como Book y no inventa señales comerciales', () => {
  const source = htmlWithSchema({ paused: true });
  const result = normalizeProductSnippetSchemaHtml(source);
  const schema = productSchema(result);

  assert.equal(schema['@type'], 'Book');
  assert.equal(schema.offers, undefined);
  assert.equal(schema.review, undefined);
  assert.equal(schema.aggregateRating, undefined);
  assert.equal(schema.isbn, '9780000000001');
  assert.equal(schema.author.name, 'Autora Prueba');
});

test('activo en moneda no soportada sin Offer queda como Book', () => {
  const source = htmlWithSchema();
  const result = normalizeProductSnippetSchemaHtml(source);
  const schema = productSchema(result);

  assert.equal(schema['@type'], 'Book');
  assert.equal(schema.offers, undefined);
});

test('Product + Book con review real permanece elegible', () => {
  const review = {
    '@type': 'Review',
    reviewRating: { '@type': 'Rating', ratingValue: '5' },
    author: { '@type': 'Person', name: 'Cliente real' },
  };
  const source = htmlWithSchema({ review });
  const result = normalizeProductSnippetSchemaHtml(source);
  const schema = productSchema(result);

  assert.deepEqual(schema['@type'], ['Product', 'Book']);
  assert.deepEqual(schema.review, review);
});

test('normalización es idempotente', () => {
  const first = normalizeProductSnippetSchemaHtml(htmlWithSchema({ paused: true }));
  const second = normalizeProductSnippetSchemaHtml(first);
  assert.equal(second, first);
});

test('middleware preserva canonical y robots de ficha por encargo mientras corrige schema', async () => {
  const source = htmlWithSchema({ paused: true, robots: 'index, follow' });
  const upstream = new Response(source, {
    status: 200,
    headers: {
      'content-type': 'text/html;charset=UTF-8',
      'cache-control': 'public, max-age=3600',
      etag: '"anterior"',
    },
  });
  const response = await onRequest({
    request: new Request(`https://www.amadolibros.com/libro/${PRODUCT_ID}/libro-de-prueba`),
    next: async () => upstream,
  });
  const html = await response.text();
  const schema = productSchema(html);

  assert.equal(schema['@type'], 'Book');
  assert.match(html, /<meta name="robots" content="index, follow">/);
  assert.match(html, new RegExp(`<link rel="canonical" href="https://www\\.amadolibros\\.com/libro/${PRODUCT_ID}/libro-de-prueba">`));
  assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
  assert.equal(response.headers.get('etag'), null);
});

test('middleware activo vendible conserva Product + Book + Offer y breadcrumb de catálogo', async () => {
  const source = htmlWithSchema({
    active: true,
    offers: {
      '@type': 'Offer',
      priceCurrency: 'UYU',
      price: '1000',
      availability: 'https://schema.org/InStock',
    },
  });
  const upstream = new Response(source, {
    status: 200,
    headers: { 'content-type': 'text/html;charset=UTF-8' },
  });
  const response = await onRequest({
    request: new Request(`https://www.amadolibros.com/libro/${PRODUCT_ID}/libro-de-prueba`),
    next: async () => upstream,
  });
  const html = await response.text();
  const schema = productSchema(html);

  assert.deepEqual(schema['@type'], ['Product', 'Book']);
  assert.ok(schema.offers);
  assert.match(html, /<a href="\/catalogo">Catálogo<\/a>/);
});

test('schema que no es Product/Book queda intacto', () => {
  const source = htmlWithSchema({ productType: 'Book', paused: true });
  const result = normalizeProductSnippetSchemaHtml(source);
  assert.equal(result, source);
});
