// Versionar la receta al cambiar encoder o parámetros. Masters sin cambios
// reutilizan estos objetos; ninguna visita genera imágenes.
export const VARIANT_VERSION = 'v1';
export const IMAGE_VARIANTS = Object.freeze([
  [96, 82], [120, 85], [180, 85], [240, 85], [320, 85], [360, 85],
  [480, 85], [720, 85], [768, 85], [960, 85], [1024, 85], [1024, 88],
].map(([width, quality]) => Object.freeze({
  id: `${VARIANT_VERSION}-${width}-q${quality}`, width, quality, format: 'webp',
})));

export function imageVariant(id) {
  return IMAGE_VARIANTS.find(recipe => recipe.id === id) || null;
}

export function variantObjectKey(hash, id) {
  return /^[a-f0-9]{64}$/.test(hash || '') && imageVariant(id)
    ? `covers/variants/${VARIANT_VERSION}/${hash}/${id}.webp` : null;
}

export function permanentImageUrl(source, { width, quality = 85, fit = 'scale-down' } = {}) {
  if (!source || fit !== 'scale-down') return String(source || '');
  let url;
  try { url = new URL(source, 'https://www.amadolibros.com'); } catch { return String(source); }
  const trusted = url.protocol === 'https:' &&
    (url.hostname === 'www.amadolibros.com' || /(?:^|\.)amadolibros-web\.pages\.dev$/.test(url.hostname));
  const controlled = /^\/book-cover\/MLU\d+\/cover(?:-(?:[2-9]|1[0-6]))?\.jpg$/.test(url.pathname) ||
    /^\/preview-cover\/MLU\d+\/(?:[0-9]|1[0-5])\/[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(url.pathname);
  if (!trusted || !controlled || url.searchParams.has('variant')) return String(source);
  const recipe = IMAGE_VARIANTS.find(r => r.width === Number(width) && r.quality === Number(quality));
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
    if (!object?.body || object.customMetadata?.master_sha256 !== hash ||
        object.customMetadata?.recipe !== id || !/^[a-f0-9]{64}$/.test(object.customMetadata?.sha256 || '')) return null;
    return object;
  } catch { return null; }
}
