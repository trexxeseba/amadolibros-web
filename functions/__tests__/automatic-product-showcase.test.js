import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAutomaticProductShowcase,
  productItemFromProductHtml,
} from '../_shared/automatic-product-showcase.js';
import {
  enrichAutomaticProductShowcaseHtml,
  enrichProductShowcaseHtml,
} from '../libro/_middleware.js';
import { renderPage } from '../libro/[[path]].js';

const PRODUCT_ID = 'MLU123456789';
const SLUG = 'manual-de-prueba-clinica';

function book(overrides = {}) {
  return {
    id: PRODUCT_ID,
    title: 'Manual de prueba clínica',
    author: 'Ana Pérez',
    isbn: '9788496836693',
    publisher: 'Editorial Real',
    pages: 320,
    price: 1990,
    currency: 'UYU',
    status: 'active',
    available_quantity: 3,
    condition: 'new',
    thumbnail: 'https://http2.mlstatic.com/D_1-I.jpg',
    pictures: [
      'https://http2.mlstatic.com/D_1-O.jpg',
      'https://http2.mlstatic.com/D_2-O.jpg',
    ],
    permalink: 'https://articulo.mercadolibre.com.uy/MLU-123456789',
    bibliographic: {
      subtitle: 'Herramientas para la práctica',
      language: 'Español',
      format: 'Tapa blanda',
      edition: '2.ª edición',
      publication_year: '2024',
      genre: 'Psicología clínica',
      collection: 'Biblioteca Profesional',
      translator: 'María Gómez',
    },
    dimensions: { width: '16 cm', height: '23 cm', weight: '540 g' },
    description: 'Este manual presenta un recorrido sistemático por la evaluación clínica. Incluye criterios para organizar entrevistas, registrar hipótesis y revisar decisiones. Está orientado a una aplicación responsable y contextualizada. También incorpora ejemplos para acompañar el estudio y la práctica profesional.',
    ...overrides,
  };
}

function rendered(item = book(), relatedBooks = []) {
  return renderPage(item, SLUG, false, '', '', relatedBooks);
}

function productSchema(html) {
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const schema = JSON.parse(match[1]);
    const types = Array.isArray(schema['@type']) ? schema['@type'] : [schema['@type']];
    if (types.includes('Book') && schema.sku === PRODUCT_ID) return schema;
  }
  return null;
}

test('extrae del HTML SSR únicamente datos reales de la publicación', () => {
  const item = productItemFromProductHtml(rendered(), PRODUCT_ID);

  assert.equal(item.id, PRODUCT_ID);
  assert.equal(item.title, 'Manual de prueba clínica');
  assert.equal(item.author, 'Ana Pérez');
  assert.equal(item.isbn, '9788496836693');
  assert.equal(item.publisher, 'Editorial Real');
  assert.equal(item.pages, 320);
  assert.equal(item.condition, 'Nuevo');
  assert.equal(item.bibliographic.subtitle, 'Herramientas para la práctica');
  assert.equal(item.bibliographic.genre, 'Psicología clínica');
  assert.equal(item.bibliographic.translator, 'María Gómez');
  assert.match(item.description, /evaluación clínica/);
  assert.equal(item.pictures.length, 2);
  assert.match(item.dimensions_text, /Ancho 16 cm/);
});

test('usa la descripción real y todos los datos verificables', () => {
  const showcase = buildAutomaticProductShowcase(book());

  assert.equal(showcase.subtitle, 'Herramientas para la práctica');
  assert.match(showcase.introHeading, /¿De qué trata Manual de prueba clínica\?/);
  assert.ok(showcase.summary.join(' ').includes('evaluación clínica'));
  assert.ok(showcase.highlights.some(value => value.includes('Psicología clínica')));
  assert.ok(showcase.editionFacts.some(fact => fact.label === 'ISBN' && fact.value === '9788496836693'));
  assert.ok(showcase.editionFacts.some(fact => fact.label === 'Medidas' && fact.value.includes('alto 23 cm')));
  assert.ok(showcase.links.some(link => link.href.includes('Ana%20P%C3%A9rez')));
  assert.match(showcase.metaDescription, /12% menos por transferencia/);
  assert.ok(showcase.metaDescription.length <= 170);
});

test('sin descripción no inventa una sinopsis y lo declara con hechos', () => {
  const showcase = buildAutomaticProductShowcase(book({ description: null }));

  assert.equal(showcase.introHeading, 'Sobre Manual de prueba clínica');
  assert.match(showcase.summary[0], /Esta ficha corresponde/);
  assert.match(showcase.summary.join(' '), /ISBN 9788496836693/);
  assert.doesNotMatch(showcase.summary.join(' '), /presenta un recorrido sistemático/);
});

test('sin autor confiable no inventa biografía', () => {
  const showcase = buildAutomaticProductShowcase(book({ author: 'Varios autores' }));

  assert.equal(showcase.authorHeading, 'Sobre la autoría');
  assert.match(showcase.authorBio, /No completamos ese dato por inferencia/);
  assert.ok(!showcase.links.some(link => link.label.includes('Varios autores')));
});

test('no duplica un subtítulo ya incluido en el título', () => {
  const showcase = buildAutomaticProductShowcase(book({
    title: 'Manual de prueba clínica: Herramientas para la práctica',
  }));

  assert.equal(showcase.subtitle, 'De Ana Pérez');
});

test('convierte una ficha activa en vidriera sin tocar precio, stock ni acciones', () => {
  const source = rendered();
  const html = enrichAutomaticProductShowcaseHtml(source, PRODUCT_ID);

  assert.match(html, /class="product-showcase"/);
  assert.match(html, /¿De qué trata Manual de prueba clínica\?/);
  assert.match(html, /Datos destacados/);
  assert.match(html, /¿Para quién puede ser útil\?/);
  assert.match(html, /Más sobre Ana Pérez/);
  assert.match(html, /Ficha de esta edición/);
  assert.match(html, /Herramientas para la práctica/);
  assert.match(html, /Editorial Real/);
  assert.match(html, /data-action="add-to-cart"/);
  assert.match(html, /Precio web\/tarjeta:/);
  assert.match(html, /12% menos por transferencia/);
  assert.match(html, /Comprar en MercadoLibre/);
  assert.match(html, /https:\/\/articulo\.mercadolibre\.com\.uy\/MLU-123456789/);
  assert.match(html, /<meta name="description" content="Comprá Manual de prueba clínica de Ana Pérez en Uruguay\./);

  const schema = productSchema(html);
  assert.ok(schema);
  assert.deepEqual(schema['@type'], ['Product', 'Book']);
  assert.equal(schema.offers.price, '1990');
  assert.equal(schema.offers.availability, 'https://schema.org/InStock');
  assert.match(schema.description, /evaluación clínica/);
  assert.equal(schema.review, undefined);
  assert.equal(schema.aggregateRating, undefined);
});

test('la vidriera aparece antes de los libros relacionados', () => {
  const related = [{
    id: 'MLU987654321',
    title: 'Otro libro de Ana Pérez',
    author: 'Ana Pérez',
    status: 'active',
    available_quantity: 1,
    thumbnail: 'https://http2.mlstatic.com/D_3-I.jpg',
    pictures: [],
  }];
  const html = enrichAutomaticProductShowcaseHtml(rendered(book(), related), PRODUCT_ID);

  assert.ok(html.indexOf('class="product-showcase"') < html.indexOf('class="related-books"'));
});

test('es idempotente y no reemplaza una ficha curada manualmente', () => {
  const source = rendered();
  const first = enrichAutomaticProductShowcaseHtml(source, PRODUCT_ID);
  const second = enrichAutomaticProductShowcaseHtml(first, PRODUCT_ID);
  assert.equal(second, first);
  assert.equal((second.match(/class="product-showcase"/g) || []).length, 1);

  const curatedId = 'MLU633557235';
  const curatedSource = rendered(book({ id: curatedId }));
  assert.equal(enrichAutomaticProductShowcaseHtml(curatedSource, curatedId), curatedSource);
  assert.notEqual(enrichProductShowcaseHtml(curatedSource, curatedId), curatedSource);
});

test('una ficha pausada no recibe la vidriera automática activa', () => {
  const source = rendered(book({ status: 'paused', available_quantity: 0 }));
  assert.equal(enrichAutomaticProductShowcaseHtml(source, PRODUCT_ID), source);
});
