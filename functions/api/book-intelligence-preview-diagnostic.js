import {
  BOOK_INTELLIGENCE_PREVIEW_OBJECT_RE,
  BOOK_INTELLIGENCE_PREVIEW_POINTER_KEY,
  getPreviewBookIntelligenceEntry,
} from '../_shared/book-intelligence-enrichment-preview.js';
import { R2_DEV_BASE } from '../_shared/r2-access.js';

const TARGET_ID = 'MLU616917519';
const MAX_POINTER_BYTES = 16 * 1024;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
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
  return {
    status: `http_${response.status}`,
    ok: response.ok,
    response,
  };
}

function validPointerShape(pointer) {
  if (!pointer || pointer.schema_version !== 1 || pointer.environment !== 'preview') return null;
  const objectKey = String(pointer.current?.object_key || '').trim();
  const match = BOOK_INTELLIGENCE_PREVIEW_OBJECT_RE.exec(objectKey);
  if (!match) return null;
  const declaredSha = String(pointer.current?.sha256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(declaredSha) || declaredSha !== match[1]) return null;
  const bytes = Number(pointer.current?.bytes);
  if (!Number.isInteger(bytes) || bytes < 2 || bytes > 512 * 1024) return null;
  return { objectKey };
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') return json({ status: 'method_not_allowed' }, 405);
  if (context.env?.APP_ENV !== 'preview') return new Response('Not found', { status: 404 });

  const pointerProbe = await fetchProbe(BOOK_INTELLIGENCE_PREVIEW_POINTER_KEY);
  if (pointerProbe.status === 'fetch_error') return json({ status: 'pointer_fetch_error' });
  if (!pointerProbe.ok) return json({ status: `pointer_${pointerProbe.status}` });

  let pointerText;
  try {
    pointerText = await pointerProbe.response.text();
  } catch {
    return json({ status: 'pointer_body_error' });
  }
  if (!pointerText || new TextEncoder().encode(pointerText).byteLength > MAX_POINTER_BYTES) {
    return json({ status: 'pointer_size_invalid' });
  }

  let pointer;
  try {
    pointer = JSON.parse(pointerText);
  } catch {
    return json({ status: 'pointer_json_invalid' });
  }
  const parsed = validPointerShape(pointer);
  if (!parsed) return json({ status: 'pointer_contract_invalid' });

  const objectProbe = await fetchProbe(parsed.objectKey);
  if (objectProbe.status === 'fetch_error') return json({ status: 'object_fetch_error' });
  if (!objectProbe.ok) return json({ status: `object_${objectProbe.status}` });

  try {
    await objectProbe.response.body?.cancel();
  } catch {
    // Sólo diagnóstico de transporte; el reader canónico valida bytes y SHA abajo.
  }

  try {
    const entry = await getPreviewBookIntelligenceEntry(context.env, TARGET_ID);
    if (!entry) return json({ status: 'reader_validation_failed', transport: 'r2dev_read_only' });
    return json({
      status: 'ok',
      transport: 'r2dev_read_only',
      target: TARGET_ID,
      decision: entry.decision,
      topic_count: Array.isArray(entry.work?.topic_seeds) ? entry.work.topic_seeds.length : 0,
      edition_field_count: Object.keys(entry.edition?.auto_publishable_fields || {}).length,
    });
  } catch {
    return json({ status: 'reader_error' });
  }
}
