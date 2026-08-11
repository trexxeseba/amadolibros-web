import test from 'node:test';
import assert from 'node:assert/strict';

import { SITEMAP_SEGMENTS, sitemapIndexXml, urlsetXml } from '../_shared/sitemap.js';
import { STATIC_SITEMAP_PAGES } from '../sitemap-pages.xml.js';
import { categorySitemapEntries } from '../sitemap-categories.xml.js';
import { activeBookSitemapEntries } from '../sitemap-books-active.xml.js';
import { SEO_CATEGORIES } from '../_shared/seo-categories.js';

test('sitemap.xml indexa sólo segmentos actualmente indexables', () => {
  assert.equal(SITEMAP_SEGMENTS.length, 3);
  assert.ok(SITEMAP_SEGMENTS.some(url => url.endsWith('/sitemap-pages.xml')));
  assert.ok(SITEMAP_SEGMENTS.some(url => url.endsWith('/sitemap-categories.xml')));
  assert.ok(SITEMAP_SEGMENTS.some(url => url.endsWith('/sitemap-books-active.xml')));
  assert.ok(!SITEMAP_SEGMENTS.some(url => url.includes('paused')));

  const xml = sitemapIndexXml();
  assert.match(xml, /<sitemapindex /);
  assert.doesNotMatch(xml, /<priority>|<changefreq>/);
});

test('pages y categorías quedan separados para observabilidad', () => {
  assert.ok(STATIC_SITEMAP_PAGES.includes('https://www.amadolibros.com/catalogo'));
  assert.ok(STATIC_SITEMAP_PAGES.includes('https://www.amadolibros.com/pedir-libro'));
  assert.ok(STATIC_SITEMAP_PAGES.includes('https://www.amadolibros.com/libros-agotados-importados-uruguay'));
  assert.ok(!STATIC_SITEMAP_PAGES.some(url => url.includes('/libros/')));

  const categories = categorySitemapEntries();
  assert.equal(categories.length, SEO_CATEGORIES.length);
  assert.ok(categories.every(entry => entry.loc.startsWith('https://www.amadolibros.com/libros/')));
});

test('segmento de libros activos excluye pausados, agotados e inválidos', () => {
  const entries = activeBookSitemapEntries({
    items: [
      { id: 'MLU1', title: 'Libro Uno', status: 'active', available_quantity: 1 },
      { id: 'MLU2', title: 'Libro Dos', status: 'paused', available_quantity: 0 },
      { id: 'MLU3', title: 'Libro Tres', status: 'active', available_quantity: 0 },
      { id: null, title: 'Sin ID', status: 'active', available_quantity: 1 },
    ],
  });

  assert.deepEqual(entries, [
    { loc: 'https://www.amadolibros.com/libro/MLU1/libro-uno' },
  ]);
});

test('urlset no inventa lastmod cuando no existe una fecha significativa fiable', () => {
  const xml = urlsetXml([{ loc: 'https://www.amadolibros.com/catalogo' }]);
  assert.doesNotMatch(xml, /<lastmod>/);
  assert.doesNotMatch(xml, /<priority>|<changefreq>/);
});
