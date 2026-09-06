// A versioned policy for every ML image, independent of product/ISBN/position.
export const IMAGE_SOURCE_POLICY_VERSION = 1;
export const GOOGLE_IMAGE_MIN_EDGE = 500;
export const IMAGE_SOURCE_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
export const IMAGE_FETCH_RETRY_MS = 6 * 60 * 60 * 1000;

export function mlImageIdentity(source) {
  try {
    const url = new URL(source);
    if (!['http:', 'https:'].includes(url.protocol) ||
        !(url.hostname === 'mlstatic.com' || url.hostname.endsWith('.mlstatic.com'))) return null;
    return /^\/D_(?:NQ_NP_)?(\d+-ML[A-Z]\d+_\d{6})-[A-Z]\.(?:jpg|jpeg|png|webp)$/i.exec(url.pathname)?.[1] || null;
  } catch { return null; }
}

export function nativeImageAlternatives(source, catalogSources = []) {
  const identity = mlImageIdentity(source);
  if (!identity) return [source];
  const matching = catalogSources.filter(url => mlImageIdentity(url) === identity);
  // Both are candidates, never assumed to be larger based on suffix alone.
  return [...new Set([source, ...matching,
    `https://http2.mlstatic.com/D_NQ_NP_${identity}-F.jpg`,
    `https://http2.mlstatic.com/D_${identity}-O.jpg`,
  ])].slice(0, 4);
}

export function googleReadyImage(current) {
  return Boolean(current?.object_key && Number(current.width) >= GOOGLE_IMAGE_MIN_EDGE &&
    Number(current.height) >= GOOGLE_IMAGE_MIN_EDGE);
}

export function resolutionDowngrade(next, previous) {
  return Number(previous?.width) > Number(next?.width) || Number(previous?.height) > Number(next?.height);
}
