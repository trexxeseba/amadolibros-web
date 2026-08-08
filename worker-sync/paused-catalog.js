const DEFAULT_BLOCK_COUNT = 128;
const INDEX_FIELDS = ['id', 'title', 'author', 'isbn', 'image'];
const ACTIVE_INDEX_FIELDS = [
  'id',
  'title',
  'author',
  'isbn',
  'image',
  'price',
  'available_quantity',
];

function slugify(text) {
  return (text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
}

function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

async function gzipText(value) {
  const input = new TextEncoder().encode(value);
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function blockNumberForId(id, blockCount = DEFAULT_BLOCK_COUNT) {
  const digits = String(id || '').replace(/\D/g, '');
  if (!digits || !Number.isInteger(blockCount) || blockCount < 1) return 0;
  let remainder = 0;
  for (const digit of digits) remainder = ((remainder * 10) + Number(digit)) % blockCount;
  return remainder;
}

export function blockFilename(blockNumber) {
  return `block-${String(blockNumber).padStart(3, '0')}.json`;
}

export function buildPausedCatalogArtifacts(catalog, {
  blockCount = DEFAULT_BLOCK_COUNT,
  version = String(catalog?.updated_at || new Date().toISOString())
    .replace(/[^0-9]/g, '')
    .slice(0, 17),
  // CF-R2-2-BRIDGE: Preview y producción publican bajo prefijos de R2
  // completamente distintos — nunca deben poder pisarse ni confundirse.
  prefixRoot = 'stock1-preview/versions',
} = {}) {
  const paused = (Array.isArray(catalog?.items) ? catalog.items : [])
    .filter(item => item?.status === 'paused')
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const active = (Array.isArray(catalog?.items) ? catalog.items : [])
    .filter(item => item?.status === 'active' && Number(item.available_quantity) > 0)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  if (paused.length === 0) throw new Error('No hay publicaciones pausadas para versionar.');
  if (active.length === 0) throw new Error('No hay publicaciones activas para indexar.');
  if (!/^\d{14,17}$/.test(version)) throw new Error('Versión de catálogo pausado inválida.');
  if (!Number.isInteger(blockCount) || blockCount < 64 || blockCount > 256) {
    throw new Error('blockCount debe estar entre 64 y 256.');
  }

  const blocks = Array.from({ length: blockCount }, () => []);
  const indexRows = [];
  for (const item of paused) {
    const block = blockNumberForId(item.id, blockCount);
    blocks[block].push(item);
    indexRows.push([
      item.id,
      item.title || '',
      item.author || '',
      item.isbn || '',
      item.pictures?.[0] || item.thumbnail || '',
    ]);
  }

  const prefix = `${prefixRoot}/${version}`;
  const activeIndexRows = active.map(item => [
    item.id,
    item.title || '',
    item.author || '',
    item.isbn || '',
    item.pictures?.[0] || item.thumbnail || '',
    Number(item.price) || 0,
    Number(item.available_quantity) || 0,
  ]);
  const activeIndexBody = JSON.stringify({
    schema_version: 1,
    fields: ACTIVE_INDEX_FIELDS,
    derived_fields: {
      slug: 'slugify-v1',
      status: 'active',
    },
    total: activeIndexRows.length,
    items: activeIndexRows,
  });
  const indexBody = JSON.stringify({
    schema_version: 1,
    fields: INDEX_FIELDS,
    derived_fields: {
      slug: 'slugify-v1',
      status: 'paused',
      block: 'numeric-id-mod-block-count',
    },
    block_count: blockCount,
    total: indexRows.length,
    items: indexRows,
  });
  const blockArtifacts = blocks.map((items, block) => {
    const body = JSON.stringify({
      schema_version: 1,
      version,
      block,
      total: items.length,
      items,
    });
    return {
      block,
      key: `${prefix}/${blockFilename(block)}`,
      body,
      bytes: byteLength(body),
      total: items.length,
    };
  });

  return {
    version,
    prefix,
    total: paused.length,
    block_count: blockCount,
    active_total: active.length,
    index: {
      key: `${prefix}/index.json`,
      body: indexBody,
      bytes: byteLength(indexBody),
    },
    active_index: {
      key: `${prefix}/active-index.json`,
      body: activeIndexBody,
      bytes: byteLength(activeIndexBody),
      total: active.length,
    },
    blocks: blockArtifacts,
    max_block_bytes: Math.max(...blockArtifacts.map(block => block.bytes)),
    total_detail_bytes: blockArtifacts.reduce((sum, block) => sum + block.bytes, 0),
  };
}

export async function addCompressedIndexes(artifacts) {
  const [activeBody, pausedBody] = await Promise.all([
    gzipText(artifacts.active_index.body),
    gzipText(artifacts.index.body),
  ]);
  return {
    ...artifacts,
    active_index: {
      ...artifacts.active_index,
      gzip_key: `${artifacts.active_index.key}.gz`,
      gzip_body: activeBody,
      gzip_bytes: activeBody.byteLength,
    },
    index: {
      ...artifacts.index,
      gzip_key: `${artifacts.index.key}.gz`,
      gzip_body: pausedBody,
      gzip_bytes: pausedBody.byteLength,
    },
  };
}

export function versionDescriptor(artifacts) {
  return {
    version: artifacts.version,
    total: artifacts.total,
    block_count: artifacts.block_count,
    index_key: artifacts.index.key,
    index_bytes: artifacts.index.bytes,
    index_gzip_key: artifacts.index.gzip_key,
    index_gzip_bytes: artifacts.index.gzip_bytes,
    active_index_key: artifacts.active_index.key,
    active_index_bytes: artifacts.active_index.bytes,
    active_index_gzip_key: artifacts.active_index.gzip_key,
    active_index_gzip_bytes: artifacts.active_index.gzip_bytes,
    active_total: artifacts.active_index.total,
    block_prefix: artifacts.prefix,
    max_block_bytes: artifacts.max_block_bytes,
    total_detail_bytes: artifacts.total_detail_bytes,
  };
}

export function buildManifest(artifacts, previousManifest, generatedAt = new Date().toISOString()) {
  const priorCurrent = previousManifest?.current;
  const previous = priorCurrent && priorCurrent.version !== artifacts.version
    ? priorCurrent
    : previousManifest?.previous || null;
  return {
    schema_version: 1,
    generated_at: generatedAt,
    current: versionDescriptor(artifacts),
    previous,
  };
}

export const PAUSED_MANIFEST_KEY = 'stock1-preview/manifest.json';
export const PAUSED_PREFIX_ROOT = 'stock1-preview/versions';
// CF-R2-2-BRIDGE: prefijo y manifest productivos — nunca 'stock1-preview/*'.
export const PRODUCTION_MANIFEST_KEY = 'catalog/manifest.json';
export const PRODUCTION_PREFIX_ROOT = 'catalog/versions';
export const PAUSED_BLOCK_COUNT = DEFAULT_BLOCK_COUNT;
