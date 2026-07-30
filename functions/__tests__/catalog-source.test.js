import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_URL,
  PREVIEW_CATALOG_URL,
  catalogUrlFor,
  fetchCatalog,
} from '../_shared/catalog.js';

test('elige catálogo separado solamente con APP_ENV=preview', () => {
  assert.equal(catalogUrlFor({ env: { APP_ENV: 'preview' } }), PREVIEW_CATALOG_URL);
  assert.equal(catalogUrlFor({ env: { APP_ENV: 'production' } }), CATALOG_URL);
  assert.equal(catalogUrlFor({ env: {} }), CATALOG_URL);
  assert.equal(catalogUrlFor({}), CATALOG_URL);
});

test('la caché de Preview no comparte la clave del catálogo productivo', async () => {
  const cacheKeys = [];
  const originalFetch = globalThis.fetch;
  globalThis.caches = {
    default: {
      async match(request) {
        cacheKeys.push(request.url);
        return null;
      },
      async put() {},
    },
  };
  globalThis.fetch = async url => {
    assert.equal(url, PREVIEW_CATALOG_URL);
    return Response.json({ total: 1, items: [{ id: 'MLU2' }] });
  };

  try {
    const result = await fetchCatalog({
      env: { APP_ENV: 'preview' },
      waitUntil() {},
    });
    assert.equal(result.total, 1);
    assert.deepEqual(cacheKeys, [PREVIEW_CATALOG_URL]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
