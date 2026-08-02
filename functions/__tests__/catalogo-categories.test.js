// CF-CATEGORÍAS-2 — filtro de categoría en /catalogo, exclusivo de Preview.
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as catalogRequest } from '../catalogo.js';
import { CATALOG_URL, PAUSED_MANIFEST_URL, PRODUCTION_MANIFEST_URL } from '../_shared/catalog.js';

const CATALOG = {
  total: 3,
  items: [
    {
      id: 'MLU1', title: 'El Género En Disputa', author: 'Judith Butler',
      isbn: '1', price: 1000, status: 'active', available_quantity: 2,
      thumbnail: '', pictures: [], permalink: 'https://x/MLU1',
    },
    {
      id: 'MLU2', title: 'Tarot De Los Ángeles', author: 'Doreen Virtue',
      isbn: '2', price: 900, status: 'active', available_quantity: 1,
      thumbnail: '', pictures: [], permalink: 'https://x/MLU2',
    },
    {
      id: 'MLU3', title: 'Sin categoría conocida', author: 'Nadie Reconocido',
      isbn: '3', price: 500, status: 'active', available_quantity: 1,
      thumbnail: '', pictures: [], permalink: 'https://x/MLU3',
    },
  ],
};

const ACTIVE_CATEGORIES = {
  generated_at: '2026-08-02T00:00:00.000Z',
  taxonomy_version: 1,
  rules_version: 3,
  categories: [
    { id: 'filosofia-ciencias-sociales', name: 'Filosofía y ciencias sociales' },
    { id: 'esoterismo-tarot', name: 'Esoterismo y tarot' },
  ],
  counts: { 'filosofia-ciencias-sociales': 1, 'esoterismo-tarot': 1 },
  items: { MLU1: 'filosofia-ciencias-sociales', MLU2: 'esoterismo-tarot' },
};

function context(url, appEnv = 'preview') {
  return {
    request: new Request(url),
    params: {},
    env: { APP_ENV: appEnv },
    waitUntil() {},
  };
}

test.beforeEach(() => {
  globalThis.caches = {
    default: {
      async match(request) {
        if (request.url === CATALOG_URL) return Response.json(CATALOG);
        // Fuerza el fallback a fetchCatalog() (mock de arriba) en vez de
        // pegarle a los índices compactos reales de R2 cuando hay ?q= — este
        // test no necesita el camino "compact search", solo el filtro de
        // categoría sobre datos controlados. manifestUrlFor() usa
        // PAUSED_MANIFEST_URL en Preview y PRODUCTION_MANIFEST_URL en
        // producción — se anulan los dos.
        if (request.url === PAUSED_MANIFEST_URL) return Response.json({ current: null, previous: null });
        if (request.url === PRODUCTION_MANIFEST_URL) return Response.json({ current: null, previous: null });
        if (request.url.endsWith('/data/active-categories.json')) {
          return Response.json(ACTIVE_CATEGORIES);
        }
        return null;
      },
      async put() {},
    },
  };
});

test('categoría válida filtra solo esa categoría', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?categoria=esoterismo-tarot'));
  const html = await res.text();
  assert.match(html, /Tarot De Los Ángeles/);
  assert.doesNotMatch(html, /El Género En Disputa/);
  assert.doesNotMatch(html, /Sin categoría conocida/);
});

test('categoría inválida vuelve a "Todos los libros" (sin filtrar, sin error)', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?categoria=no-existe'));
  assert.equal(res.status, 200);
  const html = await res.text();
  // Sin filtro válido y sin q, cae en el índice SEO completo (los 3 títulos).
  assert.match(html, /El Género En Disputa/);
  assert.match(html, /Tarot De Los Ángeles/);
  assert.match(html, /Sin categoría conocida/);
});

test('búsqueda + categoría se combinan (AND, no OR)', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=tarot&categoria=esoterismo-tarot'));
  const html = await res.text();
  assert.match(html, /Tarot De Los Ángeles/);
  assert.doesNotMatch(html, /El Género En Disputa/);
});

test('búsqueda que no matchea la categoría elegida da cero resultados, no ignora la categoría', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=genero&categoria=esoterismo-tarot'));
  const html = await res.text();
  assert.doesNotMatch(html, /El Género En Disputa/);
  assert.match(html, /No encontramos resultados/);
});

test('el selector conserva q al elegir categoría (value del input persiste)', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=tarot&categoria=esoterismo-tarot'));
  const html = await res.text();
  assert.match(html, /value="tarot"/);
  assert.match(html, /<option value="esoterismo-tarot" selected>/);
});

test('el selector conserva categoria al buscar (option queda seleccionada)', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?categoria=filosofia-ciencias-sociales'));
  const html = await res.text();
  assert.match(html, /<option value="filosofia-ciencias-sociales" selected>/);
});

test('catálogo sin ningún filtro muestra "Todos los libros" seleccionado y todos los títulos', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo'));
  const html = await res.text();
  assert.match(html, /<option value=""\s*selected>Todos los libros<\/option>/);
  assert.match(html, /El Género En Disputa/);
  assert.match(html, /Tarot De Los Ángeles/);
  assert.match(html, /Sin categoría conocida/);
});

test('solo aparecen en el selector categorías con libros activos (no las 18 completas)', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo'));
  const html = await res.text();
  assert.match(html, /Filosofía y ciencias sociales/);
  assert.match(html, /Esoterismo y tarot/);
  assert.doesNotMatch(html, /Cocina y gastronomía/);
});

test('fuera de Preview (producción), el parámetro categoría se ignora por completo', async () => {
  const res = await catalogRequest(context('https://www.amadolibros.com/catalogo?categoria=esoterismo-tarot', 'production'));
  const html = await res.text();
  // Sin selector de categoría (el <select> real, no solo la clase CSS
  // presente pero inerte), y sin filtrar — el catálogo productivo no cambia.
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /El Género En Disputa/);
  assert.match(html, /Tarot De Los Ángeles/);
});

test('muestra cantidad de resultados', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?categoria=esoterismo-tarot'));
  const html = await res.text();
  assert.match(html, /1 resultado\./);
});
