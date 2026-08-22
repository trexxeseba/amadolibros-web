import {
  BOOK_INTELLIGENCE_PREVIEW_OBJECT_RE,
  BOOK_INTELLIGENCE_PREVIEW_POINTER_KEY,
  validatePreviewBookIntelligenceManifest,
} from '../_shared/book-intelligence-enrichment-preview.js';

const TARGET_ID = 'MLU616917519';
const MAX_BYTES = 512 * 1024;

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

function hex(buffer) {
  return [...new Uint8Array(buffer)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') return json({ status: 'method_not_allowed' }, 405);
  if (context.env?.APP_ENV !== 'preview') return new Response('Not found', { status: 404 });

  const bucket = context.env?.CATALOG_BUCKET;
  if (!bucket || typeof bucket.get !== 'function') return json({ status: 'binding_missing' });

  try {
    const pointerObject = await bucket.get(BOOK_INTELLIGENCE_PREVIEW_POINTER_KEY);
    if (!pointerObject || typeof pointerObject.text !== 'function') return json({ status: 'pointer_missing' });

    const pointer = JSON.parse(await pointerObject.text());
    if (pointer?.schema_version !== 1 || pointer?.environment !== 'preview') return json({ status: 'pointer_invalid' });
    const objectKey = String(pointer?.current?.object_key || '');
    const keyMatch = BOOK_INTELLIGENCE_PREVIEW_OBJECT_RE.exec(objectKey);
    if (!keyMatch) return json({ status: 'object_key_invalid' });
    const declaredSha = String(pointer?.current?.sha256 || '').toLowerCase();
    if (declaredSha !== keyMatch[1]) return json({ status: 'pointer_sha_mismatch' });

    const object = await bucket.get(objectKey);
    if (!object || typeof object.arrayBuffer !== 'function') return json({ status: 'object_missing' });
    const bytes = await object.arrayBuffer();
    const expectedBytes = Number(pointer?.current?.bytes);
    if (!Number.isInteger(expectedBytes) || expectedBytes < 2 || expectedBytes > MAX_BYTES || bytes.byteLength !== expectedBytes) {
      return json({ status: 'size_mismatch' });
    }

    const actualSha = hex(await crypto.subtle.digest('SHA-256', bytes));
    if (actualSha !== declaredSha) return json({ status: 'sha_mismatch' });

    const manifest = JSON.parse(new TextDecoder().decode(bytes));
    if (!validatePreviewBookIntelligenceManifest(manifest)) return json({ status: 'manifest_invalid' });
    if (JSON.stringify(pointer.current?.counts) !== JSON.stringify(manifest.counts)) return json({ status: 'counts_mismatch' });

    const entry = manifest.entries.find(row => row.product_id === TARGET_ID) || null;
    if (!entry) return json({ status: 'entry_missing' });
    if (entry.decision !== 'auto_publish') return json({ status: 'entry_not_auto' });

    return json({
      status: 'ok',
      target: TARGET_ID,
      decision: 'auto_publish',
      total: manifest.counts.total,
      auto_publish: manifest.counts.auto_publish,
    });
  } catch {
    return json({ status: 'error' });
  }
}
