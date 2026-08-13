import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { onRequest as redirectPsychology } from '../libros-psicologia.js';

const root = (rel) => fileURLToPath(new URL('../../' + rel, import.meta.url));
const read = (rel) => readFileSync(root(rel), 'utf8');

test('la entidad conecta el sitio con sus perfiles verificables', () => {
  const home = read('astro-front/src/pages/index.astro');
  const about = read('astro-front/src/pages/quienes-somos.astro');
  for (const page of [home, about]) {
    assert.match(page, /mercadolibre\.com\.uy\/tienda\/amado-libros-libreria-en-linea/);
    assert.match(page, /instagram\.com\/amadolibros\.uy/);
  }
});

test('WebSite declara la búsqueda interna real del catálogo', () => {
  const home = read('astro-front/src/pages/index.astro');
  assert.match(home, /'@type': 'SearchAction'/);
  assert.match(home, /catalogo\?q=\{search_term_string\}/);
  assert.doesNotMatch(home, /urlTemplate: 'https:\/\/www\.amadolibros\.com\/\?q=/);
});

test('/libros-psicologia redirige a la landing canónica', async () => {
  const response = await redirectPsychology();
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), 'https://www.amadolibros.com/especialidades/psicologia');
});
