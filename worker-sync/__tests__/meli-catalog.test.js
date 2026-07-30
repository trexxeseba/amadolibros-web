import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog } from '../meli-catalog.js';
import { runMeasure, summarizeCatalog } from '../index.js';

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
