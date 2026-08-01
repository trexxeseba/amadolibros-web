import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCatalog,
  createDataQualitySummary,
  extractDimensions,
  slimItem,
} from '../meli-catalog.js';
import {
  PRODUCTION_CATALOG_KEY,
  STOCK1_PREVIEW_CATALOG_KEY,
  runMeasure,
  runPreviewCatalogPublish,
  runProductionCatalogPublish,
  summarizeCatalog,
} from '../index.js';
import {
  addCompressedIndexes,
  blockNumberForId,
  buildPausedCatalogArtifacts,
  PAUSED_MANIFEST_KEY,
  PRODUCTION_MANIFEST_KEY,
} from '../paused-catalog.js';

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

test('modo público solicita y devuelve únicamente publicaciones activas', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url));
    if (String(url).includes('/items/search')) {
      return Response.json({ results: ['MLU1'], scroll_id: null });
    }
    return Response.json([{
      code: 200,
      body: {
        id: 'MLU1',
        title: 'Activo',
        status: 'active',
        available_quantity: 1,
        attributes: [],
        pictures: [],
      },
    }]);
  };
  try {
    const catalog = await buildCatalog(
      { USER_ID: '123', MIN_ACTIVE_ITEMS: '1' },
      'token',
      { statuses: ['active'] },
    );
    assert.equal(catalog.total, 1);
    assert.deepEqual(catalog.items.map(item => item.status), ['active']);
    assert.ok(urls.some(url => url.includes('status=active')));
    assert.ok(urls.every(url => !url.includes('status=paused')));
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

test('publica únicamente la clave fija del catálogo STOCK-1 Preview', async () => {
  const writes = [];
  const objects = new Map();
  const catalog = {
    total: 2,
    updated_at: '2026-07-30T12:00:00.000Z',
    items: [
      { id: 'MLU1', title: 'Activo', status: 'active', available_quantity: 2 },
      { id: 'MLU2', title: 'Pausado', status: 'paused', available_quantity: 0 },
    ],
  };
  const env = {
    STOCK1_PREVIEW_PUBLISH_ENABLED: true,
    CATALOG_R2: {
      async put(key, body, options) {
        writes.push({ key, body, options });
        objects.set(key, body);
      },
      async get(key) {
        const body = objects.get(key);
        return body == null ? null : { async text() { return body; } };
      },
      async head(key) {
        const body = objects.get(key);
        return body == null ? null : {
          size: typeof body === 'string'
            ? new TextEncoder().encode(body).length
            : body.byteLength,
        };
      },
    },
  };

  const result = await runPreviewCatalogPublish(env, {
    getAccessTokenFn: async () => 'token',
    buildCatalogFn: async () => catalog,
  });

  assert.equal(result.status, 'published-preview');
  assert.equal(result.published, true);
  assert.equal(result.production_catalog_modified, false);
  assert.equal(result.key, STOCK1_PREVIEW_CATALOG_KEY);
  assert.equal(result.key, PAUSED_MANIFEST_KEY);
  assert.deepEqual(result.sample_paused, { id: 'MLU2', title: 'Pausado' });
  assert.equal(result.paused_catalog.block_count, 128);
  assert.equal(result.active_catalog.total, 1);
  assert.ok(result.active_catalog.index_bytes > 0);
  assert.equal(writes.length, 133);
  assert.equal(writes.at(-1).key, 'stock1-preview/manifest.json');
  assert.ok(writes.slice(0, -1).every(write => write.key.includes('/versions/')));
  assert.ok(writes.every(write => write.key !== 'catalog.json'));
  assert.equal(writes.at(-1).options.customMetadata.publication, 'atomic-pointer');
  assert.ok(result.active_catalog.index_gzip_bytes < result.active_catalog.index_bytes);
  assert.ok(result.paused_catalog.index_gzip_bytes < result.paused_catalog.index_bytes);
});

test('bloquea publicación Preview cuando la versión aislada no la habilita', async () => {
  let wrote = false;
  const result = await runPreviewCatalogPublish({
    CATALOG_R2: { async put() { wrote = true; } },
  });

  assert.equal(result.status, 'error');
  assert.equal(result.published, false);
  assert.equal(wrote, false);
});

test('no cambia el manifest si falla la verificación de un bloque', async () => {
  const writtenKeys = [];
  const result = await runPreviewCatalogPublish({
    STOCK1_PREVIEW_PUBLISH_ENABLED: true,
    CATALOG_R2: {
      async put(key) { writtenKeys.push(key); },
      async get() { return null; },
      async head() { return null; },
    },
  }, {
    getAccessTokenFn: async () => 'token',
    buildCatalogFn: async () => ({
      updated_at: '2026-07-30T12:00:00.000Z',
      items: [
        { id: 'MLU1', title: 'Activo', status: 'active', available_quantity: 1 },
        { id: 'MLU2', title: 'Pausado', status: 'paused', available_quantity: 0 },
      ],
    }),
  });

  assert.equal(result.status, 'error');
  assert.equal(result.published, false);
  assert.equal(writtenKeys.includes(PAUSED_MANIFEST_KEY), false);
  assert.ok(writtenKeys.some(key => key.includes('/versions/')));
});

test('índice pausado compacto y bloques usan una asignación determinista', () => {
  const catalog = {
    updated_at: '2026-07-30T12:34:56.789Z',
    items: [
      { id: 'MLU1', title: 'Activo', status: 'active', available_quantity: 1 },
      { id: 'MLU476064526', title: 'Los seis pilares', status: 'paused', pictures: [] },
      { id: 'MLU2', title: 'Otro pausado', status: 'paused', pictures: [] },
    ],
  };
  const artifacts = buildPausedCatalogArtifacts(catalog);
  const index = JSON.parse(artifacts.index.body);
  assert.equal(artifacts.total, 2);
  assert.equal(artifacts.block_count, 128);
  assert.equal(index.items.length, 2);
  assert.equal(index.fields.join(','), 'id,title,author,isbn,image');
  assert.equal(index.derived_fields.slug, 'slugify-v1');
  assert.equal(index.derived_fields.status, 'paused');
  const activeIndex = JSON.parse(artifacts.active_index.body);
  assert.equal(activeIndex.items.length, 1);
  assert.equal(
    activeIndex.fields.join(','),
    'id,title,author,isbn,image,price,available_quantity'
  );
  assert.equal(activeIndex.derived_fields.status, 'active');
  assert.equal(blockNumberForId(index.items[1][0], 128), blockNumberForId('MLU476064526', 128));
  assert.ok(artifacts.max_block_bytes < 204800);
});

test('genera índices gzip menores y descomprimibles sin modificar los JSON base', async () => {
  const artifacts = buildPausedCatalogArtifacts({
    updated_at: '2026-07-30T12:34:56.789Z',
    items: [
      ...Array.from({ length: 100 }, (_, index) => ({
        id: `MLU${1000 + index}`,
        title: `Activo repetible ${index}`,
        status: 'active',
        available_quantity: 1,
        price: 1000,
      })),
      ...Array.from({ length: 100 }, (_, index) => ({
        id: `MLU${2000 + index}`,
        title: `Pausado repetible ${index}`,
        status: 'paused',
        available_quantity: 0,
      })),
    ],
  });
  const compressed = await addCompressedIndexes(artifacts);
  assert.equal(compressed.active_index.body, artifacts.active_index.body);
  assert.equal(compressed.index.body, artifacts.index.body);
  assert.ok(compressed.active_index.gzip_bytes < compressed.active_index.bytes);
  assert.ok(compressed.index.gzip_bytes < compressed.index.bytes);
  assert.match(compressed.active_index.gzip_key, /active-index\.json\.gz$/);
  assert.match(compressed.index.gzip_key, /index\.json\.gz$/);
});

test('normaliza medidas razonables y omite valores absurdos o unidades desconocidas', () => {
  const quality = createDataQualitySummary();
  const dimensions = extractDimensions([
    { id: 'WIDTH', value_struct: { number: 150, unit: 'mm' } },
    { id: 'HEIGHT', value_name: '22 cm' },
    { id: 'LENGTH', value_name: '22222 cm' },
    { id: 'WEIGHT', value_name: '22.222 kg' },
  ], quality);

  assert.deepEqual(dimensions, { height: '22 cm', width: '15 cm' });
  assert.equal(quality.valid_dimension_fields, 2);
  assert.equal(quality.omitted_dimension_fields, 1);
  assert.equal(quality.omitted_weight_fields, 1);
  assert.equal(quality.unknown_unit_fields, 0);
  assert.equal(quality.items_with_valid_measurements, 1);

  const unknown = createDataQualitySummary();
  assert.equal(extractDimensions([
    { id: 'WIDTH', value_name: '12 bananas' },
    { id: 'WEIGHT', value_name: '500' },
  ], unknown), null);
  assert.equal(unknown.unknown_unit_fields, 2);
});

test('slimItem conserva la publicación cuando descarta sus medidas inválidas', () => {
  const quality = createDataQualitySummary();
  const item = slimItem({
    id: 'MLU9',
    title: 'Libro con datos malos',
    status: 'paused',
    attributes: [
      { id: 'WIDTH', value_name: '22222 cm' },
      { id: 'WEIGHT', value_name: '-2 kg' },
    ],
  }, quality);

  assert.equal(item.id, 'MLU9');
  assert.equal(item.title, 'Libro con datos malos');
  assert.equal(item.dimensions, null);
  assert.equal(quality.omitted_dimension_fields, 1);
  assert.equal(quality.omitted_weight_fields, 1);
});

// ── CF-R2-2-BRIDGE: publicación productiva del catálogo pausado ─────────────

test('CF-R2-2-BRIDGE: publica el catálogo productivo bajo catalog/*, nunca stock1-preview/*', async () => {
  const writes = [];
  const objects = new Map();
  const catalog = {
    total: 2,
    updated_at: '2026-08-01T09:00:00.000Z',
    items: [
      { id: 'MLU1', title: 'Activo', status: 'active', available_quantity: 2 },
      { id: 'MLU2', title: 'Pausado', status: 'paused', available_quantity: 0 },
    ],
  };
  const env = {
    PRODUCTION_PAUSED_CATALOG_PUBLISH_ENABLED: true,
    CATALOG_R2: {
      async put(key, body, options) {
        writes.push({ key, body, options });
        objects.set(key, body);
      },
      async get(key) {
        const body = objects.get(key);
        return body == null ? null : { async text() { return body; } };
      },
      async head(key) {
        const body = objects.get(key);
        return body == null ? null : {
          size: typeof body === 'string'
            ? new TextEncoder().encode(body).length
            : body.byteLength,
        };
      },
    },
  };

  const result = await runProductionCatalogPublish(env, {
    getAccessTokenFn: async () => 'token',
    buildCatalogFn: async () => catalog,
  });

  assert.equal(result.status, 'published-production');
  assert.equal(result.published, true);
  assert.equal(result.production_catalog_modified, false);
  assert.equal(result.key, PRODUCTION_CATALOG_KEY);
  assert.equal(result.key, PRODUCTION_MANIFEST_KEY);
  assert.deepEqual(result.sample_paused, { id: 'MLU2', title: 'Pausado' });
  assert.equal(writes.length, 133);
  assert.equal(writes.at(-1).key, 'catalog/manifest.json');
  assert.ok(writes.slice(0, -1).every(write => write.key.startsWith('catalog/versions/')));
  assert.ok(writes.every(write => write.key !== 'catalog.json'));
  assert.ok(writes.every(write => !write.key.startsWith('stock1-preview')));
  assert.equal(writes.at(-1).options.customMetadata.scope, 'production');
  assert.equal(writes.at(-1).options.customMetadata.publication, 'atomic-pointer');
});

test('CF-R2-2-BRIDGE: bloquea publicación productiva cuando el flag no la habilita', async () => {
  let wrote = false;
  const result = await runProductionCatalogPublish({
    CATALOG_R2: { async put() { wrote = true; } },
  });

  assert.equal(result.status, 'error');
  assert.equal(result.published, false);
  assert.equal(wrote, false);
});

test('CF-R2-2-BRIDGE: publicar producción no toca ninguna clave de Preview, y viceversa', async () => {
  const previewWrites = [];
  const productionWrites = [];
  const catalog = {
    total: 2,
    updated_at: '2026-08-01T09:00:00.000Z',
    items: [
      { id: 'MLU1', title: 'Activo', status: 'active', available_quantity: 2 },
      { id: 'MLU2', title: 'Pausado', status: 'paused', available_quantity: 0 },
    ],
  };
  function makeBucket(sink) {
    const objects = new Map();
    return {
      async put(key, body, options) { sink.push(key); objects.set(key, body); },
      async get(key) {
        const body = objects.get(key);
        return body == null ? null : { async text() { return body; } };
      },
      async head(key) {
        const body = objects.get(key);
        return body == null ? null : {
          size: typeof body === 'string'
            ? new TextEncoder().encode(body).length
            : body.byteLength,
        };
      },
    };
  }

  await runPreviewCatalogPublish({
    STOCK1_PREVIEW_PUBLISH_ENABLED: true,
    CATALOG_R2: makeBucket(previewWrites),
  }, {
    getAccessTokenFn: async () => 'token',
    buildCatalogFn: async () => catalog,
  });
  await runProductionCatalogPublish({
    PRODUCTION_PAUSED_CATALOG_PUBLISH_ENABLED: true,
    CATALOG_R2: makeBucket(productionWrites),
  }, {
    getAccessTokenFn: async () => 'token',
    buildCatalogFn: async () => catalog,
  });

  assert.ok(previewWrites.every(key => key.startsWith('stock1-preview')));
  assert.ok(productionWrites.every(key => key.startsWith('catalog/')));
  assert.equal(previewWrites.some(key => productionWrites.includes(key)), false);
});

test('CF-R2-2-BRIDGE: producción tampoco cambia su manifest si falla la verificación de un bloque', async () => {
  const writtenKeys = [];
  const result = await runProductionCatalogPublish({
    PRODUCTION_PAUSED_CATALOG_PUBLISH_ENABLED: true,
    CATALOG_R2: {
      async put(key) { writtenKeys.push(key); },
      async get() { return null; },
      async head() { return null; },
    },
  }, {
    getAccessTokenFn: async () => 'token',
    buildCatalogFn: async () => ({
      updated_at: '2026-08-01T09:00:00.000Z',
      items: [
        { id: 'MLU1', title: 'Activo', status: 'active', available_quantity: 1 },
        { id: 'MLU2', title: 'Pausado', status: 'paused', available_quantity: 0 },
      ],
    }),
  });

  assert.equal(result.status, 'error');
  assert.equal(result.published, false);
  assert.equal(writtenKeys.includes(PRODUCTION_MANIFEST_KEY), false);
  assert.ok(writtenKeys.some(key => key.includes('/versions/')));
});
