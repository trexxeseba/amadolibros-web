import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest, __test } from '../perf-verify.js';

test('PERF-VERIFY-1 firma sesiones cortas, ligadas a IP y con vencimiento', async () => {
  const token = await __test.createSession('secret', '203.0.113.7', 1_000_000);
  assert.equal(await __test.validSession(token, 'secret', '203.0.113.7', 1_000_000), true);
  assert.equal(await __test.validSession(token, 'secret', '203.0.113.8', 1_000_000), false);
  assert.equal(await __test.validSession(token, 'wrong', '203.0.113.7', 1_000_000), false);
  assert.equal(await __test.validSession(token, 'secret', '203.0.113.7', 2_801_000), false);
});

test('PERF-VERIFY-1 resuelve únicamente claves exactas del descriptor actual', () => {
  const keys = __test.manifestCacheKeys({
    current: {
      active_index_gzip_key: 'stock1-preview/versions/v1/active-index.json.gz',
      index_gzip_key: 'stock1-preview/versions/v1/index.json.gz',
      active_index_key: 'stock1-preview/versions/v1/active-index.json',
      index_key: 'stock1-preview/versions/v1/index.json',
    },
  });
  assert.equal(keys.length, 3);
  assert.equal(keys[0], 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/stock1-preview/manifest.json');
  assert.equal(keys.every(key => key.startsWith('https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/')), true);
});

test('PERF-VERIFY-1 no existe fuera de Preview', async () => {
  const response = await onRequest({
    request: new Request('https://www.amadolibros.com/api/perf-verify'),
    env: {
      APP_ENV: 'production',
      TURNSTILE_SECRET_KEY: 'secret',
      STOCK_WAITLIST_TURNSTILE_SITE_KEY: 'site',
    },
  });
  assert.equal(response.status, 404);
});

test('PERF-VERIFY-1 GET en Preview exige configuración y renderiza Turnstile', async () => {
  const base = {
    request: new Request('https://agent-stock-1-preview.amadolibros-web.pages.dev/api/perf-verify'),
    env: { APP_ENV: 'preview' },
  };
  assert.equal((await onRequest(base)).status, 503);

  const response = await onRequest({
    ...base,
    env: {
      APP_ENV: 'preview',
      TURNSTILE_SECRET_KEY: 'secret',
      STOCK_WAITLIST_TURNSTILE_SITE_KEY: 'site-key',
    },
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /data-action="perf_verify"/);
  assert.match(html, /20 repeticiones/);
});
