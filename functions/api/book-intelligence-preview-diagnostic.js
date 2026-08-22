import { getPreviewBookIntelligenceEntry } from '../_shared/book-intelligence-enrichment-preview.js';

const TARGET_ID = 'MLU616917519';

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

export async function onRequest(context) {
  if (context.request.method !== 'GET') return json({ status: 'method_not_allowed' }, 405);
  if (context.env?.APP_ENV !== 'preview') return new Response('Not found', { status: 404 });
  try {
    const entry = await getPreviewBookIntelligenceEntry(context.env, TARGET_ID);
    if (!entry) return json({ status: 'r2dev_reader_unavailable' });
    return json({
      status: 'ok',
      transport: 'r2dev_read_only',
      target: TARGET_ID,
      decision: entry.decision,
      topic_count: Array.isArray(entry.work?.topic_seeds) ? entry.work.topic_seeds.length : 0,
      edition_field_count: Object.keys(entry.edition?.auto_publishable_fields || {}).length,
    });
  } catch {
    return json({ status: 'error' });
  }
}
