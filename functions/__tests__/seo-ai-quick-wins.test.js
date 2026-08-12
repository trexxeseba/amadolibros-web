import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { onRequest as renderSitemap, STATIC_SITEMAP_ENTRIES } from '../sitemap-pages.xml.js';

const root = (rel) => fileURLToPath(new URL('../../' + rel, import.meta.url));
const read = (rel) => readFileSync(root(rel), 'utf8');

test('la portada identifica a Amado Libros y enlaza las páginas de autoridad', () => {
  const home = read('astro-front/src/pages/index.astro');
  const guides = read('astro-front/src/components/GuideAccess.astro');

  assert.match(home, /'@type': \['Organization', 'BookStore'\]/);
  assert.match(home, /'@type': 'WebSite'/);
  assert.match(home, /jsonLd=\{jsonLd\}/);
  assert.match(home, /<GuideAccess \/>/);
  assert.match(guides, /\/como-identificar-edicion-correcta-isbn/);
  assert.match(guides, /\/libros-agotados-importados-uruguay/);
  assert.match(guides, /\/quienes-somos/);
});

test('el formulario de búsqueda ofrece ayuda contextual antes del envío', () => {
  const page = read('astro-front/src/pages/pedir-libro.astro');
  assert.match(page, /¿Querés verificar los datos antes de enviar\?/);
  assert.match(page, /cómo distinguir una edición por ISBN/i);
  assert.match(page, /cómo funciona un encargo de libro agotado o importado/i);
});

test('la landing de agotados publica respuesta directa, revisión y entidades conectadas', () => {
  const page = read('functions/libros-agotados-importados-uruguay.js');
  assert.match(page, /<strong>Respuesta directa:<\/strong>/);
  assert.match(page, /Contenido revisado el 12 de agosto de 2026/);
  assert.match(page, /'@type': 'WebPage'/);
  assert.match(page, /'@type': 'Service'/);
  assert.match(page, /'@type': 'BreadcrumbList'/);
  assert.match(page, /'reviewedBy'/);
  assert.match(page, /href=\"\/quienes-somos\"/);
});

test('el sitemap declara lastmod sólo para páginas con revisión significativa conocida', async () => {
  const home = STATIC_SITEMAP_ENTRIES.find(entry => entry.loc === 'https://www.amadolibros.com/');
  const guide = STATIC_SITEMAP_ENTRIES.find(entry => entry.loc.endsWith('/como-identificar-edicion-correcta-isbn'));
  const policies = STATIC_SITEMAP_ENTRIES.find(entry => entry.loc.endsWith('/politicas'));

  assert.equal(home?.lastmod, '2026-08-12');
  assert.equal(guide?.lastmod, '2026-08-12');
  assert.equal(policies?.lastmod, undefined);

  const response = await renderSitemap();
  const xml = await response.text();
  assert.match(xml, /<loc>https:\/\/www\.amadolibros\.com\/como-identificar-edicion-correcta-isbn<\/loc>\s*<lastmod>2026-08-12<\/lastmod>/);
  assert.doesNotMatch(xml, /<loc>https:\/\/www\.amadolibros\.com\/politicas<\/loc>\s*<lastmod>/);
});
