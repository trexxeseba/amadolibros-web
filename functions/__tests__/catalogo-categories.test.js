// CF-CATEGORÍAS-2C — filtro de categoría/subcategoría + orden por relevancia
// en /catalogo, exclusivo de Preview.
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as catalogRequest } from '../catalogo.js';
import { CATALOG_URL, PAUSED_MANIFEST_URL, PRODUCTION_MANIFEST_URL } from '../_shared/catalog.js';

const CATALOG = {
  total: 5,
  items: [
    {
      id: 'MLU1', title: 'El Género En Disputa', author: 'Judith Butler',
      isbn: '9780415924993', price: 1000, status: 'active', available_quantity: 2,
      thumbnail: '', pictures: [], permalink: 'https://x/MLU1',
    },
    {
      id: 'MLU2', title: 'Tarot De Los Ángeles', author: 'Doreen Virtue',
      isbn: '2', price: 900, status: 'active', available_quantity: 1,
      thumbnail: '', pictures: [], permalink: 'https://x/MLU2',
    },
    {
      id: 'MLU3', title: 'Tarot Egipcio Oráculo Clásico', author: 'Autora Desconocida',
      isbn: '3', price: 800, status: 'active', available_quantity: 1,
      thumbnail: '', pictures: [], permalink: 'https://x/MLU3',
    },
    {
      id: 'MLU4', title: 'Sin categoría conocida', author: 'Nadie Reconocido',
      isbn: '4', price: 500, status: 'active', available_quantity: 1,
      thumbnail: '', pictures: [], permalink: 'https://x/MLU4',
    },
    {
      id: 'MLU5', title: 'Vinilo The Beatles Abbey Road', author: '',
      isbn: '5', price: 700, status: 'active', available_quantity: 1,
      thumbnail: '', pictures: [], permalink: 'https://x/MLU5',
    },
  ],
};

const ACTIVE_CATEGORIES = {
  generated_at: '2026-08-02T00:00:00.000Z',
  taxonomy_version: 2,
  rules_version: 5,
  categories: [
    { id: 'filosofia-ciencias-sociales', name: 'Filosofía y ciencias sociales', count: 1, subcategories: [] },
    {
      id: 'esoterismo-tarot', name: 'Esoterismo y tarot', count: 2,
      subcategories: [{ id: 'tarot-oraculos', name: 'Tarot y oráculos', count: 2 }],
    },
    {
      id: 'otros-productos', name: 'Otros productos', count: 1,
      subcategories: [{ id: 'discos-vinilos', name: 'Discos y vinilos', count: 1 }],
    },
  ],
  items: {
    MLU1: ['filosofia-ciencias-sociales'],
    MLU2: ['esoterismo-tarot', 'tarot-oraculos'],
    MLU3: ['esoterismo-tarot', 'tarot-oraculos'],
    MLU5: ['otros-productos', 'discos-vinilos'],
  },
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
        // manifestUrlFor() usa PAUSED_MANIFEST_URL en Preview y
        // PRODUCTION_MANIFEST_URL en producción — se anulan los dos para
        // forzar el fallback a fetchCatalog() (mock de arriba) en vez de
        // pegarle a los índices compactos reales de R2.
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
  assert.match(html, /Tarot Egipcio/);
  assert.doesNotMatch(html, /El Género En Disputa/);
  assert.doesNotMatch(html, /Sin categoría conocida/);
});

test('subcategoría válida filtra dentro de la categoría', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?categoria=esoterismo-tarot&subcategoria=tarot-oraculos'));
  const html = await res.text();
  assert.match(html, /Tarot De Los Ángeles/);
  assert.match(html, /<option value="tarot-oraculos" selected>/);
});

test('subcategoría inválida para la categoría elegida vuelve a "Todas" (no rompe, no excluye todo)', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?categoria=esoterismo-tarot&subcategoria=no-existe'));
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /Tarot De Los Ángeles/);
  assert.match(html, /Tarot Egipcio/);
});

test('subcategoría sin categoría se ignora', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?subcategoria=tarot-oraculos'));
  const html = await res.text();
  // Sin categoria válida, cae en "sin filtro" -> índice completo.
  assert.match(html, /El Género En Disputa/);
});

test('categoría inválida vuelve a "Todos" (sin filtrar, sin error)', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?categoria=no-existe'));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /El Género En Disputa/);
  assert.match(html, /Tarot De Los Ángeles/);
  assert.match(html, /Sin categoría conocida/);
});

test('búsqueda + categoría se combinan (AND, no OR)', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=tarot&categoria=esoterismo-tarot'));
  const html = await res.text();
  assert.match(html, /Tarot De Los Ángeles/);
  assert.match(html, /Tarot Egipcio/);
  assert.doesNotMatch(html, /El Género En Disputa/);
});

test('búsqueda + categoría + subcategoría se combinan', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=tarot&categoria=esoterismo-tarot&subcategoria=tarot-oraculos'));
  const html = await res.text();
  assert.match(html, /Tarot De Los Ángeles/);
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

test('el selector conserva categoria y subcategoria al buscar', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?categoria=esoterismo-tarot&subcategoria=tarot-oraculos'));
  const html = await res.text();
  assert.match(html, /<option value="esoterismo-tarot" selected>/);
  assert.match(html, /<option value="tarot-oraculos" selected>/);
});

test('"Limpiar filtros" aparece con categoría activa y conserva q', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=tarot&categoria=esoterismo-tarot'));
  const html = await res.text();
  assert.match(html, /Limpiar filtros/);
  assert.match(html, /href="\/catalogo\?q=tarot"/);
});

test('"Limpiar filtros" no aparece sin categoría/subcategoría activa', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=tarot'));
  const html = await res.text();
  assert.doesNotMatch(html, /Limpiar filtros/);
});

test('chips muestran los filtros activos claramente', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=tarot&categoria=esoterismo-tarot&subcategoria=tarot-oraculos'));
  const html = await res.text();
  assert.match(html, /class="filter-chip"[^>]*>[^<]*tarot/i);
  assert.match(html, /Esoterismo y tarot/);
  assert.match(html, /Tarot y oráculos/);
});

test('catálogo sin ningún filtro muestra "Todos" seleccionado y todos los títulos incluidos', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo'));
  const html = await res.text();
  assert.match(html, /<option value=""\s*selected>Todos<\/option>/);
  assert.match(html, /El Género En Disputa/);
  assert.match(html, /Tarot De Los Ángeles/);
  assert.match(html, /Sin categoría conocida/);
  assert.match(html, /Vinilo The Beatles/);
});

test('solo aparecen en el selector categorías con libros activos', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo'));
  const html = await res.text();
  assert.match(html, /Filosofía y ciencias sociales/);
  assert.match(html, /Esoterismo y tarot/);
  assert.doesNotMatch(html, /Cocina y gastronomía/);
});

test('objetos (otros-productos) quedan visibles en su categoría, no excluidos', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?categoria=otros-productos'));
  const html = await res.text();
  assert.match(html, /Vinilo The Beatles/);
});

test('fuera de Preview (producción), los parámetros de categoría se ignoran por completo', async () => {
  const res = await catalogRequest(context('https://www.amadolibros.com/catalogo?categoria=esoterismo-tarot', 'production'));
  const html = await res.text();
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /El Género En Disputa/);
  assert.match(html, /Tarot De Los Ángeles/);
});

test('muestra cantidad de resultados', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?categoria=esoterismo-tarot'));
  const html = await res.text();
  assert.match(html, /2 resultados\./);
});

// ── Orden de relevancia (CF-CATEGORÍAS-2C punto 5) ─────────────────────────

test('ISBN exacto aparece primero', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=9780415924993'));
  const html = await res.text();
  const firstCard = html.indexOf('<article class="rc-card');
  assert.ok(firstCard !== -1, 'no se renderizó ninguna card');
  assert.match(html.slice(firstCard, firstCard + 500), /El Género En Disputa/);
});

test('título exacto aparece primero que una coincidencia parcial', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=tarot+de+los+angeles'));
  const html = await res.text();
  const idxExact = html.indexOf('Tarot De Los Ángeles');
  const idxOther = html.indexOf('Tarot Egipcio');
  assert.ok(idxExact !== -1);
  assert.ok(idxOther === -1 || idxExact < idxOther, 'el título exacto debería aparecer antes');
});

test('autor exacto se encuentra y aparece en los resultados', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=judith+butler'));
  const html = await res.text();
  assert.match(html, /El Género En Disputa/);
});

test('normalización de tildes: buscar sin tilde encuentra título con tilde', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=angeles'));
  const html = await res.text();
  assert.match(html, /Tarot De Los Ángeles/);
});

test('tolerancia liviana a errores de tipeo (distancia 1) cuando la búsqueda estricta no encuentra nada', async () => {
  // "angelas" en vez de "angeles" — un solo carácter de diferencia.
  const res = await catalogRequest(context('https://preview.example/catalogo?q=angelas'));
  const html = await res.text();
  assert.match(html, /Tarot De Los Ángeles/);
});

test('sin duplicados: cada MLU aparece una sola vez en la grilla', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?categoria=esoterismo-tarot'));
  const html = await res.text();
  const count = (html.match(/Tarot De Los Ángeles/g) || []).length;
  assert.equal(count, 1);
});

test('regeneración reproducible: misma request da la misma respuesta', async () => {
  const res1 = await catalogRequest(context('https://preview.example/catalogo?categoria=esoterismo-tarot'));
  const html1 = await res1.text();
  const res2 = await catalogRequest(context('https://preview.example/catalogo?categoria=esoterismo-tarot'));
  const html2 = await res2.text();
  assert.equal(html1, html2);
});
