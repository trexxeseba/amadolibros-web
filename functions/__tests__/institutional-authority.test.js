import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FOOTER_LINKS } from '../_shared/brand.js';
import { STATIC_SITEMAP_PAGES } from '../sitemap-pages.xml.js';

const root = (rel) => fileURLToPath(new URL('../../' + rel, import.meta.url));
const read = (rel) => readFileSync(root(rel), 'utf8');
const page = read('astro-front/src/pages/quienes-somos.astro');

test('la página institucional publica identidad, método y responsable visibles', () => {
  assert.match(page, /librería online uruguaya, familiar y atendida por sus dueños/i);
  assert.match(page, /Cómo verificamos un libro/);
  assert.match(page, /ISBN/);
  assert.match(page, /revisada por el equipo de Amado Libros/);
  assert.match(page, /12 de agosto de 2026/);
});

test('la identidad estructurada conecta OnlineStore, WebSite y AboutPage', () => {
  assert.match(page, /'@type': 'OnlineStore'/);
  assert.match(page, /'@type': 'WebSite'/);
  assert.match(page, /'@type': 'AboutPage'/);
  assert.match(page, /reviewedBy/);
  assert.match(page, /Rincón 608/);
  assert.match(page, /sameAs:/);
  assert.match(page, /https:\/\/www\.mercadolibre\.com\.uy\/tienda\/amado-libros-libreria-en-linea/);
  assert.match(page, /https:\/\/www\.instagram\.com\/amadolibros\.uy\//);
});

test('la página es descubrible desde el footer global y el sitemap', () => {
  assert.ok(FOOTER_LINKS.some(link => link.href === '/quienes-somos'));
  assert.ok(STATIC_SITEMAP_PAGES.includes('https://www.amadolibros.com/quienes-somos'));
});
