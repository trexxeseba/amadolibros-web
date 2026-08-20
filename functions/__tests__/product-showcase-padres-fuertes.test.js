import test from 'node:test';
import assert from 'node:assert/strict';

import { renderPage } from '../libro/[[path]].js';
import { enrichProductShowcaseHtml } from '../libro/_middleware.js';
import { PRODUCT_SHOWCASE_OVERRIDES } from '../_shared/product-showcases.js';

const PRODUCT_ID = 'MLU633557235';

function baseHtml() {
  const productSchema = {
    '@context': 'https://schema.org',
    '@type': ['Product', 'Book'],
    name: 'Padres Fuertes, Hijas Felices - Meeker, Meg',
    description: 'Descripción original corta',
    sku: PRODUCT_ID,
    isbn: '9788496836693',
    offers: {
      '@type': 'Offer',
      priceCurrency: 'UYU',
      price: '1990',
      availability: 'https://schema.org/InStock',
    },
  };
  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Inicio' },
      { '@type': 'ListItem', position: 2, name: 'Catálogo' },
      { '@type': 'ListItem', position: 3, name: 'Padres Fuertes, Hijas Felices - Meeker, Meg' },
    ],
  };
  return `<!doctype html>
<html lang="es">
<head>
  <style>.info h1{font-size:1.25rem}</style>
  <script type="application/ld+json">${JSON.stringify(productSchema)}</script>
  <script type="application/ld+json">${JSON.stringify(breadcrumbSchema)}</script>
</head>
<body>
  <nav><a href="/">Inicio</a> › <a href="/catalogo">Catálogo</a> › <span>Padres Fuertes, Hijas Felices - Meeker, Meg</span></nav>
  <main>
    <div class="info">
      <h1>Padres Fuertes, Hijas Felices - Meeker, Meg</h1>
      <span class="badge in-stock">✓ En stock</span>
      <div class="price-box">Precio</div>
      <button data-action="add-to-cart">Agregar al carrito</button>
      <a class="btn btn-ml" href="https://articulo.mercadolibre.com.uy/MLU-633557235">Comprar en Mercado Libre</a>
    </div>
  </main>
</body>
</html>`;
}

function schemasFrom(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(match => JSON.parse(match[1]));
}

test('la ficha vidriera tiene contenido editorial original y edición exacta', () => {
  const showcase = PRODUCT_SHOWCASE_OVERRIDES[PRODUCT_ID];

  assert.equal(showcase.h1, 'Padres fuertes, hijas felices');
  assert.equal(showcase.subtitle, '10 secretos que todo padre debería conocer');
  assert.equal(showcase.schema.isbn, '9788496836693');
  assert.equal(showcase.schema.numberOfPages, 248);
  assert.equal(showcase.schema.publisher.name, 'Ciudadela Libros');
  assert.equal(showcase.editionFacts.length, 14);
  assert.ok(showcase.summary.join(' ').length > 1200);
  assert.ok(showcase.highlights.length >= 5);
});

test('enriquece la ficha visible sin tocar precio, carrito ni enlace de Mercado Libre', () => {
  const html = enrichProductShowcaseHtml(baseHtml(), PRODUCT_ID);

  assert.match(html, /<h1>Padres fuertes, hijas felices<\/h1>/);
  assert.match(html, /class="book-subtitle">10 secretos que todo padre debería conocer/);
  assert.match(html, /class="product-showcase"/);
  assert.match(html, /¿De qué trata Padres fuertes, hijas felices\?/);
  assert.match(html, /Qué vas a encontrar/);
  assert.match(html, /¿Para quién es este libro\?/);
  assert.match(html, /Ficha de esta edición/);
  assert.match(html, /Ciudadela Libros/);
  assert.match(html, /Mariano José Vázquez Alonso/);
  assert.match(html, /Strong Fathers, Strong Daughters/);
  assert.match(html, /data-action="add-to-cart"/);
  assert.match(html, /class="price-box">Precio/);
  assert.match(html, /Comprar en Mercado Libre/);
});

test('enriquece Book/Product con bibliografía verificada y preserva Offer real', () => {
  const html = enrichProductShowcaseHtml(baseHtml(), PRODUCT_ID);
  const schemas = schemasFrom(html);
  const product = schemas.find(schema => schema.sku === PRODUCT_ID);
  const breadcrumb = schemas.find(schema => schema['@type'] === 'BreadcrumbList');

  assert.deepEqual(product['@type'], ['Product', 'Book']);
  assert.equal(product.name, 'Padres fuertes, hijas felices');
  assert.equal(product.alternateName, 'Padres fuertes, hijas felices: 10 secretos que todo padre debería conocer');
  assert.equal(product.isbn, '9788496836693');
  assert.equal(product.numberOfPages, 248);
  assert.equal(product.bookEdition, '3.ª edición');
  assert.equal(product.datePublished, '2010-07-01');
  assert.equal(product.publisher.name, 'Ciudadela Libros');
  assert.equal(product.translator.name, 'Mariano José Vázquez Alonso');
  assert.equal(product.offers.price, '1990');
  assert.equal(product.offers.availability, 'https://schema.org/InStock');
  assert.equal(product.review, undefined);
  assert.equal(product.aggregateRating, undefined);
  assert.equal(breadcrumb.itemListElement.at(-1).name, 'Padres fuertes, hijas felices');
});

test('el enriquecimiento es idempotente y no se aplica a otro MLU', () => {
  const source = baseHtml();
  const first = enrichProductShowcaseHtml(source, PRODUCT_ID);
  const second = enrichProductShowcaseHtml(first, PRODUCT_ID);

  assert.equal(second, first);
  assert.equal((second.match(/class="product-showcase"/g) || []).length, 1);
  assert.equal(enrichProductShowcaseHtml(source, 'MLU999999999'), source);
});

test('renderPage aplica title y meta description curados antes del middleware', () => {
  const html = renderPage({
    id: PRODUCT_ID,
    title: 'Padres Fuertes, Hijas Felices - Meeker, Meg',
    author: 'Meeker, Meg',
    price: 1990,
    currency: 'UYU',
    status: 'active',
    available_quantity: 1,
    condition: 'new',
    isbn: '9788496836693',
    publisher: null,
    pages: null,
    dimensions: { width: '24 cm', height: '16 cm', weight: '448 g' },
    thumbnail: 'https://http2.mlstatic.com/D_1-I.jpg',
    pictures: [],
    permalink: 'https://articulo.mercadolibre.com.uy/MLU-633557235',
  }, 'padres-fuertes-hijas-felices-meeker-meg', false, '');

  assert.match(html, /<title>Padres fuertes, hijas felices — Meg Meeker \| Amado Libros<\/title>/);
  assert.match(html, /Conseguí Padres fuertes, hijas felices de Meg Meeker en Uruguay/);
  assert.match(html, /ISBN 9788496836693/);
});
