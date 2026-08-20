import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchShowcaseCohort,
  isProductInShowcaseCohort,
  LEGACY_SHOWCASE_COHORT_LIMIT,
  normalizeShowcaseCohort,
  resetShowcaseCohortMemoryForTests,
  SHOWCASE_COHORT_LIMIT,
  SHOWCASE_COHORT_V1_URL,
  SHOWCASE_COHORT_V2_URL,
  SHOWCASE_PREVIEW_SAMPLE_IDS,
} from '../_shared/showcase-cohort.js';

function context(appEnv = 'preview') {
  return {
    env: { APP_ENV: appEnv },
    data: {},
    waitUntil() {},
  };
}

function installCache() {
  const writes = [];
  globalThis.caches = {
    default: {
      async match() { return null; },
      async put(key, value) { writes.push({ key, value }); },
    },
  };
  return writes;
}

function payload(schemaVersion, count) {
  const ids = Array.from({ length: count }, (_, index) => `MLU${100000000 + index}`);
  return {
    schema_version: schemaVersion,
    generated_at: '2026-08-20T12:00:00.000Z',
    catalog_version: '2026-08-20T12:00:00.000Z',
    total: ids.length,
    ids,
  };
}

test('acepta v2 con hasta 3000 MLU y v1 con hasta 1000', () => {
  const v2 = normalizeShowcaseCohort(payload(2, 3000));
  const v1 = normalizeShowcaseCohort(payload(1, 1000));

  assert.equal(SHOWCASE_COHORT_LIMIT, 3000);
  assert.equal(LEGACY_SHOWCASE_COHORT_LIMIT, 1000);
  assert.ok(v2);
  assert.equal(v2.total, 3000);
  assert.equal(v2.ids.size, 3000);
  assert.equal(v2.source, 'r2-v2');
  assert.ok(v1);
  assert.equal(v1.total, 1000);
  assert.equal(v1.source, 'r2-v1');
});

test('rechaza versión desconocida, duplicados, IDs inválidos, total cruzado y límites excedidos', () => {
  assert.equal(normalizeShowcaseCohort({
    schema_version: 3,
    total: 1,
    ids: ['MLU1'],
  }), null);
  assert.equal(normalizeShowcaseCohort({
    schema_version: 2,
    total: 2,
    ids: ['MLU1', 'MLU1'],
  }), null);
  assert.equal(normalizeShowcaseCohort({
    schema_version: 2,
    total: 1,
    ids: ['ABC1'],
  }), null);
  assert.equal(normalizeShowcaseCohort({
    schema_version: 2,
    total: 2,
    ids: ['MLU1'],
  }), null);
  assert.equal(normalizeShowcaseCohort(payload(1, 1001)), null);
  assert.equal(normalizeShowcaseCohort(payload(2, 3001)), null);
});

test('Preview usa una muestra controlada sólo si faltan v2 y v1', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  installCache();
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url));
    return new Response('ausente', { status: 404 });
  };
  resetShowcaseCohortMemoryForTests();

  try {
    const preview = await fetchShowcaseCohort(context('preview'));
    assert.equal(preview.source, 'preview-fallback');
    assert.deepEqual([...preview.ids], SHOWCASE_PREVIEW_SAMPLE_IDS);
    assert.deepEqual(urls, [SHOWCASE_COHORT_V2_URL, SHOWCASE_COHORT_V1_URL]);
    assert.equal(
      await isProductInShowcaseCohort(context('preview'), SHOWCASE_PREVIEW_SAMPLE_IDS[0]),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
    resetShowcaseCohortMemoryForTests();
  }
});

test('Producción nunca usa la muestra de Preview si faltan ambos archivos', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  installCache();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('ausente', { status: 404 });
  };
  resetShowcaseCohortMemoryForTests();

  try {
    assert.equal(await fetchShowcaseCohort(context('production')), null);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
    resetShowcaseCohortMemoryForTests();
  }
});

test('prefiere v2, la cachea y permite consultar pertenencia por ID', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const writes = installCache();
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    return Response.json({
      schema_version: 2,
      generated_at: '2026-08-20T12:00:00.000Z',
      catalog_version: '2026-08-20T12:00:00.000Z',
      total: 3,
      ids: ['MLU10', 'MLU20', 'MLU30'],
    });
  };
  resetShowcaseCohortMemoryForTests();

  try {
    const ctx = context('production');
    const cohort = await fetchShowcaseCohort(ctx);
    assert.equal(cohort.source, 'r2-v2');
    assert.equal(cohort.ids.has('MLU20'), true);
    assert.deepEqual(calls, [SHOWCASE_COHORT_V2_URL]);
    assert.equal(writes.length, 1);
    assert.equal(await isProductInShowcaseCohort(ctx, 'mlu20'), true);
    assert.equal(await isProductInShowcaseCohort(ctx, 'MLU99'), false);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
    resetShowcaseCohortMemoryForTests();
  }
});

test('si v2 falta o es inválida, conserva la cohorte v1 de rollback', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const writes = installCache();
  const calls = [];
  globalThis.fetch = async url => {
    const value = String(url);
    calls.push(value);
    if (value === SHOWCASE_COHORT_V2_URL) return new Response('ausente', { status: 404 });
    return Response.json({
      schema_version: 1,
      generated_at: '2026-08-20T12:00:00.000Z',
      catalog_version: '2026-08-20T12:00:00.000Z',
      total: 2,
      ids: ['MLU11', 'MLU22'],
    });
  };
  resetShowcaseCohortMemoryForTests();

  try {
    const cohort = await fetchShowcaseCohort(context('production'));
    assert.equal(cohort.source, 'r2-v1');
    assert.deepEqual([...cohort.ids], ['MLU11', 'MLU22']);
    assert.deepEqual(calls, [SHOWCASE_COHORT_V2_URL, SHOWCASE_COHORT_V1_URL]);
    assert.equal(writes.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
    resetShowcaseCohortMemoryForTests();
  }
});

test('fuera de Preview/Producción no hace fetch ni consulta caché', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}); };
  globalThis.caches = {
    default: {
      async match() { calls++; return null; },
      async put() { calls++; },
    },
  };
  resetShowcaseCohortMemoryForTests();

  try {
    assert.equal(await fetchShowcaseCohort(context('test')), null);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
    resetShowcaseCohortMemoryForTests();
  }
});
