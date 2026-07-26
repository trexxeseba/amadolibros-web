import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog } from '../meli-catalog.js';

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
