import { findPreviewCover } from './preview-cover.js';
import { variantObjectKey } from '../../shared/image-variants.js';
import { cardCoverImageOptions } from '../../shared/card-cover-framing.js';

export const CARD_RECIPES = Object.freeze(['v1-240-q85', 'v1-360-q85', 'v1-480-q85']);
export const PRODUCTION_IMAGE_BUCKET = 'amadolibros-images-production';

// Initial canary: dynamic catalog primary cards only. Every missing/currently
// changed source stays on the pre-migration delivery path, including paused,
// enlarged, and newly added cards without a complete verified recipe set.
export async function readyCardVariantSource(ctx, item) {
  if (ctx.env?.IMAGE_VARIANTS_READ_ENABLED !== 'true' || ctx.env.APP_ENV !== 'production' ||
      ctx.env.COVER_R2_BUCKET_NAME !== PRODUCTION_IMAGE_BUCKET ||
      item.status !== 'active' || !(item.available_quantity > 0) ||
      cardCoverImageOptions(item.id).widths || !item.pictures?.[0] ||
      typeof ctx.env.COVER_R2?.head !== 'function') return null;
  const cover = await findPreviewCover(ctx, item.id, 0, item.pictures[0]);
  if (!cover || cover.indexMode !== 'public-index') return null;
  try {
    const objects = await Promise.all(CARD_RECIPES.map(recipe => ctx.env.COVER_R2.head(variantObjectKey(cover.sha256, recipe))));
    if (!objects.every((object, i) => object?.size > 0 && object.httpMetadata?.contentType === 'image/webp' &&
      object.customMetadata?.master_sha256 === cover.sha256 && object.customMetadata.recipe === CARD_RECIPES[i] &&
      /^[a-f0-9]{64}$/.test(object.customMetadata.sha256 || ''))) return null;
    return new URL(`/preview-cover/${item.id}/0/${cover.sha256}.${cover.extension}`, ctx.request.url).href;
  } catch { return null; }
}
