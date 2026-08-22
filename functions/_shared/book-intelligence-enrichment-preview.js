// FICHAS-VIDRIERA-2 / PREVIEW-READER-GREEN-1
//
// Lector runtime estrictamente Preview-only del manifest persistido en R2.
// Producción corta antes de tocar cualquier binding. El lector valida:
// - namespace del puntero;
// - SHA declarado vs object key;
// - SHA real de los bytes;
// - contrato editorial mínimo del manifest;
// - decisión auto_publish para el producto pedido.
//
// Todo fallo es fail-open: devuelve null y la ficha sigue igual.

export const BOOK_INTELLIGENCE_PREVIEW_POINTER_KEY = 'book-intelligence/preview/v1/manifest.json';
export const BOOK_INTELLIGENCE_PREVIEW_OBJECT_RE = /^book-intelligence\/preview\/v1\/objects\/([a-f0-9]{64})\.json$/;

const DECISIONS = new Set(['auto_publish', 'review', 'hold']);
const FORBIDDEN_KEYS = new Set(['description', 'summary', 'author_context']);
const MAX_MANIFEST_BYTES = 512 * 1024;

function clean(value) {
  return String(value ?? '').trim();
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(bytes) {
  const cryptoApi = globalThis.crypto?.subtle;
  if (!cryptoApi) throw new Error('crypto.subtle no disponible.');
  return bytesToHex(await cryptoApi.digest('SHA-256', bytes));
}

async function objectBytes(object) {
  if (!object) return null;
  if (typeof object.arrayBuffer === 'function') {
    return await object.arrayBuffer();
  }
  if (typeof object.text === 'function') {
    return new TextEncoder().encode(await object.text()).buffer;
  }
  return null;
}

function containsForbiddenKeys(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsForbiddenKeys);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(String(key).toLowerCase())) return true;
    if (containsForbiddenKeys(child)) return true;
  }
  return false;
}

function saneCounts(counts, total) {
  if (!counts || typeof counts !== 'object') return false;
  const values = ['total', 'auto_publish', 'review', 'hold'].map(key => Number(counts[key]));
  if (!values.every(value => Number.isInteger(value) && value >= 0)) return false;
  const [countTotal, autoPublish, review, hold] = values;
  return countTotal === total && autoPublish + review + hold === total;
}

function validEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (!/^MLU\d+$/.test(clean(entry.product_id))) return false;
  if (!DECISIONS.has(entry.decision)) return false;
  if (!entry.work || typeof entry.work !== 'object') return false;
  if (!entry.edition || typeof entry.edition !== 'object') return false;
  if (!Array.isArray(entry.work.topic_seeds)) return false;
  if (!entry.edition.auto_publishable_fields || typeof entry.edition.auto_publishable_fields !== 'object') return false;
  if (containsForbiddenKeys(entry)) return false;
  if (entry.decision === 'hold') {
    if (entry.work.topic_seeds.length > 0) return false;
    if (entry.work.audience_seed) return false;
    if (Object.keys(entry.edition.auto_publishable_fields).length > 0) return false;
  }
  if (entry.decision === 'auto_publish' && !entry.work.auto_publish) return false;
  return true;
}

export function validatePreviewBookIntelligenceManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false;
  if (manifest.schema_version !== 1) return false;
  if (!Array.isArray(manifest.entries) || manifest.entries.length < 1) return false;
  if (!saneCounts(manifest.counts, manifest.entries.length)) return false;
  if (containsForbiddenKeys(manifest)) return false;
  const ids = new Set();
  for (const entry of manifest.entries) {
    if (!validEntry(entry)) return false;
    if (ids.has(entry.product_id)) return false;
    ids.add(entry.product_id);
  }
  return true;
}

function parsePointer(raw) {
  const pointer = JSON.parse(raw);
  if (!pointer || pointer.schema_version !== 1 || pointer.environment !== 'preview') return null;
  const key = clean(pointer.current?.object_key);
  const match = BOOK_INTELLIGENCE_PREVIEW_OBJECT_RE.exec(key);
  if (!match) return null;
  const sha = clean(pointer.current?.sha256).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha) || sha !== match[1]) return null;
  const bytes = Number(pointer.current?.bytes);
  if (!Number.isInteger(bytes) || bytes < 2 || bytes > MAX_MANIFEST_BYTES) return null;
  return { pointer, key, sha, bytes };
}

async function loadManifest(env) {
  if (env?.APP_ENV !== 'preview') return null;
  const bucket = env?.CATALOG_BUCKET;
  if (!bucket || typeof bucket.get !== 'function') return null;

  const pointerObject = await bucket.get(BOOK_INTELLIGENCE_PREVIEW_POINTER_KEY);
  if (!pointerObject || typeof pointerObject.text !== 'function') return null;
  const parsedPointer = parsePointer(await pointerObject.text());
  if (!parsedPointer) return null;

  const object = await bucket.get(parsedPointer.key);
  const bytes = await objectBytes(object);
  if (!bytes || bytes.byteLength !== parsedPointer.bytes || bytes.byteLength > MAX_MANIFEST_BYTES) return null;
  const actualSha = await sha256Hex(bytes);
  if (actualSha !== parsedPointer.sha) return null;

  const manifest = JSON.parse(new TextDecoder().decode(bytes));
  if (!validatePreviewBookIntelligenceManifest(manifest)) return null;
  if (!saneCounts(parsedPointer.pointer.current?.counts, manifest.entries.length)) return null;
  if (JSON.stringify(parsedPointer.pointer.current.counts) !== JSON.stringify(manifest.counts)) return null;
  return manifest;
}

export async function getPreviewBookIntelligenceEntry(env, productId) {
  if (env?.APP_ENV !== 'preview') return null;
  const id = clean(productId).toUpperCase();
  if (!/^MLU\d+$/.test(id)) return null;
  try {
    const manifest = await loadManifest(env);
    if (!manifest) return null;
    const entry = manifest.entries.find(row => row.product_id === id) || null;
    return entry?.decision === 'auto_publish' ? entry : null;
  } catch {
    return null;
  }
}
