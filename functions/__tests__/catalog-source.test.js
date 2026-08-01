import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  CATALOG_URL,
  PAUSED_MANIFEST_URL,
  PRODUCTION_MANIFEST_URL,
  R2_BASE,
  catalogUrlFor,
  fetchActiveIndex,
  fetchCatalog,
  fetchPausedIndex,
  fetchPausedItem,
  pausedBlockNumberForId,
} from '../_shared/catalog.js';

const CURRENT = {
  version: '20260730120000000',
  index_key: 'stock1-preview/versions/20260730120000000/index.json',
  active_index_key: 'stock1-preview/versions/20260730120000000/active-index.json',
  block_prefix: 'stock1-preview/versions/20260730120000000',
  block_count: 128,
};
const PREVIOUS = {
  version: '20260729120000000',
  index_key: 'stock1-preview/versions/20260729120000000/index.json',
  active_index_key: 'stock1-preview/versions/20260729120000000/active-index.json',
  block_prefix: 'stock1-preview/versions/20260729120000000',
  block_count: 128,
};

function context(appEnv = 'preview') {
  return { env: { APP_ENV: appEnv }, waitUntil() {} };
}

function installNetwork(objects, cacheMiss = true) {
  const requests = [];
  globalThis.caches = {
    default: {
      async match(request) {
        if (cacheMiss) return null;
        const value = objects.get(request.url);
        return value == null ? null : Response.json(value);
      },
      async put() {},
    },
  };
  globalThis.fetch = async url => {
    requests.push(String(url));
    const value = objects.get(String(url));
    return value == null
      ? new Response('not found', { status: 404 })
      : Response.json(value);
  };
  return requests;
}

test('catálogo principal siempre apunta al archivo activo de producción', async () => {
  const originalFetch = globalThis.fetch;
  const objects = new Map([[CATALOG_URL, { total: 1, items: [{ id: 'MLU1' }] }]]);
  const requests = installNetwork(objects);
  try {
    assert.equal(catalogUrlFor({ env: { APP_ENV: 'preview' } }), CATALOG_URL);
    assert.equal(catalogUrlFor({ env: { APP_ENV: 'production' } }), CATALOG_URL);
    const result = await fetchCatalog(context('preview'));
    assert.equal(result.total, 1);
    assert.deepEqual(requests, [CATALOG_URL]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('índice pausado expande el formato compacto (producción intenta su propio manifest, ausente en este mock)', async () => {
  const originalFetch = globalThis.fetch;
  const objects = new Map([
    [PAUSED_MANIFEST_URL, { schema_version: 1, current: CURRENT, previous: null }],
    [`${R2_BASE}/${CURRENT.index_key}`, {
      schema_version: 1,
      fields: ['id', 'title', 'author', 'isbn', 'image'],
      derived_fields: {
        slug: 'slugify-v1',
        status: 'paused',
        block: 'numeric-id-mod-block-count',
      },
      block_count: 128,
      total: 1,
      items: [['MLU2', 'Libro raro', 'Autora', '9781', 'https://img']],
    }],
  ]);
  const requests = installNetwork(objects);
  try {
    assert.equal(await fetchPausedIndex(context('production')), null);
    const result = await fetchPausedIndex(context('preview'));
    assert.equal(result.version, CURRENT.version);
    assert.deepEqual(result.items[0], {
      id: 'MLU2',
      title: 'Libro raro',
      author: 'Autora',
      isbn: '9781',
      thumbnail: 'https://img',
      slug: 'libro-raro',
      status: 'paused',
      available_quantity: 0,
      paused_block: 2,
    });
    assert.deepEqual(requests, [
      PRODUCTION_MANIFEST_URL,
      PAUSED_MANIFEST_URL,
      `${R2_BASE}/${CURRENT.index_key}`,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('índice activo compacto conserva precio, stock y fallback versionado', async () => {
  const originalFetch = globalThis.fetch;
  const previousUrl = `${R2_BASE}/${PREVIOUS.active_index_key}`;
  const objects = new Map([
    [PAUSED_MANIFEST_URL, { schema_version: 1, current: CURRENT, previous: PREVIOUS }],
    [previousUrl, {
      schema_version: 1,
      fields: [
        'id', 'title', 'author', 'isbn', 'image', 'price', 'available_quantity',
      ],
      derived_fields: {
        slug: 'slugify-v1',
        status: 'active',
      },
      total: 1,
      items: [['MLU1', 'Libro activo', 'Autora', '9781', 'https://img', 1234, 2]],
    }],
  ]);
  const requests = installNetwork(objects);
  try {
    assert.equal(await fetchActiveIndex(context('production')), null);
    const result = await fetchActiveIndex(context('preview'));
    assert.equal(result.version, PREVIOUS.version);
    assert.deepEqual(result.items[0], {
      id: 'MLU1',
      title: 'Libro activo',
      author: 'Autora',
      isbn: '9781',
      thumbnail: 'https://img',
      price: 1234,
      status: 'active',
      available_quantity: 2,
      slug: 'libro-activo',
    });
    assert.deepEqual(requests, [
      PRODUCTION_MANIFEST_URL,
      PAUSED_MANIFEST_URL,
      `${R2_BASE}/${CURRENT.active_index_key}`,
      previousUrl,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('índices gzip se descomprimen dentro de Pages y evitan bajar el JSON normal', async () => {
  const originalFetch = globalThis.fetch;
  const current = {
    ...CURRENT,
    index_gzip_key: `${CURRENT.index_key}.gz`,
    active_index_gzip_key: `${CURRENT.active_index_key}.gz`,
  };
  const activePayload = {
    schema_version: 1,
    fields: ['id', 'title', 'author', 'isbn', 'image', 'price', 'available_quantity'],
    derived_fields: { slug: 'slugify-v1', status: 'active' },
    items: [['MLU1', 'Activo gzip', '', '', '', 1200, 1]],
  };
  const pausedPayload = {
    schema_version: 1,
    fields: ['id', 'title', 'author', 'isbn', 'image'],
    derived_fields: {
      slug: 'slugify-v1',
      status: 'paused',
      block: 'numeric-id-mod-block-count',
    },
    block_count: 128,
    items: [['MLU2', 'Pausado gzip', '', '', '']],
  };
  const responses = new Map([
    [PAUSED_MANIFEST_URL, Response.json({
      schema_version: 1,
      current,
      previous: null,
    })],
    [`${R2_BASE}/${current.active_index_gzip_key}`, new Response(
      gzipSync(Buffer.from(JSON.stringify(activePayload))),
    )],
    [`${R2_BASE}/${current.index_gzip_key}`, new Response(
      gzipSync(Buffer.from(JSON.stringify(pausedPayload))),
    )],
  ]);
  const requests = [];
  globalThis.caches = {
    default: {
      async match(request) {
        requests.push(request.url);
        return responses.get(request.url)?.clone() || null;
      },
      async put() {},
    },
  };
  globalThis.fetch = async () => new Response('not found', { status: 404 });
  const ctx = context('preview');
  try {
    const [active, paused] = await Promise.all([
      fetchActiveIndex(ctx),
      fetchPausedIndex(ctx),
    ]);
    assert.equal(active.items[0].title, 'Activo gzip');
    assert.equal(paused.items[0].title, 'Pausado gzip');
    assert.equal(requests.includes(`${R2_BASE}/${CURRENT.active_index_key}`), false);
    assert.equal(requests.includes(`${R2_BASE}/${CURRENT.index_key}`), false);
    assert.ok(ctx.data.perf.segments.some(
      segment => segment.name === 'active_index_gzip_decompress',
    ));
    assert.ok(ctx.data.perf.segments.some(
      segment => segment.name === 'paused_index_gzip_decompress',
    ));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('si gzip está corrupto conserva fallback al JSON normal', async () => {
  const originalFetch = globalThis.fetch;
  const current = {
    ...CURRENT,
    active_index_gzip_key: `${CURRENT.active_index_key}.gz`,
  };
  const normalUrl = `${R2_BASE}/${CURRENT.active_index_key}`;
  const responses = new Map([
    [PAUSED_MANIFEST_URL, Response.json({
      schema_version: 1,
      current,
      previous: null,
    })],
    [`${R2_BASE}/${current.active_index_gzip_key}`, new Response('gzip roto')],
    [normalUrl, Response.json({
      schema_version: 1,
      fields: ['id', 'title', 'author', 'isbn', 'image', 'price', 'available_quantity'],
      derived_fields: { slug: 'slugify-v1', status: 'active' },
      items: [['MLU1', 'Fallback normal', '', '', '', 1200, 1]],
    })],
  ]);
  globalThis.caches = {
    default: {
      async match(request) {
        return responses.get(request.url)?.clone() || null;
      },
      async put() {},
    },
  };
  globalThis.fetch = async () => new Response('not found', { status: 404 });
  try {
    const active = await fetchActiveIndex(context('preview'));
    assert.equal(active.items[0].title, 'Fallback normal');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('si falla el índice actual usa automáticamente la versión anterior', async () => {
  const originalFetch = globalThis.fetch;
  const previousUrl = `${R2_BASE}/${PREVIOUS.index_key}`;
  const objects = new Map([
    [PAUSED_MANIFEST_URL, { schema_version: 1, current: CURRENT, previous: PREVIOUS }],
    [previousUrl, {
      schema_version: 1,
      fields: ['id', 'title', 'author', 'isbn', 'image'],
      derived_fields: {
        slug: 'slugify-v1',
        status: 'paused',
        block: 'numeric-id-mod-block-count',
      },
      block_count: 128,
      total: 1,
      items: [['MLU3', 'Versión previa', '', '', '']],
    }],
  ]);
  installNetwork(objects);
  try {
    const result = await fetchPausedIndex(context());
    assert.equal(result.version, PREVIOUS.version);
    assert.equal(result.items[0].id, 'MLU3');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('CF-R2-2B: fetchActiveIndex y fetchPausedIndex en paralelo comparten un único fetch del manifest', async () => {
  const originalFetch = globalThis.fetch;
  const objects = new Map([
    [PAUSED_MANIFEST_URL, { schema_version: 1, current: CURRENT, previous: null }],
    [`${R2_BASE}/${CURRENT.active_index_key}`, {
      schema_version: 1,
      fields: ['id', 'title', 'author', 'isbn', 'image', 'price', 'available_quantity'],
      derived_fields: { slug: 'slugify-v1', status: 'active' },
      items: [['MLU1', 'Activo paralelo', '', '', '', 1000, 1]],
    }],
    [`${R2_BASE}/${CURRENT.index_key}`, {
      schema_version: 1,
      fields: ['id', 'title', 'author', 'isbn', 'image'],
      derived_fields: { slug: 'slugify-v1', status: 'paused', block: 'numeric-id-mod-block-count' },
      block_count: 128,
      items: [['MLU2', 'Pausado paralelo', '', '', '']],
    }],
  ]);
  const requests = installNetwork(objects);
  try {
    const ctx = context('preview');
    const [active, paused] = await Promise.all([
      fetchActiveIndex(ctx),
      fetchPausedIndex(ctx),
    ]);
    assert.equal(active.items[0].title, 'Activo paralelo');
    assert.equal(paused.items[0].title, 'Pausado paralelo');
    const manifestRequests = requests.filter(u => u === PAUSED_MANIFEST_URL);
    assert.equal(
      manifestRequests.length, 1,
      'ambas ramas deben compartir un único fetch a origen del manifest, no uno cada una',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('CF-R2-2B: la memoización del manifest no se comparte entre requests distintas', async () => {
  const originalFetch = globalThis.fetch;
  const objects = new Map([
    [PAUSED_MANIFEST_URL, { schema_version: 1, current: CURRENT, previous: null }],
    [`${R2_BASE}/${CURRENT.active_index_key}`, {
      schema_version: 1,
      fields: ['id', 'title', 'author', 'isbn', 'image', 'price', 'available_quantity'],
      derived_fields: { slug: 'slugify-v1', status: 'active' },
      items: [['MLU1', 'Otra request', '', '', '', 1000, 1]],
    }],
  ]);
  const requests = installNetwork(objects);
  try {
    const ctxA = context('preview');
    const ctxB = context('preview');
    await fetchActiveIndex(ctxA);
    await fetchActiveIndex(ctxB);
    const manifestRequests = requests.filter(u => u === PAUSED_MANIFEST_URL);
    assert.equal(
      manifestRequests.length, 2,
      'cada request (cada ctx) debe hacer su propio fetch — la memoización es por-request, no global',
    );
    assert.notEqual(
      ctxA.data.__pausedManifestPromise, ctxB.data.__pausedManifestPromise,
      'la promesa memoizada no debe compartirse entre objetos ctx distintos',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('CF-R2-2B: un fallo del manifest no deja estado reutilizado en otra request', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.caches = {
    default: {
      async match() { return null; },
      async put() {},
    },
  };
  let manifestCalls = 0;
  globalThis.fetch = async url => {
    if (String(url) === PAUSED_MANIFEST_URL) {
      manifestCalls += 1;
      throw new Error('network down');
    }
    return new Response('not found', { status: 404 });
  };
  try {
    const ctxA = context('preview');
    // Dentro de la misma request, el fallo también queda memoizado: dos
    // lecturas del índice sobre el mismo ctx no deben reintentar el fetch.
    await assert.rejects(() => fetchActiveIndex(ctxA));
    await assert.rejects(() => fetchPausedIndex(ctxA));
    assert.equal(
      manifestCalls, 1,
      'el fallo memoizado no debe disparar un segundo intento de fetch dentro de la misma request',
    );

    // Una request nueva (ctx nuevo) no hereda el fallo: arranca de cero.
    globalThis.fetch = async url => {
      const value = new Map([
        [PAUSED_MANIFEST_URL, { schema_version: 1, current: CURRENT, previous: null }],
        [`${R2_BASE}/${CURRENT.active_index_key}`, {
          schema_version: 1,
          fields: ['id', 'title', 'author', 'isbn', 'image', 'price', 'available_quantity'],
          derived_fields: { slug: 'slugify-v1', status: 'active' },
          items: [['MLU1', 'Request nueva tras fallo', '', '', '', 1000, 1]],
        }],
      ]).get(String(url));
      return value == null ? new Response('not found', { status: 404 }) : Response.json(value);
    };
    const ctxB = context('preview');
    const result = await fetchActiveIndex(ctxB);
    assert.equal(result.items[0].title, 'Request nueva tras fallo');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('una ficha pausada descarga únicamente su bloque y usa fallback', async () => {
  const originalFetch = globalThis.fetch;
  const id = 'MLU476064526';
  const currentBlock = pausedBlockNumberForId(id, CURRENT.block_count);
  const previousBlock = pausedBlockNumberForId(id, PREVIOUS.block_count);
  const previousUrl = `${R2_BASE}/${PREVIOUS.block_prefix}/block-${String(previousBlock).padStart(3, '0')}.json`;
  const objects = new Map([
    [PAUSED_MANIFEST_URL, { schema_version: 1, current: CURRENT, previous: PREVIOUS }],
    [previousUrl, {
      schema_version: 1,
      version: PREVIOUS.version,
      block: previousBlock,
      items: [{ id, title: 'Los seis pilares', status: 'paused' }],
    }],
  ]);
  const requests = installNetwork(objects);
  try {
    const item = await fetchPausedItem(context(), id);
    assert.equal(item.title, 'Los seis pilares');
    assert.equal(requests.length, 3);
    assert.match(requests[1], new RegExp(`block-${String(currentBlock).padStart(3, '0')}\\.json$`));
    assert.equal(requests[2], previousUrl);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── CF-R2-2-BRIDGE: soporte productivo del catálogo pausado ─────────────────

test('CF-R2-2-BRIDGE: separación estricta — cada entorno lee sólo su propio manifest, nunca el del otro', async () => {
  const originalFetch = globalThis.fetch;
  const objects = new Map([
    [PAUSED_MANIFEST_URL, { schema_version: 1, current: CURRENT, previous: null }],
    [`${R2_BASE}/${CURRENT.active_index_key}`, {
      schema_version: 1,
      fields: ['id', 'title', 'author', 'isbn', 'image', 'price', 'available_quantity'],
      derived_fields: { slug: 'slugify-v1', status: 'active' },
      items: [['MLU1', 'Activo de Preview', '', '', '', 1000, 1]],
    }],
    [PRODUCTION_MANIFEST_URL, { schema_version: 1, current: PREVIOUS, previous: null }],
    [`${R2_BASE}/${PREVIOUS.active_index_key}`, {
      schema_version: 1,
      fields: ['id', 'title', 'author', 'isbn', 'image', 'price', 'available_quantity'],
      derived_fields: { slug: 'slugify-v1', status: 'active' },
      items: [['MLU9', 'Activo de producción', '', '', '', 2000, 3]],
    }],
  ]);
  const requests = installNetwork(objects);
  try {
    const previewResult = await fetchActiveIndex(context('preview'));
    const requestsAfterPreview = requests.slice();
    const productionResult = await fetchActiveIndex(context('production'));
    const requestsAfterProduction = requests.slice(requestsAfterPreview.length);

    assert.equal(previewResult.items[0].title, 'Activo de Preview');
    assert.equal(productionResult.items[0].title, 'Activo de producción');

    // Preview sólo pidió sus propias claves (stock1-preview/*), nunca las
    // de producción (catalog/*).
    assert.ok(requestsAfterPreview.includes(PAUSED_MANIFEST_URL));
    assert.ok(requestsAfterPreview.includes(`${R2_BASE}/${CURRENT.active_index_key}`));
    assert.equal(requestsAfterPreview.includes(PRODUCTION_MANIFEST_URL), false);
    assert.equal(requestsAfterPreview.includes(`${R2_BASE}/${PREVIOUS.active_index_key}`), false);

    // Producción sólo pidió sus propias claves (catalog/*), nunca las de
    // Preview (stock1-preview/*).
    assert.ok(requestsAfterProduction.includes(PRODUCTION_MANIFEST_URL));
    assert.ok(requestsAfterProduction.includes(`${R2_BASE}/${PREVIOUS.active_index_key}`));
    assert.equal(requestsAfterProduction.includes(PAUSED_MANIFEST_URL), false);
    assert.equal(requestsAfterProduction.includes(`${R2_BASE}/${CURRENT.active_index_key}`), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('CF-R2-2-BRIDGE: producción puede leer su propio manifest e índices válidos, sin ninguna URL de Preview', async () => {
  const originalFetch = globalThis.fetch;
  // Descriptor con prefijo productivo real (catalog/versions/...) — nunca
  // stock1-preview/*, a diferencia de los fixtures CURRENT/PREVIOUS de
  // arriba (esos representan claves de Preview).
  const PRODUCTION_CURRENT = {
    version: '20260730120000000',
    index_key: 'catalog/versions/20260730120000000/index.json',
    active_index_key: 'catalog/versions/20260730120000000/active-index.json',
    block_prefix: 'catalog/versions/20260730120000000',
    block_count: 128,
  };
  const objects = new Map([
    [PRODUCTION_MANIFEST_URL, { schema_version: 1, current: PRODUCTION_CURRENT, previous: null }],
    [`${R2_BASE}/${PRODUCTION_CURRENT.active_index_key}`, {
      schema_version: 1,
      fields: ['id', 'title', 'author', 'isbn', 'image', 'price', 'available_quantity'],
      derived_fields: { slug: 'slugify-v1', status: 'active' },
      items: [['MLU5', 'Activo productivo', '', '', '', 500, 4]],
    }],
    [`${R2_BASE}/${PRODUCTION_CURRENT.index_key}`, {
      schema_version: 1,
      fields: ['id', 'title', 'author', 'isbn', 'image'],
      derived_fields: { slug: 'slugify-v1', status: 'paused', block: 'numeric-id-mod-block-count' },
      block_count: 128,
      items: [['MLU6', 'Pausado productivo', '', '', '']],
    }],
  ]);
  const requests = installNetwork(objects);
  try {
    const active = await fetchActiveIndex(context('production'));
    const paused = await fetchPausedIndex(context('production'));
    assert.equal(active.items[0].title, 'Activo productivo');
    assert.equal(paused.items[0].title, 'Pausado productivo');
    assert.ok(requests.length > 0);
    assert.ok(requests.every(url => !url.includes('stock1-preview')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('CF-R2-2-BRIDGE: manifest de producción ausente o inválido no rompe el catálogo activo (fallback, sin 500)', async () => {
  const originalFetch = globalThis.fetch;
  const objects = new Map([
    [CATALOG_URL, { total: 1, items: [{ id: 'MLU1', status: 'active', available_quantity: 1 }] }],
    // PRODUCTION_MANIFEST_URL deliberadamente ausente del mock -> 404.
  ]);
  installNetwork(objects);
  try {
    assert.equal(await fetchActiveIndex(context('production')), null);
    assert.equal(await fetchPausedIndex(context('production')), null);
    const fallback = await fetchCatalog(context('production'));
    assert.equal(fallback.items[0].id, 'MLU1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('CF-R2-2-BRIDGE: producción también deduplica el fetch del manifest dentro de una misma request', async () => {
  const originalFetch = globalThis.fetch;
  const objects = new Map([
    [PRODUCTION_MANIFEST_URL, { schema_version: 1, current: CURRENT, previous: null }],
    [`${R2_BASE}/${CURRENT.active_index_key}`, {
      schema_version: 1,
      fields: ['id', 'title', 'author', 'isbn', 'image', 'price', 'available_quantity'],
      derived_fields: { slug: 'slugify-v1', status: 'active' },
      items: [['MLU1', 'Activo', '', '', '', 1000, 1]],
    }],
    [`${R2_BASE}/${CURRENT.index_key}`, {
      schema_version: 1,
      fields: ['id', 'title', 'author', 'isbn', 'image'],
      derived_fields: { slug: 'slugify-v1', status: 'paused', block: 'numeric-id-mod-block-count' },
      block_count: 128,
      items: [['MLU2', 'Pausado', '', '', '']],
    }],
  ]);
  const requests = installNetwork(objects);
  try {
    const ctx = context('production');
    await Promise.all([fetchActiveIndex(ctx), fetchPausedIndex(ctx)]);
    const manifestRequests = requests.filter(u => u === PRODUCTION_MANIFEST_URL);
    assert.equal(manifestRequests.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
