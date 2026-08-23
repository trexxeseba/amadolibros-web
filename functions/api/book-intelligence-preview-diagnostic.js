import {
  BOOK_INTELLIGENCE_PREVIEW_OBJECT_RE,
  BOOK_INTELLIGENCE_PREVIEW_POINTER_KEY,
  getPreviewBookIntelligenceEntry,
  validatePreviewBookIntelligenceManifest,
} from '../_shared/book-intelligence-enrichment-preview.js';
import { R2_DEV_BASE } from '../_shared/r2-access.js';

const TARGET_ID = 'MLU616917519';
const DIAG_VERSION = 'fv2-reader-diag-2';
const MAX_POINTER_BYTES = 16 * 1024;
const MAX_OBJECT_BYTES = 512 * 1024;

function json(body, status = 200) {
  return new Response(JSON.stringify({ diag_version: DIAG_VERSION, ...body }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

async function fetchProbe(key) {
  let response;
  try {
    response = await fetch(`${R2_DEV_BASE}/${key}`, {
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
    });
  } catch {
    return { status: 'fetch_error' };
  }
  return { status: `http_${response.status}`, ok: response.ok, response };
}

function validPointerShape(pointer) {
  if (!pointer || pointer.schema_version !== 1) return null;
  // #228 persiste el entorno por namespace, no por un campo environment.
  // Si una futura versión agrega el campo, sólo aceptamos preview.
  if (pointer.environment != null && pointer.environment !== 'preview') return null;
  const objectKey = String(pointer.current?.object_key || '').trim();
  const match = BOOK_INTELLIGENCE_PREVIEW_OBJECT_RE.exec(objectKey);
  if (!match) return null;
  const declaredSha = String(pointer.current?.sha256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(declaredSha) || declaredSha !== match[1]) return null;
  const bytes = Number(pointer.current?.bytes);
  if (!Number.isInteger(bytes) || bytes < 2 || bytes > MAX_OBJECT_BYTES) return null;
  return { objectKey, declaredSha, declaredBytes: bytes, pointer };
}

function countsEqual(a, b) {
  for (const key of ['total', 'auto_publish', 'review', 'hold']) {
    if (Number(a?.[key]) !== Number(b?.[key])) return false;
  }
  return true;
}
function bytesToHex(bytes) { return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join(''); }
async function sha256Hex(bytes) {
  const cryptoApi = globalThis.crypto?.subtle;
  if (!cryptoApi) return null;
  return bytesToHex(await cryptoApi.digest('SHA-256', bytes));
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') return json({ status: 'method_not_allowed' }, 405);
  if (context.env?.APP_ENV !== 'preview') return new Response('Not found', { status: 404 });

  const pointerProbe = await fetchProbe(BOOK_INTELLIGENCE_PREVIEW_POINTER_KEY);
  if (pointerProbe.status === 'fetch_error') return json({ status: 'pointer_fetch_error' });
  if (!pointerProbe.ok) return json({ status: `pointer_${pointerProbe.status}` });

  let pointerText;
  try { pointerText = await pointerProbe.response.text(); }
  catch { return json({ status: 'pointer_body_error' }); }
  if (!pointerText || new TextEncoder().encode(pointerText).byteLength > MAX_POINTER_BYTES) return json({ status: 'pointer_size_invalid' });

  let pointer;
  try { pointer = JSON.parse(pointerText); }
  catch { return json({ status: 'pointer_json_invalid' }); }
  const parsed = validPointerShape(pointer);
  if (!parsed) return json({ status: 'pointer_contract_invalid' });

  const objectProbe = await fetchProbe(parsed.objectKey);
  if (objectProbe.status === 'fetch_error') return json({ status: 'object_fetch_error' });
  if (!objectProbe.ok) return json({ status: `object_${objectProbe.status}` });

  let objectBytes;
  try { objectBytes = await objectProbe.response.arrayBuffer(); }
  catch { return json({ status: 'object_body_error' }); }
  if (objectBytes.byteLength > MAX_OBJECT_BYTES) return json({ status: 'object_too_large' });
  if (objectBytes.byteLength !== parsed.declaredBytes) return json({ status: 'object_size_mismatch', declared_bytes: parsed.declaredBytes, received_bytes: objectBytes.byteLength });

  const actualSha = await sha256Hex(objectBytes);
  if (!actualSha) return json({ status: 'crypto_unavailable' });
  if (actualSha !== parsed.declaredSha) return json({ status: 'object_sha_mismatch' });

  let manifest;
  try { manifest = JSON.parse(new TextDecoder().decode(objectBytes)); }
  catch { return json({ status: 'object_json_invalid' }); }
  if (!validatePreviewBookIntelligenceManifest(manifest)) return json({ status: 'manifest_invalid' });
  if (!countsEqual(parsed.pointer.current?.counts, manifest.counts)) return json({ status: 'pointer_counts_mismatch' });

  const directEntry = manifest.entries.find(row => row.product_id === TARGET_ID) || null;
  if (!directEntry || directEntry.decision !== 'auto_publish') return json({ status: 'green_entry_missing' });

  try {
    const entry = await getPreviewBookIntelligenceEntry(context.env, TARGET_ID);
    if (!entry) return json({ status: 'canonical_second_read_failed', transport: 'r2dev_read_only' });
    return json({
      status: 'ok', transport: 'r2dev_read_only', target: TARGET_ID,
      decision: entry.decision,
      topic_count: Array.isArray(entry.work?.topic_seeds) ? entry.work.topic_seeds.length : 0,
      edition_field_count: Object.keys(entry.edition?.auto_publishable_fields || {}).length,
    });
  } catch {
    return json({ status: 'reader_error' });
  }
}
