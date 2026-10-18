// Versionar la receta al cambiar encoder o parámetros. Masters sin cambios
// reutilizan estos objetos; ninguna visita genera imágenes.
export const VARIANT_VERSION = 'v1';
export const IMAGE_VARIANTS = Object.freeze([
  [96, 82], [120, 85], [180, 85], [240, 85], [320, 85], [360, 85],
  [480, 85], [720, 85], [768, 85], [960, 85], [1024, 85], [1024, 88],
].map(([width, quality]) => Object.freeze({
  id: `${VARIANT_VERSION}-${width}-q${quality}`, width, quality, format: 'webp',
})));

// v2: encoder Cloudflare Images, generado sólo por el proceso privado con cupo.
// Claves, ids y metadatos propios: nunca comparte URL inmutable con v1 (Sharp).
export const CF_VARIANT_VERSION = 'v2';
export const CF_ENCODER = 'cloudflare-images';
export const CARD_WIDTHS = Object.freeze([240, 360, 480]);
export const CF_CARD_VARIANTS = Object.freeze(CARD_WIDTHS.map(width => Object.freeze({
  id: `${CF_VARIANT_VERSION}-${width}-q85`, width, quality: 85, format: 'webp',
})));
export const ALL_IMAGE_VARIANTS = Object.freeze([...IMAGE_VARIANTS, ...CF_CARD_VARIANTS]);

export function imageVariant(id) {
  return ALL_IMAGE_VARIANTS.find(recipe => recipe.id === id) || null;
}

export function variantVersion(id) {
  return imageVariant(id) ? id.slice(0, id.indexOf('-')) : null;
}

export function variantObjectKey(hash, id) {
  return /^[a-f0-9]{64}$/.test(hash || '') && imageVariant(id)
    ? `covers/variants/${variantVersion(id)}/${hash}/${id}.webp` : null;
}

// `recipes` (opcional): { [ancho]: idDeReceta } elegido por el índice verificado.
export function permanentImageUrl(source, { width, quality = 85, fit = 'scale-down', recipes = null } = {}) {
  if (!source || fit !== 'scale-down') return String(source || '');
  let url;
  try { url = new URL(source, 'https://www.amadolibros.com'); } catch { return String(source); }
  const trusted = url.protocol === 'https:' &&
    (url.hostname === 'www.amadolibros.com' || /(?:^|\.)amadolibros-web\.pages\.dev$/.test(url.hostname));
  const controlled = /^\/book-cover\/MLU\d+\/cover(?:-(?:[2-9]|1[0-6]))?\.jpg$/.test(url.pathname) ||
    /^\/preview-cover\/MLU\d+\/(?:[0-9]|1[0-5])\/[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(url.pathname);
  if (!trusted || !controlled || url.searchParams.has('variant')) return String(source);
  const chosen = recipes && Object.hasOwn(recipes, width) ? imageVariant(recipes[width]) : null;
  const recipe = recipes
    ? (chosen && chosen.width === Number(width) && chosen.quality === Number(quality) ? chosen : null)
    : IMAGE_VARIANTS.find(r => r.width === Number(width) && r.quality === Number(quality));
  if (!recipe) return String(source);
  url.searchParams.set('variant', recipe.id);
  return url.toString();
}

export async function readImageVariant(bucket, hash, id) {
  const key = variantObjectKey(hash, id);
  if (!key || typeof bucket?.get !== 'function') return null;
  try {
    const object = await bucket.get(key);
    // Sólo objetos publicados por el escritor validado, con metadatos de receta.
    if (!object?.body || !(object.size > 0) || object.httpMetadata?.contentType !== 'image/webp' ||
        object.customMetadata?.master_sha256 !== hash ||
        object.customMetadata?.recipe !== id || !/^[a-f0-9]{64}$/.test(object.customMetadata?.sha256 || '')) return null;
    // v2 sólo vale si lo escribió el encoder de Cloudflare; v1 nunca lleva ese sello.
    const encoder = object.customMetadata?.encoder;
    if (variantVersion(id) === CF_VARIANT_VERSION ? encoder !== CF_ENCODER : encoder !== undefined && encoder !== 'sharp') return null;
    return object;
  } catch { return null; }
}
