// functions/_shared/catalog-image-overrides.js
//
// CATALOG-IMAGE-QUALITY-1 — overrides explícitos, verificados uno por uno,
// para la imagen PRINCIPAL (posición 0) de productos puntuales del
// catálogo. Nunca es una heurística: no compara títulos, no adivina
// duplicados por similitud. Cada entrada requiere evidencia verificada a
// mano (ej. ISBN compartido con el duplicado limpio) antes de agregarse
// acá — agregar una entrada sin esa evidencia es un error de uso de este
// archivo, no algo que el código pueda detectar por sí solo.
//
// Sólo reemplaza pictures[0]. El resto de la galería original del
// producto (pictures[1..]) nunca se toca. La imagen de reemplazo siempre
// debe ser una URL mlstatic.com que ya exista en pictures[] de OTRO
// producto verificado de nuestro propio catálogo — nunca una imagen de una
// librería externa.

const MLSTATIC_HOST_RE = /(^|\.)mlstatic\.com$/i;

function isMlstaticImageUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) && MLSTATIC_HOST_RE.test(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

// CASO 1 — CATALOG-IMAGE-QUALITY-1: MLU717791364 ("Santa Biblia", Martín
// Nieto / Evaristo, Editorial San Pablo, ISBN 9788428543231) muestra como
// portada el logo de la librería "El Yelmo de Mambrino", que nunca debería
// aparecer ahí. El duplicado verificado MLU717869050 comparte exactamente
// el mismo ISBN y tiene una portada limpia real de Mercado Libre.
export const CATALOG_IMAGE_OVERRIDES = Object.freeze({
  MLU717791364: Object.freeze({
    imageUrl: 'https://http2.mlstatic.com/D_821791-MLU83069485320_032025-O.jpg',
    reason: 'La imagen principal original muestra el logo de la librería "El Yelmo de Mambrino" en vez de la portada del libro.',
    verifiedIsbn: '9788428543231',
    sourceProductId: 'MLU717869050',
  }),
});

// Falla rápido en tiempo de carga si alguna entrada no apunta a una imagen
// mlstatic válida — mejor un error temprano en tests/build que servir un
// override roto en producción.
for (const [productId, override] of Object.entries(CATALOG_IMAGE_OVERRIDES)) {
  if (!isMlstaticImageUrl(override.imageUrl)) {
    throw new Error(`catalog-image-overrides: URL de imagen inválida para ${productId}`);
  }
}

/**
 * Devuelve el override verificado para un product id, o null si ese id no
 * tiene ninguno. Sólo los IDs listados explícitamente en
 * CATALOG_IMAGE_OVERRIDES pueden recibir un override — no hay heurística,
 * no hay matching por título ni por similitud.
 * @param {unknown} productId
 */
export function overrideImageForProduct(productId) {
  const id = String(productId || '').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(CATALOG_IMAGE_OVERRIDES, id)
    ? CATALOG_IMAGE_OVERRIDES[id]
    : null;
}

/**
 * Devuelve una copia superficial de `item` con `pictures[0]` reemplazada
 * por la imagen verificada, sólo si `item.id` tiene un override explícito
 * en CATALOG_IMAGE_OVERRIDES. Cualquier otro producto se devuelve tal cual
 * (mismo objeto, sin copiar). No toca título, isbn, slug, precio, stock,
 * disponibilidad, ni el resto de la galería.
 *
 * Idempotente: aplicarla dos veces da el mismo resultado que aplicarla una
 * vez, porque la decisión depende únicamente de item.id y siempre escribe
 * el mismo valor verificado en la posición 0.
 * @param {object} item
 */
export function applyCatalogImageOverride(item) {
  if (!item || typeof item !== 'object') return item;
  const override = overrideImageForProduct(item.id);
  if (!override) return item;
  const pictures = Array.isArray(item.pictures) ? [...item.pictures] : [];
  if (pictures.length > 0) pictures[0] = override.imageUrl;
  else pictures.unshift(override.imageUrl);
  return { ...item, pictures };
}
