import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  CATALOG_URL,
  PAUSED_MANIFEST_URL,
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

test('índice pausado sólo se lee en Preview y expande el formato compacto', async () => {
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
    assert.deepEqual(requests, [PAUSED_MANIFEST_URL, `${R2_BASE}/${CURRENT.index_key}`]);
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
