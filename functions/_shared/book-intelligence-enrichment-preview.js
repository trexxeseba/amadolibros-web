// FICHAS-VIDRIERA-2 / PREVIEW-READER-GREEN-1
//
// Lector runtime estrictamente Preview-only del manifest persistido en R2.
// Usa el acceso HTTP read-only r2.dev que el repo ya emplea para catálogo,
// evitando adjuntar un binding R2 nativo a todos los Pages Preview.
//
// Valida namespace, SHA del puntero, SHA real de bytes, schema editorial y
// decisión auto_publish. Todo fallo es fail-open: devuelve null.

import { R2_DEV_BASE } from './r2-access.js';

export const BOOK_INTELLIGENCE_PREVIEW_POINTER_KEY = 'book-intelligence/preview/v1/manifest.json';
export const BOOK_INTELLIGENCE_PREVIEW_OBJECT_RE = /^book-intelligence\/preview\/v1\/objects\/([a-f0-9]{64})\.json$/;

const DECISIONS = new Set(['auto_publish', 'review', 'hold']);
const FORBIDDEN_KEYS = new Set(['description', 'summary', 'author_context']);
const MAX_MANIFEST_BYTES = 512 * 1024;

function clean(value) { return String(value ?? '').trim(); }
function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}
async function sha256Hex(bytes) {
  const cryptoApi = globalThis.crypto?.subtle;
  if (!cryptoApi) throw new Error('crypto.subtle no disponible.');
  return bytesToHex(await cryptoApi.digest('SHA-256', bytes));
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
    if (entry.work.topic_seeds.length > 0 || entry.work.audience_seed) return false;
    if (Object.keys(entry.edition.auto_publishable_fields).length > 0) return false;
  }
  if (entry.decision === 'auto_publish' && !entry.work.auto_publish) return false;
  return true;
}
export function validatePreviewBookIntelligenceManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false;
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length < 1) return false;
  if (!saneCounts(manifest.counts, manifest.entries.length) || containsForbiddenKeys(manifest)) return false;
  const ids = new Set();
  for (const entry of manifest.entries) {
    if (!validEntry(entry) || ids.has(entry.product_id)) return false;
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
async function fetchBytes(key, fetchImpl) {
  const response = await fetchImpl(`${R2_DEV_BASE}/${key}`, {
    headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
  });
  if (!response?.ok || typeof response.arrayBuffer !== 'function') return null;
  const bytes = await response.arrayBuffer();
  return bytes.byteLength <= MAX_MANIFEST_BYTES ? bytes : null;
}
async function loadManifest(env, fetchImpl) {
  if (env?.APP_ENV !== 'preview' || typeof fetchImpl !== 'function') return null;
  const pointerBytes = await fetchBytes(BOOK_INTELLIGENCE_PREVIEW_POINTER_KEY, fetchImpl);
  if (!pointerBytes) return null;
  const parsedPointer = parsePointer(new TextDecoder().decode(pointerBytes));
  if (!parsedPointer) return null;

  const bytes = await fetchBytes(parsedPointer.key, fetchImpl);
  if (!bytes || bytes.byteLength !== parsedPointer.bytes) return null;
  if (await sha256Hex(bytes) !== parsedPointer.sha) return null;

  const manifest = JSON.parse(new TextDecoder().decode(bytes));
  if (!validatePreviewBookIntelligenceManifest(manifest)) return null;
  if (!saneCounts(parsedPointer.pointer.current?.counts, manifest.entries.length)) return null;
  if (JSON.stringify(parsedPointer.pointer.current.counts) !== JSON.stringify(manifest.counts)) return null;
  return manifest;
}
export async function getPreviewBookIntelligenceEntry(env, productId, { fetchImpl = globalThis.fetch } = {}) {
  if (env?.APP_ENV !== 'preview') return null;
  const id = clean(productId).toUpperCase();
  if (!/^MLU\d+$/.test(id)) return null;
  try {
    const manifest = await loadManifest(env, fetchImpl);
    const entry = manifest?.entries?.find(row => row.product_id === id) || null;
    return entry?.decision === 'auto_publish' ? entry : null;
  } catch {
    return null;
  }
}
