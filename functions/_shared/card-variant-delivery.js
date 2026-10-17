import { normalizeSourceUrl } from './preview-cover.js';
import { cardCoverImageOptions } from '../../shared/card-cover-framing.js';

export const CARD_RECIPES = Object.freeze(['v1-240-q85', 'v1-360-q85', 'v1-480-q85']);
export const PRODUCTION_IMAGE_BUCKET = 'amadolibros-images-production';
const HASH = /^[a-f0-9]{64}$/;
const cache = new WeakMap();
const MAX_BYTES = 2_000_000;

export function cardCanaryRequest(ctx) {
  const ids = String(ctx.env?.CARD_VARIANTS_CANARY_IDS || '').split(',').filter(Boolean);
  return ctx.env?.IMAGE_VARIANTS_READ_ENABLED === 'true' && ctx.env.APP_ENV === 'production' &&
    ctx.env.COVER_R2_BUCKET_NAME === PRODUCTION_IMAGE_BUCKET && ids.length > 0 && ids.length <= 10 &&
    ids.every(id => /^MLU\d+$/.test(id)) && new URL(ctx.request.url).searchParams.get('_card_variants') === '1';
}

async function verifiedIndex(ctx) {
  const digest = ctx.env.CARD_VARIANTS_INDEX_SHA256;
  const bucket = ctx.env.COVER_R2;
  if (!HASH.test(digest || '') || typeof bucket?.get !== 'function') return null;
  const cached = cache.get(bucket);
  if (cached?.digest === digest) return cached.value;
  if (ctx.data.cardVariantIndex) return ctx.data.cardVariantIndex;
  // One bounded read per request; errors/timeouts are never cached across requests.
  ctx.data.cardVariantIndex = (async () => {
    let timer;
    try {
      const read = (async () => {
        const object = await bucket.get(`covers/card-readiness/v1/${digest}.json`);
        if (!object || !(object.size > 0) || object.size > MAX_BYTES) return null;
        const text = await object.text();
        const bytes = new TextEncoder().encode(text);
        if (bytes.length > MAX_BYTES) return null;
        const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
        if (actual !== digest) return null;
        const index = JSON.parse(text);
        if (index.schema !== 'verified-card-readiness-v1' || index.bucket !== PRODUCTION_IMAGE_BUCKET ||
            JSON.stringify(index.recipes) !== JSON.stringify(CARD_RECIPES) || !index.cards ||
            Object.keys(index.cards).length > 2790) return null;
        return index;
      })();
      const value = await Promise.race([read, new Promise(resolve => { timer = setTimeout(() => resolve(null), 150); })]);
      if (value) cache.set(bucket, { digest, value });
      return value;
    } catch { return null; }
    finally { clearTimeout(timer); }
  })();
  return ctx.data.cardVariantIndex;
}

export async function readyCardVariantSource(ctx, item, currentCoverUrl) {
  if (!cardCanaryRequest(ctx) || !ctx.env.CARD_VARIANTS_CANARY_IDS.split(',').includes(item.id) ||
      item.status !== 'active' || !(item.available_quantity > 0) ||
      cardCoverImageOptions(item.id).widths || !item.pictures?.[0]) return null;
  ctx.data ||= {};
  const index = await verifiedIndex(ctx);
  const row = index?.cards[item.id];
  const source = normalizeSourceUrl(item.pictures[0]);
  if (!row || !HASH.test(row.sha256 || '') || !['jpg','png','webp'].includes(row.extension) ||
      !source || source !== normalizeSourceUrl(row.source_url)) return null;
  const url = new URL(`/preview-cover/${item.id}/0/${row.sha256}.${row.extension}`, ctx.request.url);
  // Reuse the catalog's already resolved current cover: same-source hash drift
  // must not activate an old readiness entry. No extra R2 lookup here.
  try { if (new URL(currentCoverUrl, ctx.request.url).pathname !== url.pathname) return null; } catch { return null; }
  return url.href;
}
