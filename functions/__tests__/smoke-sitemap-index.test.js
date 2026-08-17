import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { analyzeSitemapBody } = require('../../scripts/smoke-production.js');

const BASE = 'https://www.amadolibros.com';
const xml = body => `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
const loc = value => `<loc>${value}</loc>`;

test('acepta el sitemap index segmentado de producción', () => {
  const body = xml(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <sitemap>${loc(`${BASE}/sitemap-pages.xml`)}</sitemap>
    <sitemap>${loc(`${BASE}/sitemap-categories.xml`)}</sitemap>
    <sitemap>${loc(`${BASE}/sitemap-books-active.xml`)}</sitemap>
    <sitemap>${loc(`${BASE}/sitemap-books-paused.xml`)}</sitemap>
  </sitemapindex>`);
  assert.deepEqual(analyzeSitemapBody(body, 'sitemap-index'), { ok: true });
});

test('rechaza el sitemap raíz legacy tipo urlset', () => {
  const body = xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${loc(`${BASE}/`)}</urlset>`);
  const result = analyzeSitemapBody(body, 'sitemap-index');
  assert.equal(result.ok, false);
  assert.match(result.reason, /sitemapindex/);
});

test('el índice admite la cohorte pausada pero rechaza segmentos inesperados', () => {
  const body = xml(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <sitemap>${loc(`${BASE}/sitemap-pages.xml`)}</sitemap>
    <sitemap>${loc(`${BASE}/sitemap-categories.xml`)}</sitemap>
    <sitemap>${loc(`${BASE}/sitemap-books-active.xml`)}</sitemap>
    <sitemap>${loc(`${BASE}/sitemap-books-paused.xml`)}</sitemap>
    <sitemap>${loc(`${BASE}/sitemap-inventado.xml`)}</sitemap>
  </sitemapindex>`);
  const result = analyzeSitemapBody(body, 'sitemap-index');
  assert.equal(result.ok, false);
  assert.match(result.reason, /segmentos/);
});

test('pages exige todas las páginas estáticas relevantes', () => {
  const pages = [
    '/', '/catalogo', '/pedir-libro', '/libros-maria-montessori-uruguay', '/politicas', '/envios',
    '/devoluciones', '/terminos', '/privacidad', '/contacto',
  ];
  const valid = xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map((path, index) => `<url>${loc(`${BASE}${path}`)}${index === 0 ? '<lastmod>2026-08-12</lastmod>' : ''}</url>`).join('')}</urlset>`);
  assert.deepEqual(analyzeSitemapBody(valid, 'sitemap-pages'), { ok: true });

  const missing = valid.replace(`<url>${loc(`${BASE}/privacidad`)}</url>`, '');
  const result = analyzeSitemapBody(missing, 'sitemap-pages');
  assert.equal(result.ok, false);
  assert.match(result.reason, /privacidad/);
});

test('categorías y libros activos deben ser urlsets no vacíos y del espacio correcto', () => {
  const categories = xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url>${loc(`${BASE}/libros/literatura`)}</url></urlset>`);
  const books = xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url>${loc(`${BASE}/libro/MLU1/libro-uno`)}</url></urlset>`);
  assert.deepEqual(analyzeSitemapBody(categories, 'sitemap-categories'), { ok: true });
  assert.deepEqual(analyzeSitemapBody(books, 'sitemap-books-active'), { ok: true });
  assert.deepEqual(analyzeSitemapBody(books, 'sitemap-books-paused'), { ok: true });
});

test('el sitemap pausado rechaza más de 3.000 URLs', () => {
  const urls = Array.from(
    { length: 3001 },
    (_, index) => `<url>${loc(`${BASE}/libro/MLU${index + 1}/libro-${index + 1}`)}</url>`,
  ).join('');
  const result = analyzeSitemapBody(
    xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`),
    'sitemap-books-paused',
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /3000/);
});

test('rechaza priority y changefreq ficticios reintroducidos en sitemaps', () => {
  const body = xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url>${loc(`${BASE}/libros/literatura`)}<priority>1.0</priority></url></urlset>`);
  const result = analyzeSitemapBody(body, 'sitemap-categories');
  assert.equal(result.ok, false);
  assert.match(result.reason, /priority|changefreq/);
});

test('lastmod exige fecha válida y queda limitado a páginas con revisión fiable', () => {
  const invalidDate = xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url>${loc(`${BASE}/`)}<lastmod>2026-02-31</lastmod></url></urlset>`);
  const categoryDate = xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url>${loc(`${BASE}/libros/literatura`)}<lastmod>2026-08-12</lastmod></url></urlset>`);

  assert.match(analyzeSitemapBody(invalidDate, 'sitemap-pages').reason, /invalid lastmod/);
  assert.match(analyzeSitemapBody(categoryDate, 'sitemap-categories').reason, /reliable static-page revision/);
});
