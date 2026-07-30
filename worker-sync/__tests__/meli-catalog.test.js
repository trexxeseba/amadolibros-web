import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog } from '../meli-catalog.js';
import {
  STOCK1_PREVIEW_CATALOG_KEY,
  runMeasure,
  runPreviewCatalogPublish,
  summarizeCatalog,
} from '../index.js';

test('sincroniza activos y pausados, y conserva la guarda sobre disponibles', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];

  globalThis.fetch = async url => {
    urls.push(String(url));

    if (String(url).includes('/items/search')) {
      const status = new URL(String(url)).searchParams.get('status');
      return Response.json({
        results: status === 'active' ? ['MLU1'] : ['MLU2'],
        scroll_id: null,
      });
    }

    return Response.json([
      {
        code: 200,
        body: {
          id: 'MLU1', title: 'Disponible', price: 1000, status: 'active',
          available_quantity: 2, attributes: [], pictures: [],
        },
      },
      {
        code: 200,
        body: {
          id: 'MLU2', title: 'Por encargo', price: 900, status: 'paused',
          available_quantity: 0, attributes: [], pictures: [],
        },
      },
    ]);
  };

  try {
    const catalog = await buildCatalog({ USER_ID: '123', MIN_ACTIVE_ITEMS: '1' }, 'token');

    assert.equal(catalog.total, 2);
    assert.equal(catalog.active_total, 1);
    assert.equal(catalog.order_total, 1);
    assert.deepEqual(catalog.items.map(item => item.status), ['active', 'paused']);
    assert.ok(urls.some(url => url.includes('status=active')));
    assert.ok(urls.some(url => url.includes('status=paused')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('aborta si faltan disponibles aunque existan publicaciones pausadas', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async url => {
    if (String(url).includes('/items/search')) {
      const status = new URL(String(url)).searchParams.get('status');
      return Response.json({
        results: status === 'paused' ? ['MLU2'] : [],
        scroll_id: null,
      });
    }

    return Response.json([{
      code: 200,
      body: {
        id: 'MLU2', title: 'Pausado', price: 900, status: 'paused',
        available_quantity: 0, attributes: [], pictures: [],
      },
    }]);
  };

  try {
    await assert.rejects(
      buildCatalog({ USER_ID: '123', MIN_ACTIVE_ITEMS: '1' }, 'token'),
      /Solo 0 items activos/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('measure resume activos y pausados sin publicar', async () => {
  const catalog = {
    items: [
      { id: 'MLU1', title: 'Activo', status: 'active', available_quantity: 2 },
      { id: 'MLU2', title: 'Pausado', status: 'paused', available_quantity: 0 },
      { id: 'MLU3', title: 'Sin stock', status: 'active', available_quantity: 0 },
      { id: 'MLU2', title: 'Duplicado', status: 'paused', available_quantity: 0 },
      { id: '', title: '', status: 'broken', available_quantity: 0 },
    ],
  };
  const summary = summarizeCatalog(catalog);
  assert.equal(summary.total, 5);
  assert.equal(summary.active, 1);
  assert.equal(summary.paused, 2);
  assert.equal(summary.active_without_stock, 1);
  assert.equal(summary.duplicate_ids, 1);
  assert.equal(summary.invalid, 1);
  assert.ok(summary.bytes > 0);

  let authCalls = 0;
  let buildCalls = 0;
  const result = await runMeasure(
    { USER_ID: '123' },
    {
      getAccessTokenFn: async () => { authCalls++; return 'token'; },
      buildCatalogFn: async (_env, token) => {
        buildCalls++;
        assert.equal(token, 'token');
        return catalog;
      },
    }
  );

  assert.equal(result.status, 'measured');
  assert.equal(result.published, false);
  assert.equal(result.catalog.paused, 2);
  assert.equal(result.catalog.duplicate_ids, 1);
  assert.equal(result.catalog.invalid, 1);
  assert.equal(authCalls, 1);
  assert.equal(buildCalls, 1);
});

test('publica únicamente la clave fija del catálogo STOCK-1 Preview', async () => {
  const writes = [];
  const catalog = {
    total: 2,
    updated_at: '2026-07-30T12:00:00.000Z',
    items: [
      { id: 'MLU1', title: 'Activo', status: 'active', available_quantity: 2 },
      { id: 'MLU2', title: 'Pausado', status: 'paused', available_quantity: 0 },
    ],
  };
  const env = {
    STOCK1_PREVIEW_PUBLISH_ENABLED: true,
    CATALOG_R2: {
      async put(key, body, options) {
        writes.push({ key, body, options });
      },
    },
  };

  const result = await runPreviewCatalogPublish(env, {
    getAccessTokenFn: async () => 'token',
    buildCatalogFn: async () => catalog,
  });

  assert.equal(result.status, 'published-preview');
  assert.equal(result.published, true);
  assert.equal(result.production_catalog_modified, false);
  assert.equal(result.key, STOCK1_PREVIEW_CATALOG_KEY);
  assert.deepEqual(result.sample_paused, { id: 'MLU2', title: 'Pausado' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, 'catalog-stock1-preview.json');
  assert.notEqual(writes[0].key, 'catalog.json');
  assert.deepEqual(JSON.parse(writes[0].body), catalog);
  assert.equal(writes[0].options.customMetadata.scope, 'stock-1-preview-only');
});

test('bloquea publicación Preview cuando la versión aislada no la habilita', async () => {
  let wrote = false;
  const result = await runPreviewCatalogPublish({
    CATALOG_R2: { async put() { wrote = true; } },
  });

  assert.equal(result.status, 'error');
  assert.equal(result.published, false);
  assert.equal(wrote, false);
});
