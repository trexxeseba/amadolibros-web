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

/**
 * Dos umbrales distintos, porque son dos preguntas distintas.
 *
 * `googleReadyImage` responde "¿Google acepta esta imagen HOY?". Hasta el
 * 2027-01-31 el mínimo real de Merchant para productos que no son indumentaria
 * —los libros lo son— es 100×100; desde julio de 2026 Google muestra AVISOS
 * para las menores a 500×500, pero avisar no es rechazar. Exigir 500 hoy deja
 * fuera del feed miles de libros que Google publicaría igual.
 *
 * `googleFutureReadyImage` responde "¿va a seguir sirviendo después del
 * 2027-01-31?", que es la pregunta del backlog de portadas: ahí el objetivo
 * sigue siendo 500×500 y no se afloja.
 *
 * El umbral se endurece solo en la fecha. Nadie tiene que acordarse.
 */
export const GOOGLE_IMAGE_MIN_EDGE_TODAY = 100;
export const GOOGLE_IMAGE_MIN_EDGE_ENFORCED_FROM = Date.UTC(2027, 0, 31);

export function googleImageMinEdge(now = Date.now()) {
  return now >= GOOGLE_IMAGE_MIN_EDGE_ENFORCED_FROM
    ? GOOGLE_IMAGE_MIN_EDGE
    : GOOGLE_IMAGE_MIN_EDGE_TODAY;
}

export function googleReadyImage(current, now = Date.now()) {
  const minEdge = googleImageMinEdge(now);
  return Boolean(current?.object_key && Number(current.width) >= minEdge &&
    Number(current.height) >= minEdge);
}

export function googleFutureReadyImage(current) {
  return Boolean(current?.object_key && Number(current.width) >= GOOGLE_IMAGE_MIN_EDGE &&
    Number(current.height) >= GOOGLE_IMAGE_MIN_EDGE);
}

export function resolutionDowngrade(next, previous) {
  return Number(previous?.width) > Number(next?.width) || Number(previous?.height) > Number(next?.height);
}
