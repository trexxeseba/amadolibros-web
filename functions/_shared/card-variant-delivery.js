import { normalizeSourceUrl } from './preview-cover.js';
import { cardCoverImageOptions } from '../../shared/card-cover-framing.js';
import { CARD_WIDTHS } from '../../shared/image-variants.js';

export const CARD_RECIPES = Object.freeze(['v1-240-q85', 'v1-360-q85', 'v1-480-q85']);
export const PRODUCTION_IMAGE_BUCKET = 'amadolibros-images-production';
// Bounded headroom for the 29 aliases reusing already verified masters.
export const MAX_CARD_READINESS_ENTRIES = 3000;
// Índice v2: selecciona por master y ancho una receta ya verificada (v1 Sharp o
// v2 Cloudflare), sin duplicar lo disponible. Presupuesto propio y medido; el
// índice v1 conserva su límite original.
export const READINESS_V2_SCHEMA = 'verified-card-readiness-v2';
export const MAX_CARD_READINESS_V2_ENTRIES = 8000;
export const MAX_CARD_READINESS_V2_BYTES = 4_000_000;
const HASH = /^[a-f0-9]{64}$/;
const cache = new WeakMap();
const MAX_BYTES = 2_000_000;
// Un carácter por ancho (240/360/480): 0 sin derivado verificado, 1 = v1, 2 = v2.
const SELECTION = /^[0-2]{3}$/;

export function recipesForSelection(code) {
  if (typeof code !== 'string' || !SELECTION.test(code) || code.includes('0')) return null;
  return Object.fromEntries(CARD_WIDTHS.map((width, i) => [width, `v${code[i]}-${width}-q85`]));
}

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
        if (!object || !(object.size > 0) || object.size > MAX_CARD_READINESS_V2_BYTES) return null;
        const text = await object.text();
        const bytes = new TextEncoder().encode(text);
        if (bytes.length > MAX_CARD_READINESS_V2_BYTES) return null;
        const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
        if (actual !== digest) return null;
        const index = JSON.parse(text);
        if (!index?.cards || typeof index.cards !== 'object' || Array.isArray(index.cards) ||
            index.bucket !== PRODUCTION_IMAGE_BUCKET) return null;
        const entries = Object.keys(index.cards).length;
        if (index.schema === 'verified-card-readiness-v1') {
          if (bytes.length > MAX_BYTES || JSON.stringify(index.recipes) !== JSON.stringify(CARD_RECIPES) ||
              entries > MAX_CARD_READINESS_ENTRIES) return null;
          return index;
        }
        if (index.schema === READINESS_V2_SCHEMA) {
          if (JSON.stringify(index.widths) !== JSON.stringify(CARD_WIDTHS) || entries > MAX_CARD_READINESS_V2_ENTRIES ||
              !index.masters || typeof index.masters !== 'object' || Array.isArray(index.masters) ||
              Object.keys(index.masters).length > MAX_CARD_READINESS_V2_ENTRIES) return null;
          return index;
        }
        return null;
      })();
      const value = await Promise.race([read, new Promise(resolve => { timer = setTimeout(() => resolve(null), 150); })]);
      if (value) cache.set(bucket, { digest, value });
      return value;
    } catch { return null; }
    finally { clearTimeout(timer); }
  })();
  return ctx.data.cardVariantIndex;
}

// Devuelve { url, recipes } o null. `recipes` fija, por ancho, la receta exacta
// verificada para ese master; nunca se infiere una versión distinta.
export async function readyCardVariantSelection(ctx, item, currentCoverUrl) {
  // Search uses the active compact index: its primary source is thumbnail.
  // A full record with missing pictures must still fail closed.
  const primarySource = Array.isArray(item.pictures) ? item.pictures[0] : item.thumbnail;
  if (!cardCanaryRequest(ctx) || !ctx.env.CARD_VARIANTS_CANARY_IDS.split(',').includes(item.id) ||
      item.status !== 'active' || !(item.available_quantity > 0) ||
      cardCoverImageOptions(item.id).widths || !primarySource) return null;
  ctx.data ||= {};
  const index = await verifiedIndex(ctx);
  const row = index?.cards[item.id];
  const source = normalizeSourceUrl(primarySource);
  if (!row || !HASH.test(row.sha256 || '') || !['jpg','png','webp'].includes(row.extension) ||
      !source || source !== normalizeSourceUrl(row.source_url)) return null;
  const recipes = index.schema === READINESS_V2_SCHEMA
    ? recipesForSelection(index.masters[row.sha256])
    : Object.fromEntries(CARD_WIDTHS.map(width => [width, `v1-${width}-q85`]));
  if (!recipes) return null;
  const url = new URL(`/preview-cover/${item.id}/0/${row.sha256}.${row.extension}`, ctx.request.url);
  // Reuse the catalog's already resolved current cover: same-source hash drift
  // must not activate an old readiness entry. No extra R2 lookup here.
  try { if (new URL(currentCoverUrl, ctx.request.url).pathname !== url.pathname) return null; } catch { return null; }
  return { url: url.href, recipes };
}

export async function readyCardVariantSource(ctx, item, currentCoverUrl) {
  return (await readyCardVariantSelection(ctx, item, currentCoverUrl))?.url || null;
}
