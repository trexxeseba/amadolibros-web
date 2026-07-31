import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../cf-r2-1.js';

const PREVIEW_URL = 'https://agent-stock-1-preview.amadolibros-web.pages.dev/api/cf-r2-1';
const MANIFEST = {
  current: {
    version: 'v1',
    active_index_gzip_key: 'stock1-preview/versions/v1/active-index.json.gz',
  },
};
const GZIP_BYTES = new Uint8Array([1, 2, 3, 4, 5]);

function ctxFor(query, env = {}) {
  return {
    request: new Request(`${PREVIEW_URL}?${query}`),
    env: { APP_ENV: 'preview', ...env },
    data: {},
  };
}

function withMockFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => { globalThis.fetch = original; });
}

test('CF-R2-1 no existe fuera de Preview', async () => {
  const response = await onRequest({
    request: new Request('https://www.amadolibros.com/api/cf-r2-1?variant=r2dev'),
    env: { APP_ENV: 'production' },
  });
  assert.equal(response.status, 404);
});

test('CF-R2-1 exige método GET', async () => {
  const response = await onRequest({
    request: new Request(`${PREVIEW_URL}?variant=r2dev`, { method: 'POST' }),
    env: { APP_ENV: 'preview' },
  });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'GET');
});

test('CF-R2-1 rechaza variant inválida', async () => {
  const response = await onRequest(ctxFor('variant=ftp'));
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.deepEqual(data.valid, ['r2dev', 'binding', 'customdomain']);
});

test('CF-R2-1 ?variant=variants reporta qué está configurado, sin leer nada', async () => {
  await withMockFetch(
    async () => { throw new Error('no debería llamarse a fetch para este modo'); },
    async () => {
      const response = await onRequest(ctxFor('variant=variants'));
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.deepEqual(data.variants, ['r2dev', 'binding', 'customdomain']);
      assert.equal(data.binding_configured, false);
      assert.equal(data.custom_domain_configured, false);
    },
  );
});

test('CF-R2-1 variant=r2dev lee el índice activo directo del origen, sin caches.default', async () => {
  let cacheTouched = false;
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => { cacheTouched = true; }, put: async () => { cacheTouched = true; } } };
  try {
    await withMockFetch(async url => {
      const href = String(url);
      if (href.includes('manifest.json')) return new Response(JSON.stringify(MANIFEST), { status: 200 });
      if (href.includes('active-index.json.gz')) {
        return new Response(GZIP_BYTES, { status: 200, headers: { 'cf-ray': 'abc123-EZE' } });
      }
      throw new Error('URL inesperada: ' + href);
    }, async () => {
      const response = await onRequest(ctxFor('variant=r2dev'));
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.ok, true);
      assert.equal(data.variant, 'r2dev');
      assert.equal(data.bytes, GZIP_BYTES.byteLength);
      assert.equal(data.upstream_cf_ray, 'abc123-EZE');
      assert.match(response.headers.get('Server-Timing'), /active_index_gzip_read_origin;dur=/);
      assert.match(response.headers.get('Server-Timing'), /active_index_gzip_read_body;dur=/);
    });
  } finally {
    globalThis.caches = originalCaches;
  }
  assert.equal(cacheTouched, false, 'CF-R2-1 nunca debe tocar caches.default');
});

test('CF-R2-1 variant=binding usa env.CATALOG_BUCKET.get y nunca hace fetch al bucket', async () => {
  let bindingCalledWith = null;
  const bucket = {
    async get(key) {
      bindingCalledWith = key;
      return { arrayBuffer: async () => GZIP_BYTES.buffer };
    },
  };
  await withMockFetch(async url => {
    const href = String(url);
    if (href.includes('manifest.json')) return new Response(JSON.stringify(MANIFEST), { status: 200 });
    throw new Error('variant=binding no debería hacer fetch del objeto: ' + href);
  }, async () => {
    const response = await onRequest(ctxFor('variant=binding', { CATALOG_BUCKET: bucket }));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.equal(data.variant, 'binding');
    assert.equal(bindingCalledWith, MANIFEST.current.active_index_gzip_key);
  });
});

test('CF-R2-1 variant=binding sin binding configurado devuelve 502 binding_missing', async () => {
  await withMockFetch(async () => new Response(JSON.stringify(MANIFEST), { status: 200 }), async () => {
    const response = await onRequest(ctxFor('variant=binding'));
    assert.equal(response.status, 502);
    const data = await response.json();
    assert.equal(data.ok, false);
    assert.equal(data.error, 'binding_missing');
  });
});

test('CF-R2-1 variant=customdomain sin R2_CUSTOM_DOMAIN configurado devuelve 502 sin inventar una URL', async () => {
  await withMockFetch(async () => new Response(JSON.stringify(MANIFEST), { status: 200 }), async () => {
    const response = await onRequest(ctxFor('variant=customdomain'));
    assert.equal(response.status, 502);
    const data = await response.json();
    assert.equal(data.ok, false);
    assert.equal(data.error, 'custom_domain_not_configured');
  });
});

test('CF-R2-1 variant=customdomain usa el dominio propio cuando está configurado', async () => {
  const calledUrls = [];
  await withMockFetch(async url => {
    const href = String(url);
    calledUrls.push(href);
    if (href.includes('manifest.json')) return new Response(JSON.stringify(MANIFEST), { status: 200 });
    if (href.startsWith('https://cdn.amadolibros.com/')) {
      return new Response(GZIP_BYTES, { status: 200, headers: { 'cf-ray': 'def456-EZE' } });
    }
    throw new Error('URL inesperada: ' + href);
  }, async () => {
    const response = await onRequest(ctxFor('variant=customdomain', { R2_CUSTOM_DOMAIN: 'cdn.amadolibros.com' }));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.equal(data.variant, 'customdomain');
  });
  assert.ok(calledUrls.some(u => u.startsWith('https://cdn.amadolibros.com/stock1-preview/versions/v1/active-index.json.gz')));
});

test('CF-R2-1 manifest inaccesible devuelve 503 sin intentar leer el índice', async () => {
  await withMockFetch(async () => new Response('err', { status: 500 }), async () => {
    const response = await onRequest(ctxFor('variant=r2dev'));
    assert.equal(response.status, 503);
  });
});

test('CF-R2-1 manifest sin descriptor gzip activo válido devuelve 503', async () => {
  await withMockFetch(async () => new Response(JSON.stringify({ current: {} }), { status: 200 }), async () => {
    const response = await onRequest(ctxFor('variant=r2dev'));
    assert.equal(response.status, 503);
  });
});

test('CF-R2-1 respuestas siempre Cache-Control: no-store', async () => {
  await withMockFetch(async () => new Response('err', { status: 500 }), async () => {
    const response = await onRequest(ctxFor('variant=r2dev'));
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  });
});
