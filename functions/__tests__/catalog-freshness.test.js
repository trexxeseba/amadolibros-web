import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCatalog, CATALOG_URL } from '../_shared/catalog.js';

test('abandona la copia horaria previa, conserva la fuente y limita la nueva copia a 60 segundos', async () => {
  const previousFetch = globalThis.fetch;
  const previousCaches = globalThis.caches;
  const stale = { updated_at: '2026-09-09T07:18:15.824Z', items: [{ id: 'MLU1', price: 1599 }, { id: 'MLU2' }] };
  const fresh = { updated_at: '2026-09-09T14:29:29.348Z', items: [{ id: 'MLU1', price: 1543 }] };
  const cache = new Map([[CATALOG_URL, Response.json(stale, { headers: { 'cache-control': 'public, max-age=3600' } })]]);
  const writes = [];
  const requests = [];
  globalThis.caches = { default: {
    async match(key) { return cache.get(key.url)?.clone() || null; },
    async put(key, response) { writes.push([key.url, response.headers.get('cache-control')]); cache.set(key.url, response.clone()); },
  } };
  globalThis.fetch = async url => { requests.push(url); return Response.json(fresh); };
  try {
    const pending = [];
    const ctx = { env: { APP_ENV: 'production' }, waitUntil(p) { pending.push(p); } };
    assert.deepEqual(await fetchCatalog(ctx), fresh);
    await Promise.all(pending);
    assert.deepEqual(requests, [CATALOG_URL]);
    assert.equal(writes[0][1], 'public, max-age=60');
    assert.equal(writes[0][0], CATALOG_URL);
    assert.deepEqual(await fetchCatalog(ctx), fresh);
    assert.equal(requests.length, 1, 'la nueva copia sigue evitando descargas repetidas');
    assert.deepEqual(await cache.get(CATALOG_URL).json(), fresh, 'la copia sustituida coincide con la fuente');
  } finally { globalThis.fetch = previousFetch; globalThis.caches = previousCaches; }
});
