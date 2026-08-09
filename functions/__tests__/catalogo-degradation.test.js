import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as catalogRequest } from '../catalogo.js';
import { CATALOG_URL, PRODUCTION_MANIFEST_URL, R2_BASE } from '../_shared/catalog.js';

const CATEGORY_DATA = { categories: [], items: {} };
const DESCRIPTOR = {
  version: 'v1',
  index_key: 'catalog/versions/v1/index.json',
  active_index_key: 'catalog/versions/v1/active-index.json',
  block_prefix: 'catalog/versions/v1',
  block_count: 128,
};

function context(url = 'https://www.amadolibros.com/catalogo') {
  return {
    request: new Request(url),
    params: {},
    env: { APP_ENV: 'production' },
    data: {},
    waitUntil() {},
  };
}

function installCache(map) {
  globalThis.caches = {
    default: {
      async match(request) {
        const value = map.get(request.url);
        return value ? value.clone() : null;
      },
      async put() {},
    },
  };
}

test('A3: /catalogo limpio devuelve 503 si catalog.json está temporalmente inaccesible', async () => {
  const originalFetch = globalThis.fetch;
  installCache(new Map([
    ['https://www.amadolibros.com/data/active-categories.json', Response.json(CATEGORY_DATA)],
    [PRODUCTION_MANIFEST_URL, Response.json({ schema_version: 0 })],
  ]));
  globalThis.fetch = async url => {
    if (String(url) === CATALOG_URL) return new Response('R2 unavailable', { status: 503 });
    return new Response('not found', { status: 404 });
  };
  try {
    const response = await catalogRequest(context());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const html = await response.text();
    assert.match(html, /Catálogo temporalmente no disponible/i);
    assert.doesNotMatch(html, /0 resultados/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('A3: un catálogo válido realmente vacío sigue siendo 200, no 503', async () => {
  installCache(new Map([
    ['https://www.amadolibros.com/data/active-categories.json', Response.json(CATEGORY_DATA)],
    [PRODUCTION_MANIFEST_URL, Response.json({ schema_version: 0 })],
    [CATALOG_URL, Response.json({ total: 0, items: [] })],
  ]));
  const response = await catalogRequest(context());
  assert.equal(response.status, 200);
});

test('A3: búsqueda compacta con índice activo válido no depende de catalog.json', async () => {
  const originalFetch = globalThis.fetch;
  const activeUrl = `${R2_BASE}/${DESCRIPTOR.active_index_key}`;
  const pausedUrl = `${R2_BASE}/${DESCRIPTOR.index_key}`;
  installCache(new Map([
    ['https://www.amadolibros.com/data/active-categories.json', Response.json(CATEGORY_DATA)],
    [PRODUCTION_MANIFEST_URL, Response.json({ schema_version: 1, current: DESCRIPTOR, previous: null })],
    [activeUrl, Response.json({
      schema_version: 1,
      fields: ['id', 'title', 'author', 'isbn', 'image', 'price', 'available_quantity'],
      derived_fields: { slug: 'slugify-v1', status: 'active' },
      items: [['MLU1', 'Tarot de prueba', 'Autora', '', '', 1200, 1]],
    })],
    [pausedUrl, Response.json({
      schema_version: 1,
      fields: ['id', 'title', 'author', 'isbn', 'image'],
      derived_fields: { slug: 'slugify-v1', status: 'paused', block: 'numeric-id-mod-block-count' },
      block_count: 128,
      items: [],
    })],
  ]));
  globalThis.fetch = async url => {
    if (String(url) === CATALOG_URL) throw new Error('catalog.json no debe pedirse');
    return new Response('not found', { status: 404 });
  };
  try {
    const response = await catalogRequest(context('https://www.amadolibros.com/catalogo?q=tarot'));
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Tarot de prueba/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
