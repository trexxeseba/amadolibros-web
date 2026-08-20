import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchShowcaseCohort,
  isProductInShowcaseCohort,
  normalizeShowcaseCohort,
  resetShowcaseCohortMemoryForTests,
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

test('acepta una cohorte compacta, única y limitada a 1000 MLU', () => {
  const ids = Array.from({ length: 1000 }, (_, index) => `MLU${100000000 + index}`);
  const cohort = normalizeShowcaseCohort({
    schema_version: 1,
    generated_at: '2026-08-20T12:00:00.000Z',
    catalog_version: '2026-08-20T12:00:00.000Z',
    total: ids.length,
    ids,
  });

  assert.ok(cohort);
  assert.equal(cohort.total, 1000);
  assert.equal(cohort.ids.size, 1000);
  assert.equal(cohort.ids.has(ids[999]), true);
  assert.equal(cohort.source, 'r2');
});

test('rechaza duplicados, IDs inválidos, total cruzado y más de 1000', () => {
  assert.equal(normalizeShowcaseCohort({
    schema_version: 1,
    total: 2,
    ids: ['MLU1', 'MLU1'],
  }), null);
  assert.equal(normalizeShowcaseCohort({
    schema_version: 1,
    total: 1,
    ids: ['ABC1'],
  }), null);
  assert.equal(normalizeShowcaseCohort({
    schema_version: 1,
    total: 2,
    ids: ['MLU1'],
  }), null);
  assert.equal(normalizeShowcaseCohort({
    schema_version: 1,
    total: 1001,
    ids: Array.from({ length: 1001 }, (_, index) => `MLU${index + 1}`),
  }), null);
});

test('Preview usa una muestra controlada si la cohorte todavía no existe', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  installCache();
  globalThis.fetch = async () => new Response('ausente', { status: 404 });
  resetShowcaseCohortMemoryForTests();

  try {
    const preview = await fetchShowcaseCohort(context('preview'));
    assert.equal(preview.source, 'preview-fallback');
    assert.deepEqual([...preview.ids], SHOWCASE_PREVIEW_SAMPLE_IDS);
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

test('Producción nunca usa la muestra de Preview si falta el archivo', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  installCache();
  globalThis.fetch = async () => new Response('ausente', { status: 404 });
  resetShowcaseCohortMemoryForTests();

  try {
    assert.equal(await fetchShowcaseCohort(context('production')), null);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
    resetShowcaseCohortMemoryForTests();
  }
});

test('lee R2, normaliza la cohorte y permite consultar pertenencia por ID', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const writes = installCache();
  globalThis.fetch = async () => Response.json({
    schema_version: 1,
    generated_at: '2026-08-20T12:00:00.000Z',
    catalog_version: '2026-08-20T12:00:00.000Z',
    total: 3,
    ids: ['MLU10', 'MLU20', 'MLU30'],
  });
  resetShowcaseCohortMemoryForTests();

  try {
    const ctx = context('production');
    const cohort = await fetchShowcaseCohort(ctx);
    assert.equal(cohort.source, 'r2');
    assert.equal(cohort.ids.has('MLU20'), true);
    assert.equal(writes.length, 1);
    assert.equal(await isProductInShowcaseCohort(ctx, 'mlu20'), true);
    assert.equal(await isProductInShowcaseCohort(ctx, 'MLU99'), false);
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
