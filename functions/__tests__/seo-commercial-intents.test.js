import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { onRequest } from '../libros-agotados-importados-uruguay.js';

const root = rel => fileURLToPath(new URL('../../' + rel, import.meta.url));
const read = rel => readFileSync(root(rel), 'utf8');

test('landing de agotados e importados es indexable, canónica y accionable', async () => {
  const response = await onRequest();
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /text\/html/);
  assert.match(html, /<title>Libros agotados e importados en Uruguay \| Amado Libros<\/title>/);
  assert.match(html, /<meta name="robots" content="index, follow">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.amadolibros\.com\/libros-agotados-importados-uruguay">/);
  assert.match(html, /<h1>Conseguimos libros agotados, importados y difíciles de encontrar<\/h1>/);
  assert.match(html, /título, autor, ISBN o foto/);
  assert.match(html, /Europa y otros mercados/);
  assert.match(html, /Pedir búsqueda por WhatsApp/);
  assert.match(html, /"@type":"Service"/);
  assert.match(html, /disponibilidad real/);
  assert.match(html, /<meta property="og:image" content="https:\/\/www\.amadolibros\.com\/images\/logo-amado\.webp">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
});

test('home posiciona libros importados y búsqueda humana por encargo', () => {
  const home = read('astro-front/src/pages/index.astro');
  const hero = read('astro-front/src/components/Hero.astro');
  const footer = read('astro-front/src/components/Footer.astro');

  assert.match(home, /title="Amado Libros \| Libros importados y difíciles de encontrar"/);
  assert.match(home, /Buscá libros importados disponibles en Uruguay/);
  assert.match(home, /la buscamos personalmente por encargo/);
  assert.match(hero, /Libros difíciles de encontrar\./);
  assert.match(hero, /una persona de Amado Libros revisa opciones/);
  assert.match(hero, /agotado o descatalogado/);
  assert.match(footer, /href="\/libros-agotados-importados-uruguay"/);
});
