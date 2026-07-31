import test from 'node:test';
import assert from 'node:assert/strict';
import { brotliCompressSync } from 'node:zlib';
import { onRequest as middlewareRequest } from '../_middleware.js';
import { onRequestGet as brotliProbeRequest } from '../api/perf-brotli.js';
import {
  ensurePerf,
  perfSummary,
  recordPerf,
  serverTimingValue,
} from '../_shared/perf.js';

test('PERF-BASE registra segmentos sin incluir consultas ni datos personales', () => {
  const ctx = { env: { APP_ENV: 'preview' }, data: {} };
  ensurePerf(ctx);
  recordPerf(ctx, 'active_index_parse', performance.now(), { cache: 'hit' });
  const header = serverTimingValue(ctx, [{ name: 'total', duration_ms: 12.34 }]);
  const summary = perfSummary(ctx, { route: '/catalogo', result_count: 2 });

  assert.match(header, /active_index_parse;dur=/);
  assert.match(header, /total;dur=12.34/);
  assert.equal(summary.cache_hits, 1);
  assert.equal(summary.route, '/catalogo');
  assert.equal(JSON.stringify(summary).includes('q='), false);
  assert.equal(JSON.stringify(summary).includes('email'), false);
});

test('ASSET-CACHE-1 cachea sólo CSS/JS hash de Astro en Preview', async () => {
  const response = await middlewareRequest({
    request: new Request('https://agent-stock-1-preview.amadolibros-web.pages.dev/_astro/index.Abc123xy.css'),
    async next() {
      return new Response('asset');
    },
  });

  assert.equal(
    response.headers.get('cache-control'),
    'public, max-age=31536000, immutable',
  );
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('ASSET-CACHE-1 no aplica caché larga a HTML, API ni assets sin hash', async () => {
  for (const pathname of [
    '/',
    '/catalogo?q=alpha',
    '/api/health',
    '/_astro/index.css',
    '/_astro/manual-name.js',
  ]) {
    const response = await middlewareRequest({
      request: new Request(`https://agent-stock-1-preview.amadolibros-web.pages.dev${pathname}`),
      async next() {
        return new Response('dynamic');
      },
    });
    assert.equal(response.headers.get('cache-control'), 'no-store', pathname);
  }
});

test('ASSET-CACHE-1 aplica la misma regla exacta a assets hash en Producción', async () => {
  const response = await middlewareRequest({
    request: new Request('https://www.amadolibros.com/_astro/app.XyZ987ab.js'),
    async next() {
      return new Response('asset');
    },
  });
  assert.equal(
    response.headers.get('cache-control'),
    'public, max-age=31536000, immutable',
  );
  assert.equal(response.headers.has('x-robots-tag'), false);
});

test('prueba mínima descomprime y parsea un índice Brotli real', async () => {
  const originalFetch = globalThis.fetch;
  const index = {
    schema_version: 1,
    items: Array.from({ length: 200 }, (_, indexNumber) => [
      `MLU${indexNumber}`,
      `Libro real de prueba ${indexNumber}`,
      'Autora',
    ]),
  };
  const compressed = brotliCompressSync(Buffer.from(JSON.stringify(index)));
  globalThis.fetch = async () => new Response(compressed, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream' },
  });

  try {
    const response = await brotliProbeRequest({
      env: { APP_ENV: 'preview' },
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.compatible, true);
    assert.equal(result.format, 'brotli');
    assert.equal(result.iterations, 5);
    assert.equal(result.item_count, 200);
    assert.ok(result.decompressed_bytes > result.compressed_bytes);
    assert.ok(result.decompress.median_ms >= 0);
    assert.ok(result.parse.median_ms >= 0);
    assert.match(response.headers.get('server-timing'), /probe_decompress/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('la prueba Brotli no queda expuesta en Producción', async () => {
  const response = await brotliProbeRequest({
    env: { APP_ENV: 'production' },
  });
  assert.equal(response.status, 404);
});
