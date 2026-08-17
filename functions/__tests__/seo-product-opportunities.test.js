import test from 'node:test';
import assert from 'node:assert/strict';

import { renderPage } from '../libro/[[path]].js';
import {
  INDEXABLE_PAUSED_PRODUCT_PATHS,
  PRODUCT_ID_REDIRECTS,
  PRODUCT_SEO_OVERRIDES,
} from '../_shared/seo-products.js';
import { PAUSED_SEO_COHORT } from '../_shared/paused-seo-cohort.js';
import { pausedBookSitemapEntries } from '../sitemap-books-paused.xml.js';
import { STATIC_SITEMAP_PAGES } from '../sitemap-pages.xml.js';

function book(overrides = {}) {
  return {
    id: 'MLU1', title: 'Libro de prueba', author: 'Autora',
    price: 1200, currency: 'UYU', status: 'active', available_quantity: 2,
    condition: 'new', isbn: '9788499809991', publisher: null,
    pages: null, dimensions: null,
    thumbnail: 'https://http2.mlstatic.com/D_1-I.jpg', pictures: [],
    permalink: 'https://articulo.mercadolibre.com.uy/MLU-1',
    ...overrides,
  };
}

test('las once oportunidades GSC tienen title y description curados', () => {
  assert.equal(Object.keys(PRODUCT_SEO_OVERRIDES).length, 11);
  for (const [id, override] of Object.entries(PRODUCT_SEO_OVERRIDES)) {
    assert.match(id, /^MLU\d+$/);
    assert.ok(override.title.length >= 20 && override.title.length <= 70);
    assert.ok(override.description.length >= 80 && override.description.length <= 180);
  }
});

test('Murdoku conserva indexación aunque esté pausado y muestra intención Uruguay', () => {
  const html = renderPage(book({
    id: 'MLU1416777650',
    title: 'Libro Murdoku 80 Acertijos De Lógica Y Asesinatos De Garand',
    author: 'Manuel Garand',
    isbn: '9791387869380',
    status: 'paused',
    available_quantity: 0,
  }), 'libro-murdoku-80-acertijos-de-logica-y-asesinatos-de-garand-', false, '');

  assert.match(html, /<title>Murdoku en Uruguay: 80 acertijos de lógica \| Amado Libros<\/title>/);
  assert.match(html, /<meta name="robots" content="index, follow">/);
  assert.match(html, /ISBN 9791387869380/);
  assert.match(html, /Ver otros libros Murdoku/);
  assert.doesNotMatch(html, /data-action="add-to-cart"/);
});

test('una ficha pausada común sigue noindex', () => {
  const html = renderPage(book({ status: 'paused', available_quantity: 0 }), 'libro-de-prueba', false, '');
  assert.match(html, /<meta name="robots" content="noindex, follow">/);
});

test('una ficha de la cohorte pausada queda indexable sin oferta ni compra directa', () => {
  const cohortId = PAUSED_SEO_COHORT.find(item => item.id !== 'MLU1416777650').id;
  const html = renderPage(book({
    id: cohortId,
    title: 'Libro difícil de conseguir',
    author: 'Autora de Prueba',
    status: 'paused',
    available_quantity: 0,
  }), 'libro-dificil-de-conseguir', false, '');

  assert.match(html, /<meta name="robots" content="index, follow">/);
  assert.match(html, /Buscamos &quot;Libro difícil de conseguir&quot; de Autora de Prueba por encargo en Uruguay/);
  assert.doesNotMatch(html, /"offers"/);
  assert.doesNotMatch(html, /data-action="add-to-cart"/);
});

test('el duplicado de Murdoku apunta a la URL histórica consolidada', () => {
  assert.deepEqual(PRODUCT_ID_REDIRECTS.MLU1416777648, {
    id: 'MLU1416777650',
    path: '/libro/MLU1416777650/libro-murdoku-80-acertijos-de-logica-y-asesinatos-de-garand-',
  });
});

test('Murdoku sale de sitemap-pages y entra en la cohorte pausada', () => {
  assert.deepEqual(INDEXABLE_PAUSED_PRODUCT_PATHS, [
    '/libro/MLU1416777650/libro-murdoku-80-acertijos-de-logica-y-asesinatos-de-garand-',
  ]);
  assert.ok(!STATIC_SITEMAP_PAGES.some(value => value.includes('MLU1416777650')));
  assert.ok(PAUSED_SEO_COHORT.some(value => value.id === 'MLU1416777650'));
  const entries = pausedBookSitemapEntries({
    items: [{
      id: 'MLU1416777650',
      title: 'Libro Murdoku 80 Acertijos De Lógica Y Asesinatos De Garand',
      status: 'paused',
    }],
  });
  assert.equal(entries.length, 1);
});
