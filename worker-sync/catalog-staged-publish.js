/**
 * worker-sync/catalog-staged-publish.js
 *
 * Publicación del catálogo productivo (activo + pausado, prefijo catalog/*)
 * partida en varias invocaciones del Worker.
 *
 * Por qué: en una sola invocación había que traer ~17.000 publicaciones de
 * Mercado Libre, tenerlas todas en memoria (los cuerpos crudos de /items/bulk
 * con sus atributos pesan más de 200 MB) y después armar índices, gzip y 128
 * bloques. Cloudflare cortaba el pedido con "error code: 1102" (Worker
 * exceeded resource limits) y el manifest quedaba viejo.
 *
 * Fases (cada llamada hace una sola parte y guarda el estado en R2):
 *   start    → lista de IDs (scroll de ML), versión nueva, estado inicial.
 *   details  → un tramo de IDs por llamada: detalle de ML achicado lote a
 *              lote, galerías de ficha de catálogo y fichas verificadas;
 *              el tramo queda en staging/production-catalog/<run>/.
 *   index    → recorre los tramos de a uno, valida el catálogo completo y
 *              escribe active-index.json(.gz) e index.json(.gz).
 *   blocks   → un rango de bloques por llamada (block-NNN.json).
 *   finalize → verifica con head cada artefacto de la versión y, recién
 *              entonces, escribe catalog/manifest.json (el único puntero
 *              mutable). Si algo falla antes, el sitio sigue en la versión
 *              anterior.
 *
 * Nunca escribe catalog.json ni meta.json, y nunca escribe fuera de
 * catalog/versions/<versión>/, catalog/manifest.json y su propio staging.
 */

import { getAccessToken } from './meli-auth.js';
import {
  createDataQualitySummary,
  createSyncRetryBudget,
  enrichCatalogProductPictures,
  fetchAllIds,
  fetchSlimCatalogItems,
} from './meli-catalog.js';
import { applyVerifiedBookEnrichments } from './verified-book-enrichments.js';
import {
  activeIndexRow,
  assertValidVersion,
  blockFilename,
  blockNumberForId,
  buildActiveIndexBody,
  buildBlockBody,
  buildManifest,
  buildPausedIndexBody,
  byteLength,
  compareCatalogIds,
  gzipText,
  isActiveIndexItem,
  isPausedCatalogItem,
  pausedIndexRow,
  PAUSED_BLOCK_COUNT,
  PRODUCTION_MANIFEST_KEY,
  PRODUCTION_PREFIX_ROOT,
} from './paused-catalog.js';

export const STAGED_ROOT = 'staging/production-catalog';
export const DEFAULT_CHUNK_SIZE = 2000;
export const DEFAULT_BLOCKS_PER_STEP = 32;
const DEFAULT_GALLERY_ENRICH_LIMIT = 300;
const STALE_RUN_MS = 6 * 60 * 60 * 1000;
const SCOPE = 'production';
const ENABLED_FLAG = 'PRODUCTION_PAUSED_CATALOG_PUBLISH_ENABLED';
const FORBIDDEN_KEYS = new Set(['catalog.json', 'meta.json']);

function positiveInt(value, fallback) {
  const parsed = parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function runPrefix(runId) {
  return `${STAGED_ROOT}/${runId}`;
}

function stateKey(runId) {
  return `${runPrefix(runId)}/state.json`;
}

function chunkKey(runId, index) {
  return `${runPrefix(runId)}/chunk-${String(index).padStart(4, '0')}.json`;
}

function versionFromDate(date) {
  return date.toISOString().replace(/[^0-9]/g, '').slice(0, 17);
}

function assertWritableKey(key, state) {
  if (FORBIDDEN_KEYS.has(key)) throw new Error(`Clave prohibida para esta publicación: ${key}.`);
  const allowed = key === PRODUCTION_MANIFEST_KEY ||
    key.startsWith(`${STAGED_ROOT}/`) ||
    (state?.prefix && key.startsWith(`${state.prefix}/`));
  if (!allowed) throw new Error(`Clave fuera del catálogo productivo: ${key}.`);
}

async function readJson(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return null;
  return JSON.parse(await object.text());
}

async function putStaging(bucket, key, body) {
  assertWritableKey(key, null);
  await bucket.put(key, body, {
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
    customMetadata: { scope: SCOPE, publication: 'staging' },
  });
}

async function putImmutable(bucket, state, key, body, contentType) {
  assertWritableKey(key, state);
  await bucket.put(key, body, {
    httpMetadata: {
      contentType,
      cacheControl: 'public, max-age=31536000, immutable',
    },
    customMetadata: {
      scope: SCOPE,
      publication: 'immutable-version',
    },
  });
}

async function saveState(bucket, state) {
  state.updated_at = new Date().toISOString();
  await putStaging(bucket, stateKey(state.run_id), JSON.stringify(state));
}

async function deletePrefix(bucket, prefix) {
  if (typeof bucket.list !== 'function' || typeof bucket.delete !== 'function') return 0;
  let cursor;
  let deleted = 0;
  do {
    const page = await bucket.list({ prefix, cursor });
    const keys = (page?.objects || []).map(object => object.key)
      .filter(key => key.startsWith(`${STAGED_ROOT}/`));
    if (keys.length) {
      await bucket.delete(keys);
      deleted += keys.length;
    }
    cursor = page?.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}

// Corridas cortadas a la mitad (por ejemplo, un job cancelado) dejan tramos
// en staging. Se limpian al arrancar una corrida nueva si tienen más de 6 h:
// el workflow tiene concurrencia 1, así que no hay otra corrida viva.
async function cleanupStaleRuns(bucket, now) {
  if (typeof bucket.list !== 'function' || typeof bucket.delete !== 'function') return 0;
  try {
    const page = await bucket.list({ prefix: `${STAGED_ROOT}/`, delimiter: '/' });
    let deleted = 0;
    for (const prefix of page?.delimitedPrefixes || []) {
      const runId = prefix.slice(STAGED_ROOT.length + 1).replace(/\/$/, '');
      const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})$/.exec(runId);
      if (!match) continue;
      const startedAt = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6], +match[7]);
      if (now.getTime() - startedAt > STALE_RUN_MS) deleted += await deletePrefix(bucket, `${STAGED_ROOT}/${runId}/`);
    }
    return deleted;
  } catch (error) {
    console.warn(`[Staged catalog] Limpieza de staging pendiente: ${error.message}`);
    return 0;
  }
}

function errorResult(error, runId = null) {
  return {
    status: 'error',
    published: false,
    production_catalog_modified: false,
    key: PRODUCTION_MANIFEST_KEY,
    run_id: runId,
    error: String(error?.message || error || 'Error').slice(0, 400),
  };
}

function progressResult(state, extra = {}) {
  return {
    status: 'staged',
    published: false,
    production_catalog_modified: false,
    key: PRODUCTION_MANIFEST_KEY,
    run_id: state.run_id,
    version: state.version,
    phase: state.phase,
    done: false,
    chunks_done: state.chunks.length,
    chunks_total: state.chunks_total,
    blocks_done: state.blocks.length,
    block_count: state.block_count,
    ...extra,
  };
}

// ── Fases ────────────────────────────────────────────────────────────────────

async function startRun(env, deps) {
  const bucket = env.CATALOG_R2;
  const now = deps.now();
  const version = versionFromDate(now);
  const blockCount = PAUSED_BLOCK_COUNT;
  assertValidVersion(version, blockCount);

  const cleaned = await cleanupStaleRuns(bucket, now);
  const accessToken = await deps.getAccessTokenFn(env);
  const ids = await deps.fetchAllIdsFn(
    env.USER_ID,
    accessToken,
    ['active', 'paused'],
    createSyncRetryBudget(),
    deps.mlGetDeps,
  );
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('[Catalog] Scroll devolvió 0 IDs. Abortando para no publicar un catálogo vacío.');
  }

  const chunkSize = positiveInt(env.PRODUCTION_CATALOG_CHUNK_SIZE, DEFAULT_CHUNK_SIZE);
  const state = {
    schema_version: 1,
    run_id: version,
    version,
    prefix: `${PRODUCTION_PREFIX_ROOT}/${version}`,
    block_count: blockCount,
    phase: 'details',
    started_at: now.toISOString(),
    total_ids: ids.length,
    chunk_size: chunkSize,
    chunks_total: Math.ceil(ids.length / chunkSize),
    chunks: [],
    blocks: [],
    data_quality: {},
  };
  await putStaging(bucket, `${runPrefix(version)}/ids.json`, JSON.stringify(ids));
  await saveState(bucket, state);
  return progressResult(state, { total_ids: ids.length, stale_staging_deleted: cleaned });
}

async function detailsStep(env, state, deps) {
  const bucket = env.CATALOG_R2;
  const index = state.chunks.length;
  const ids = await readJson(bucket, `${runPrefix(state.run_id)}/ids.json`);
  if (!Array.isArray(ids) || ids.length !== state.total_ids) {
    throw new Error('Lista de IDs de la corrida ausente o alterada.');
  }
  const slice = ids.slice(index * state.chunk_size, (index + 1) * state.chunk_size);
  const accessToken = await deps.getAccessTokenFn(env);
  const retryBudget = createSyncRetryBudget();
  const dataQuality = createDataQualitySummary();
  const { items, excluded } = await deps.fetchSlimItemsFn(slice, accessToken, {
    retryBudget,
    mlGetDeps: deps.mlGetDeps,
    dataQuality,
  });

  // Galerías de ficha de catálogo: el tope de consultas por corrida se reparte
  // entre los tramos. La caché en R2 se guarda en cada tramo, así que los
  // siguientes reutilizan lo ya consultado.
  const totalLimit = positiveInt(env.ML_CATALOG_GALLERY_ENRICH_LIMIT, DEFAULT_GALLERY_ENRICH_LIMIT);
  const chunkLimit = Math.ceil(totalLimit / Math.max(1, state.chunks_total));
  const galleries = await deps.enrichPicturesFn(
    items,
    { ...env, ML_CATALOG_GALLERY_ENRICH_LIMIT: String(chunkLimit) },
    accessToken,
    { retryBudget, mlGetDeps: deps.mlGetDeps },
  );
  const verified = applyVerifiedBookEnrichments(items);

  const body = JSON.stringify({ schema_version: 1, run_id: state.run_id, index, items });
  const key = chunkKey(state.run_id, index);
  await putStaging(bucket, key, body);
  state.chunks.push({ index, key, ids: slice.length, items: items.length, excluded, bytes: byteLength(body) });
  state.data_quality.catalog_product_galleries = sumGalleries(state.data_quality.catalog_product_galleries, galleries);
  state.data_quality.verified_book_enrichments = sumCounts(state.data_quality.verified_book_enrichments, verified);
  if (state.chunks.length >= state.chunks_total) state.phase = 'index';
  await saveState(bucket, state);
  return progressResult(state, { chunk: index, chunk_items: items.length });
}

function sumCounts(previous, next) {
  if (!next || typeof next !== 'object') return previous || null;
  const result = { ...(previous || {}) };
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === 'number') result[key] = (Number(result[key]) || 0) + value;
  }
  return result;
}

function sumGalleries(previous, next) {
  if (!next) return previous || null;
  const result = sumCounts(previous, {
    fetched: next.fetched,
    failed: next.failed,
    reused: next.reused,
    descriptions_from_product: next.descriptions_from_product,
    multiple_image_galleries: next.multiple_image_galleries,
  });
  if (next.cache_write_error) result.cache_write_error = next.cache_write_error;
  return result;
}

async function forEachChunk(bucket, state, fn) {
  for (const chunk of state.chunks) {
    const payload = await readJson(bucket, chunk.key);
    if (!payload || payload.run_id !== state.run_id || !Array.isArray(payload.items) ||
        payload.items.length !== chunk.items) {
      throw new Error(`Tramo ${chunk.index} ausente o alterado en staging.`);
    }
    for (const item of payload.items) fn(item);
  }
}

async function indexStep(env, state) {
  const bucket = env.CATALOG_R2;
  const seen = new Set();
  const pausedRows = [];
  const activeRows = [];
  const counts = { total: 0, active: 0, paused: 0, active_without_stock: 0, duplicate_ids: 0, invalid: 0 };
  let samplePaused = null;

  await forEachChunk(bucket, state, item => {
    counts.total++;
    if (!item.id || !item.title || !['active', 'paused'].includes(item.status)) counts.invalid++;
    if (item.id) {
      if (seen.has(item.id)) counts.duplicate_ids++;
      seen.add(item.id);
    }
    if (item.status === 'active' && Number(item.available_quantity) > 0) counts.active++;
    if (item.status === 'active' && Number(item.available_quantity) <= 0) counts.active_without_stock++;
    if (isPausedCatalogItem(item)) {
      counts.paused++;
      pausedRows.push(pausedIndexRow(item));
      if (!samplePaused) samplePaused = { id: item.id, title: item.title };
    }
    if (isActiveIndexItem(item)) activeRows.push(activeIndexRow(item));
  });

  if (counts.invalid > 0 || counts.duplicate_ids > 0 || counts.paused === 0) {
    throw new Error(
      `Catálogo Production inválido: paused=${counts.paused}, ` +
      `duplicate_ids=${counts.duplicate_ids}, invalid=${counts.invalid}.`
    );
  }
  const minActiveItems = parseInt(env.MIN_ACTIVE_ITEMS || '500', 10);
  if (counts.active < minActiveItems) {
    throw new Error(
      `[Catalog] Solo ${counts.active} items activos — mínimo requerido: ${minActiveItems}. ` +
      'Abortando para conservar el manifest anterior.'
    );
  }
  if (activeRows.length === 0) throw new Error('No hay publicaciones activas para indexar.');

  pausedRows.sort((a, b) => compareCatalogIds(a[0], b[0]));
  activeRows.sort((a, b) => compareCatalogIds(a[0], b[0]));
  const activeBody = buildActiveIndexBody(activeRows);
  const pausedBody = buildPausedIndexBody(pausedRows, state.block_count);
  const [activeGzip, pausedGzip] = await Promise.all([gzipText(activeBody), gzipText(pausedBody)]);

  const activeKey = `${state.prefix}/active-index.json`;
  const pausedKey = `${state.prefix}/index.json`;
  await putImmutable(bucket, state, activeKey, activeBody, 'application/json');
  await putImmutable(bucket, state, `${activeKey}.gz`, activeGzip, 'application/gzip');
  await putImmutable(bucket, state, pausedKey, pausedBody, 'application/json');
  await putImmutable(bucket, state, `${pausedKey}.gz`, pausedGzip, 'application/gzip');

  const bytes = state.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
  state.summary = { ...counts, bytes, mebibytes: Math.round((bytes / 1024 / 1024) * 100) / 100 };
  state.sample_paused = samplePaused;
  state.active_index = {
    key: activeKey,
    bytes: byteLength(activeBody),
    gzip_key: `${activeKey}.gz`,
    gzip_bytes: activeGzip.byteLength,
    total: activeRows.length,
  };
  state.index = {
    key: pausedKey,
    bytes: byteLength(pausedBody),
    gzip_key: `${pausedKey}.gz`,
    gzip_bytes: pausedGzip.byteLength,
    total: pausedRows.length,
  };
  state.phase = 'blocks';
  await saveState(bucket, state);
  return progressResult(state, { paused_total: pausedRows.length, active_total: activeRows.length });
}

async function blocksStep(env, state) {
  const bucket = env.CATALOG_R2;
  const perStep = positiveInt(env.PRODUCTION_CATALOG_BLOCKS_PER_STEP, DEFAULT_BLOCKS_PER_STEP);
  const from = state.blocks.length;
  const to = Math.min(state.block_count, from + perStep);
  const groups = Array.from({ length: to - from }, () => []);

  await forEachChunk(bucket, state, item => {
    if (!isPausedCatalogItem(item)) return;
    const block = blockNumberForId(item.id, state.block_count);
    if (block >= from && block < to) groups[block - from].push(item);
  });

  for (let offset = 0; offset < groups.length; offset++) {
    const block = from + offset;
    const items = groups[offset].sort((a, b) => compareCatalogIds(a.id, b.id));
    const body = buildBlockBody(state.version, block, items);
    const key = `${state.prefix}/${blockFilename(block)}`;
    await putImmutable(bucket, state, key, body, 'application/json');
    state.blocks.push({ block, key, bytes: byteLength(body), total: items.length });
    groups[offset] = null;
  }
  if (state.blocks.length >= state.block_count) state.phase = 'finalize';
  await saveState(bucket, state);
  return progressResult(state, { blocks_written: `${from}-${to - 1}` });
}

function artifactsFromState(state) {
  const blockBytes = state.blocks.map(block => block.bytes);
  return {
    version: state.version,
    prefix: state.prefix,
    total: state.index.total,
    block_count: state.block_count,
    index: state.index,
    active_index: state.active_index,
    max_block_bytes: Math.max(...blockBytes),
    total_detail_bytes: blockBytes.reduce((sum, bytes) => sum + bytes, 0),
  };
}

async function verifyArtifacts(bucket, state) {
  if (typeof bucket.head !== 'function') {
    throw new Error('CATALOG_R2.head no está disponible para verificar publicación.');
  }
  const pausedInBlocks = state.blocks.reduce((sum, block) => sum + block.total, 0);
  if (state.blocks.length !== state.block_count || pausedInBlocks !== state.index.total) {
    throw new Error(
      `Bloques incompletos: ${state.blocks.length}/${state.block_count} bloques, ` +
      `${pausedInBlocks}/${state.index.total} pausadas.`
    );
  }
  const expected = [
    { key: state.active_index.key, bytes: state.active_index.bytes },
    { key: state.active_index.gzip_key, bytes: state.active_index.gzip_bytes },
    { key: state.index.key, bytes: state.index.bytes },
    { key: state.index.gzip_key, bytes: state.index.gzip_bytes },
    ...state.blocks.map(block => ({ key: block.key, bytes: block.bytes })),
  ];
  for (const artifact of expected) {
    const object = await bucket.head(artifact.key);
    if (!object || Number(object.size) !== artifact.bytes) {
      throw new Error(
        `Verificación R2 falló para ${artifact.key}: ` +
        `esperado=${artifact.bytes}, recibido=${object?.size ?? 'null'}.`
      );
    }
  }
}

async function readPreviousManifest(bucket) {
  try {
    const parsed = await readJson(bucket, PRODUCTION_MANIFEST_KEY);
    return parsed?.schema_version === 1 ? parsed : null;
  } catch (error) {
    console.warn(`[Staged catalog] No se pudo leer manifest anterior: ${error.message}`);
    return null;
  }
}

async function finalizeStep(env, state) {
  const bucket = env.CATALOG_R2;
  await verifyArtifacts(bucket, state);
  const artifacts = artifactsFromState(state);
  const previousManifest = await readPreviousManifest(bucket);
  const manifest = buildManifest(artifacts, previousManifest);

  // El manifest es el único puntero mutable y se escribe último, después de
  // verificar cada artefacto de la versión nueva.
  assertWritableKey(PRODUCTION_MANIFEST_KEY, state);
  await bucket.put(PRODUCTION_MANIFEST_KEY, JSON.stringify(manifest), {
    httpMetadata: {
      contentType: 'application/json',
      cacheControl: 'public, max-age=60',
    },
    customMetadata: {
      scope: SCOPE,
      publication: 'atomic-pointer',
    },
  });

  let stagingDeleted = 0;
  try {
    stagingDeleted = await deletePrefix(bucket, `${runPrefix(state.run_id)}/`);
  } catch (error) {
    console.warn(`[Staged catalog] Staging sin limpiar: ${error.message}`);
  }

  return {
    status: 'published-production',
    published: true,
    done: true,
    production_catalog_modified: false,
    key: PRODUCTION_MANIFEST_KEY,
    run_id: state.run_id,
    checked_at: new Date().toISOString(),
    catalog: state.summary,
    paused_catalog: {
      version: artifacts.version,
      total: artifacts.total,
      index_bytes: artifacts.index.bytes,
      index_gzip_bytes: artifacts.index.gzip_bytes,
      block_count: artifacts.block_count,
      max_block_bytes: artifacts.max_block_bytes,
      total_detail_bytes: artifacts.total_detail_bytes,
      previous_version: manifest.previous?.version || null,
    },
    active_catalog: {
      total: artifacts.active_index.total,
      index_bytes: artifacts.active_index.bytes,
      index_gzip_bytes: artifacts.active_index.gzip_bytes,
    },
    data_quality: state.data_quality || null,
    cover_mirror: { status: 'delegated-to-cron', cron: '*/5 * * * *' },
    sample_paused: state.sample_paused || null,
    staging_deleted: stagingDeleted,
  };
}

const PHASES = {
  details: detailsStep,
  index: indexStep,
  blocks: blocksStep,
  finalize: finalizeStep,
};

/**
 * Una llamada = una parte. `step: 'start'` crea la corrida; `step: 'continue'`
 * con su `runId` avanza la fase que corresponda según el estado guardado.
 * Repetir un `continue` que falló rehace la misma parte (las claves son
 * deterministas), sin saltear nada.
 */
export async function runStagedProductionCatalogStep(env, { step, runId } = {}, {
  getAccessTokenFn = getAccessToken,
  fetchAllIdsFn = fetchAllIds,
  fetchSlimItemsFn = fetchSlimCatalogItems,
  enrichPicturesFn = enrichCatalogProductPictures,
  mlGetDeps = {},
  now = () => new Date(),
} = {}) {
  if (String(env?.[ENABLED_FLAG]) !== 'true') {
    return errorResult('Production catalog publishing is disabled.', runId || null);
  }
  const bucket = env?.CATALOG_R2;
  if (!bucket || typeof bucket.put !== 'function' || typeof bucket.get !== 'function') {
    return errorResult('CATALOG_R2 binding is unavailable.', runId || null);
  }
  const deps = { getAccessTokenFn, fetchAllIdsFn, fetchSlimItemsFn, enrichPicturesFn, mlGetDeps, now };

  try {
    if (step === 'start') return await startRun(env, deps);
    if (step !== 'continue') throw new Error('step debe ser start o continue.');
    if (!/^\d{17}$/.test(String(runId || ''))) throw new Error('run inválido.');
    const state = await readJson(bucket, stateKey(runId));
    if (!state || state.schema_version !== 1 || state.run_id !== runId) {
      throw new Error(`No existe la corrida ${runId} en staging.`);
    }
    const phase = PHASES[state.phase];
    if (!phase) throw new Error(`Fase desconocida: ${state.phase}.`);
    return await phase(env, state, deps);
  } catch (error) {
    console.error(`[Staged catalog] Error: ${error.message}`);
    return errorResult(error, runId || null);
  }
}
