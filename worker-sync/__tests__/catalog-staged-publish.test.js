import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  runStagedProductionCatalogStep,
  STAGED_ROOT,
} from '../catalog-staged-publish.js';
import {
  addCompressedIndexes,
  buildPausedCatalogArtifacts,
  PRODUCTION_MANIFEST_KEY,
} from '../paused-catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXED_NOW = new Date('2026-11-26T07:50:00.123Z');
const VERSION = '20261126075000123';

function makeBucket({ failHeadFor = null } = {}) {
  const objects = new Map();
  const writes = [];
  const deletes = [];
  const size = body => (typeof body === 'string' ? new TextEncoder().encode(body).length : body.byteLength);
  return {
    objects,
    writes,
    deletes,
    async put(key, body, options) {
      writes.push({ key, options });
      objects.set(key, body);
    },
    async get(key) {
      const body = objects.get(key);
      if (body == null) return null;
      return { async text() { return typeof body === 'string' ? body : new TextDecoder().decode(body); } };
    },
    async head(key) {
      if (failHeadFor && key.endsWith(failHeadFor)) return null;
      const body = objects.get(key);
      return body == null ? null : { size: size(body) };
    },
    async list({ prefix = '', delimiter } = {}) {
      const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort();
      if (!delimiter) return { objects: keys.map(key => ({ key })), truncated: false };
      const prefixes = new Set();
      const direct = [];
      for (const key of keys) {
        const rest = key.slice(prefix.length);
        const cut = rest.indexOf(delimiter);
        if (cut >= 0) prefixes.add(prefix + rest.slice(0, cut + 1));
        else direct.push({ key });
      }
      return { objects: direct, delimitedPrefixes: [...prefixes], truncated: false };
    },
    async delete(keys) {
      for (const key of [].concat(keys)) {
        deletes.push(key);
        objects.delete(key);
      }
    },
  };
}

function makeCatalogItems(count = 700) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const id = `MLU${100000 + i * 7}`;
    const paused = i % 3 === 0;
    items.push({
      id,
      title: `Libro ${i}`,
      author: `Autor ${i % 11}`,
      isbn: String(9780000000000 + i),
      status: paused ? 'paused' : 'active',
      available_quantity: paused ? 0 : (i % 10 === 1 ? 0 : 2),
      price: 500 + i,
      currency: 'UYU',
      thumbnail: `https://http2.mlstatic.com/D_${i}-O.jpg`,
      pictures: [`https://http2.mlstatic.com/D_${i}-O.jpg`],
    });
  }
  return items;
}

function makeDeps(items, overrides = {}) {
  const byId = new Map(items.map(item => [item.id, item]));
  const calls = { fetchSlim: [], enrich: [], tokens: 0 };
  return {
    calls,
    deps: {
      now: () => FIXED_NOW,
      getAccessTokenFn: async () => { calls.tokens++; return 'token'; },
      fetchAllIdsFn: async (_userId, _token, statuses) => {
        assert.deepEqual(statuses, ['active', 'paused']);
        // El orden del scroll no coincide con el orden por ID.
        return [...items].reverse().map(item => item.id);
      },
      fetchSlimItemsFn: async ids => {
        calls.fetchSlim.push(ids.length);
        return { items: ids.map(id => structuredClone(byId.get(id))), excluded: 0 };
      },
      enrichPicturesFn: async (chunkItems, env) => {
        calls.enrich.push(Number(env.ML_CATALOG_GALLERY_ENRICH_LIMIT));
        return { fetched: 0, failed: 0, reused: chunkItems.length };
      },
      ...overrides,
    },
  };
}

function baseEnv(bucket, extra = {}) {
  return {
    PRODUCTION_PAUSED_CATALOG_PUBLISH_ENABLED: 'true',
    PRODUCTION_CATALOG_CHUNK_SIZE: '150',
    MIN_ACTIVE_ITEMS: '10',
    USER_ID: '1',
    CATALOG_R2: bucket,
    ...extra,
  };
}

async function runAll(env, deps, { maxSteps = 100 } = {}) {
  const results = [];
  const start = await runStagedProductionCatalogStep(env, { step: 'start' }, deps);
  results.push(start);
  if (start.status === 'error') return results;
  for (let i = 0; i < maxSteps; i++) {
    const result = await runStagedProductionCatalogStep(env, { step: 'continue', runId: start.run_id }, deps);
    results.push(result);
    if (result.status === 'error' || result.published) break;
  }
  return results;
}

test('publica por partes: el manifest aparece recién al final y apunta a una versión completa', async () => {
  const bucket = makeBucket();
  const items = makeCatalogItems();
  const { deps, calls } = makeDeps(items);
  const results = await runAll(baseEnv(bucket, { ML_CATALOG_GALLERY_ENRICH_LIMIT: '300' }), deps);
  const final = results.at(-1);

  assert.equal(final.status, 'published-production');
  assert.equal(final.published, true);
  assert.equal(final.production_catalog_modified, false);
  assert.equal(final.key, PRODUCTION_MANIFEST_KEY);
  assert.equal(final.paused_catalog.block_count, 128);
  assert.ok(final.paused_catalog.index_gzip_bytes < final.paused_catalog.index_bytes);
  assert.ok(final.active_catalog.index_gzip_bytes < final.active_catalog.index_bytes);

  // start + 5 tramos de detalle + índice + 4 rangos de bloques + finalize.
  assert.deepEqual(results.map(result => result.phase ?? 'done'), [
    'details', 'details', 'details', 'details', 'details', 'index',
    'blocks', 'blocks', 'blocks', 'blocks', 'finalize', 'done',
  ]);
  // Cada llamada a ML pide a lo sumo un tramo, nunca el catálogo entero.
  assert.deepEqual(calls.fetchSlim, [150, 150, 150, 150, 100]);
  // El tope de galerías se reparte entre los tramos.
  assert.deepEqual(calls.enrich, [60, 60, 60, 60, 60]);

  const manifestWrites = bucket.writes.filter(write => write.key === PRODUCTION_MANIFEST_KEY);
  assert.equal(manifestWrites.length, 1);
  assert.ok(
    bucket.writes.indexOf(manifestWrites[0]) >
      bucket.writes.findLastIndex(write => write.key.startsWith('catalog/versions/')),
    'el manifest se escribe después de todos los artefactos de la versión',
  );
  assert.equal(manifestWrites[0].options.customMetadata.publication, 'atomic-pointer');
  for (const write of bucket.writes) {
    assert.notEqual(write.key, 'catalog.json');
    assert.notEqual(write.key, 'meta.json');
    assert.ok(
      write.key === PRODUCTION_MANIFEST_KEY ||
      write.key.startsWith(`catalog/versions/${VERSION}/`) ||
      write.key.startsWith(`${STAGED_ROOT}/${VERSION}/`),
      `escritura inesperada: ${write.key}`,
    );
  }

  // El contenido es idéntico al de la publicación en una sola llamada.
  const reference = await addCompressedIndexes(buildPausedCatalogArtifacts(
    { items },
    { version: VERSION, prefixRoot: 'catalog/versions' },
  ));
  assert.equal(bucket.objects.get(reference.index.key), reference.index.body);
  assert.equal(bucket.objects.get(reference.active_index.key), reference.active_index.body);
  for (const block of reference.blocks) assert.equal(bucket.objects.get(block.key), block.body, block.key);

  const manifest = JSON.parse(bucket.objects.get(PRODUCTION_MANIFEST_KEY));
  assert.equal(manifest.current.version, VERSION);
  assert.equal(manifest.current.total, reference.total);
  assert.equal(manifest.current.active_total, reference.active_total);
  assert.equal(manifest.current.total_detail_bytes, reference.total_detail_bytes);
  assert.equal(manifest.current.max_block_bytes, reference.max_block_bytes);

  // El staging de la corrida se limpia al terminar.
  assert.equal([...bucket.objects.keys()].some(key => key.startsWith(`${STAGED_ROOT}/`)), false);
});

test('conserva el manifest anterior como previous', async () => {
  const bucket = makeBucket();
  const previous = { schema_version: 1, current: { version: '20261119114156236' }, previous: null };
  bucket.objects.set(PRODUCTION_MANIFEST_KEY, JSON.stringify(previous));
  const { deps } = makeDeps(makeCatalogItems(300));
  const final = (await runAll(baseEnv(bucket), deps)).at(-1);
  assert.equal(final.published, true);
  assert.equal(final.paused_catalog.previous_version, '20261119114156236');
});

test('si falla la verificación con head, el manifest no cambia', async () => {
  const bucket = makeBucket({ failHeadFor: 'block-077.json' });
  const { deps } = makeDeps(makeCatalogItems(300));
  const results = await runAll(baseEnv(bucket), deps);
  const final = results.at(-1);
  assert.equal(final.status, 'error');
  assert.equal(final.published, false);
  assert.match(final.error, /block-077/);
  assert.equal(bucket.writes.some(write => write.key === PRODUCTION_MANIFEST_KEY), false);
});

test('una parte que falla se puede repetir y la corrida termina igual', async () => {
  const bucket = makeBucket();
  const items = makeCatalogItems(400);
  let failures = 1;
  const { deps } = makeDeps(items);
  const realFetch = deps.fetchSlimItemsFn;
  deps.fetchSlimItemsFn = async (ids, ...rest) => {
    if (failures-- > 0) throw new Error('[Catalog] HTTP 401 no reintentable');
    return realFetch(ids, ...rest);
  };
  const env = baseEnv(bucket);
  const start = await runStagedProductionCatalogStep(env, { step: 'start' }, deps);
  const failed = await runStagedProductionCatalogStep(env, { step: 'continue', runId: start.run_id }, deps);
  assert.equal(failed.status, 'error');
  assert.equal(failed.run_id, start.run_id);
  let result;
  for (let i = 0; i < 50; i++) {
    result = await runStagedProductionCatalogStep(env, { step: 'continue', runId: start.run_id }, deps);
    if (result.published || result.status === 'error') break;
  }
  assert.equal(result.published, true);
  assert.equal(result.paused_catalog.total, items.filter(item => item.status === 'paused').length);
});

test('no publica si hay menos activas que el mínimo', async () => {
  const bucket = makeBucket();
  const { deps } = makeDeps(makeCatalogItems(60));
  const final = (await runAll(baseEnv(bucket, { MIN_ACTIVE_ITEMS: '500' }), deps)).at(-1);
  assert.equal(final.status, 'error');
  assert.match(final.error, /mínimo requerido/);
  assert.equal(bucket.writes.some(write => write.key === PRODUCTION_MANIFEST_KEY), false);
});

test('sin el flag no escribe nada', async () => {
  const bucket = makeBucket();
  const { deps } = makeDeps(makeCatalogItems(60));
  const result = await runStagedProductionCatalogStep(
    { ...baseEnv(bucket), PRODUCTION_PAUSED_CATALOG_PUBLISH_ENABLED: 'false' },
    { step: 'start' },
    deps,
  );
  assert.equal(result.status, 'error');
  assert.equal(bucket.writes.length, 0);
});

test('rechaza corridas inexistentes o run inválido', async () => {
  const bucket = makeBucket();
  const { deps } = makeDeps(makeCatalogItems(60));
  const missing = await runStagedProductionCatalogStep(baseEnv(bucket), { step: 'continue', runId: '20990101000000000' }, deps);
  assert.equal(missing.status, 'error');
  const invalid = await runStagedProductionCatalogStep(baseEnv(bucket), { step: 'continue', runId: '../catalog' }, deps);
  assert.equal(invalid.status, 'error');
  assert.equal(bucket.writes.length, 0);
});

test('limpia staging de corridas viejas al arrancar, no el de corridas recientes', async () => {
  const bucket = makeBucket();
  bucket.objects.set(`${STAGED_ROOT}/20261120000000000/chunk-0000.json`, '{}');
  bucket.objects.set(`${STAGED_ROOT}/20261126070000000/chunk-0000.json`, '{}');
  bucket.objects.set('catalog/versions/20261119114156236/index.json', '{}');
  const { deps } = makeDeps(makeCatalogItems(60));
  const start = await runStagedProductionCatalogStep(baseEnv(bucket), { step: 'start' }, deps);
  assert.equal(start.status, 'staged');
  assert.equal(bucket.objects.has(`${STAGED_ROOT}/20261120000000000/chunk-0000.json`), false);
  assert.equal(bucket.objects.has(`${STAGED_ROOT}/20261126070000000/chunk-0000.json`), true);
  assert.equal(bucket.objects.has('catalog/versions/20261119114156236/index.json'), true);
});

test('el workflow llama a las partes en bucle y mantiene los controles del resultado final', () => {
  const workflow = readFileSync(path.join(ROOT, '.github', 'workflows', 'production-paused-catalog.yml'), 'utf8');
  assert.match(workflow, /\/publish-production-catalog\?\$query/);
  assert.match(workflow, /call_step "step=start"/);
  assert.match(workflow, /call_step "step=continue&run=\$RUN_ID"/);
  assert.match(workflow, /grep -q '"published":true'/);
  assert.match(workflow, /grep -q '"production_catalog_modified":false'/);
  assert.match(workflow, /grep -q '"key":"catalog\/manifest.json"'/);
  assert.match(workflow, /PRODUCTION_PAUSED_CATALOG_PUBLISH_ENABLED:true/);
});
