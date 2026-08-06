import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as catalogRequest } from '../catalogo.js';
import { CATALOG_URL, PAUSED_MANIFEST_URL } from '../_shared/catalog.js';

const CATALOG = {
  total: 2,
  items: [
    {
      id: 'MLU1', title: 'Título extraordinariamente largo para comprobar el ancho móvil',
      author: 'Autora Uno', price: 123456, status: 'active', available_quantity: 2,
      thumbnail: '', pictures: [],
    },
    {
      id: 'MLU2', title: 'Segundo libro', author: 'Autor Dos', price: 1500,
      status: 'active', available_quantity: 1, thumbnail: '', pictures: [],
    },
  ],
};

function context() {
  return {
    request: new Request('https://preview.example/catalogo'),
    env: { APP_ENV: 'preview' },
    waitUntil() {},
  };
}

test.beforeEach(() => {
  globalThis.caches = {
    default: {
      async match(request) {
        if (request.url === CATALOG_URL) return Response.json(CATALOG);
        if (request.url === PAUSED_MANIFEST_URL) {
          return Response.json({ schema_version: 1, current: null, previous: null });
        }
        return null;
      },
      async put() {},
    },
  };
});

test('MOBILE-STAB-1: el catálogo usa una columna móvil, dos desde 500 y cuatro desde 900', async () => {
  const html = await (await catalogRequest(context())).text();

  assert.match(html, /\.grid\{display:grid;grid-template-columns:minmax\(0,1fr\);/);
  assert.match(html, /@media\(min-width:500px\)\{\.grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\}/);
  assert.match(html, /@media\(min-width:900px\)\{\.grid\{grid-template-columns:repeat\(4,1fr\)\}\}/);
  assert.doesNotMatch(html, /auto-fill,minmax\(160px,1fr\)/);
});

test('MOBILE-STAB-1: 360, 393 y 412 px quedan cubiertos por la tarjeta horizontal estable', async () => {
  const html = await (await catalogRequest(context())).text();

  assert.match(html, /@media\(max-width:499px\)\{/);
  assert.match(html, /\.rc-card\{display:grid;grid-template-columns:minmax\(108px,34%\) minmax\(0,1fr\)\}/);
  assert.match(html, /\.rc-body\{padding:\.75rem;gap:\.38rem\}/);
  assert.match(html, /html,body\{max-width:100%;overflow-x:hidden\}/);
  assert.match(html, /\.rc-card\{display:flex;flex-direction:column;min-width:0;/);
  assert.match(html, /\.rc-base,\.rc-installment,\.rc-transfer\{line-height:1\.3;overflow-wrap:anywhere\}/);
});

test('MOBILE-STAB-1: buscador, selector y botón son táctiles, de ancho completo y no desbordan', async () => {
  const html = await (await catalogRequest(context())).text();

  assert.match(html, /\.filters-bar input\[type=search\],\.cat-select-wrap select,\.filters-bar button\{\s*min-height:44px/);
  assert.match(html, /\.filters-bar button\{padding:\.55rem 1rem;border-color:#1e293b;background:#1e293b;/);
  assert.match(html, /@media \(max-width: 480px\)\{\s*\.filters-bar\{display:grid;grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(html, /\.filters-bar input\[type=search\],\.cat-select-wrap,\.cat-select-wrap select,\.filters-bar button\{\s*width:100%;min-width:0\}/);
});
