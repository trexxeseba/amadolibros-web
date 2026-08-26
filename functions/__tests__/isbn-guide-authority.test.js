import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FOOTER_LINKS } from '../_shared/brand.js';
import { STATIC_SITEMAP_PAGES } from '../sitemap-pages.xml.js';

const root = (rel) => fileURLToPath(new URL('../../' + rel, import.meta.url));
const read = (rel) => readFileSync(root(rel), 'utf8');
const page = read('astro-front/src/pages/como-identificar-edicion-correcta-isbn.astro');

test('la guía responde de forma directa y distingue obra, edición y formato', () => {
  assert.match(page, /forma más segura.*comparar el ISBN completo/is);
  assert.match(page, /si dos ejemplares tienen distinto ISBN/i);
  assert.match(page, /ISBN de 10 dígitos/i);
  assert.match(page, /Reimpresión sin cambios sustanciales/);
  assert.match(page, /Cambio de precio/);
});

test('la guía identifica revisión, fecha y fuentes oficiales visibles', () => {
  assert.match(page, /revisado por el equipo de Amado Libros/i);
  assert.match(page, /12 de agosto de 2026/);
  assert.match(page, /https:\/\/www\.bibna\.gub\.uy\/isbn\//);
  assert.match(page, /https:\/\/www\.isbn-international\.org\//);
});

test('el schema Article declara autor, revisión, fechas y breadcrumb', () => {
  assert.match(page, /'@type': 'Article'/);
  assert.match(page, /datePublished: '2026-08-12'/);
  assert.match(page, /dateModified: '2026-08-12'/);
  assert.match(page, /reviewedBy/);
  assert.match(page, /'@type': 'BreadcrumbList'/);
});

test('la guía convierte y es descubrible desde el sitio completo', () => {
  const path = '/como-identificar-edicion-correcta-isbn';
  assert.match(page, /\/pedir-libro\/\?tipo=exacto/);
  assert.match(page, /whatsappHref\(buildWhatsAppMessage/);
  assert.match(page, /motive: 'Verificar la edición correcta de un libro'/);
  assert.ok(FOOTER_LINKS.some(link => link.href === `${path}/`));
  assert.ok(STATIC_SITEMAP_PAGES.includes(`https://www.amadolibros.com${path}/`));
  assert.match(read('astro-front/src/pages/quienes-somos.astro'), new RegExp(path));
  assert.match(read('functions/libros-agotados-importados-uruguay.js'), new RegExp(path));
});
