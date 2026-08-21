/**
 * functions/_shared/tarot-finder-dataset.js
 *
 * TAROT-FINDER-1: arma el payload compacto que viaja al cliente para el
 * selector "Encontrá tu mazo". Puro — no hace fetch, no toca el DOM.
 *
 * Universo: sólo mazos comprables ahora (activo + stock>0 + precio válido),
 * de un sistema real de cartas (tarot/oráculo/lenormand/kipper) — nunca
 * accesorios ni libros SOBRE tarot (format=libro): el Finder busca un mazo,
 * no un ensayo. Ningún campo se infiere: viene tal cual de
 * TAROT_MERCH_TAGS (TAROT-MERCH-TAGS-1), que ya aplicó la regla
 * "desconocido > clasificación incorrecta".
 */

const FINDER_SYSTEM_TYPES = new Set(['tarot', 'oraculo', 'lenormand', 'kipper']);

// Campos mínimos enviados al cliente — nunca título largo con subtítulos
// completos más allá del propio título, nunca descripción, nunca campos de
// depuración. Ver tarot-finder.dataset.test.js para el guard de tamaño.
export function buildTarotFinderDataset({ items = [], tagLookup, imageForId, hrefForItem } = {}) {
  if (!Array.isArray(items)) throw new Error('items debe ser un array.');
  if (typeof tagLookup !== 'function') throw new Error('tagLookup debe ser una función.');
  if (typeof imageForId !== 'function') throw new Error('imageForId debe ser una función.');
  if (typeof hrefForItem !== 'function') throw new Error('hrefForItem debe ser una función.');

  const seen = new Set();
  const dataset = [];
  for (const item of items) {
    if (!item?.id || seen.has(item.id)) continue;
    const tag = tagLookup(item.id);
    if (!tag) continue;
    if (!FINDER_SYSTEM_TYPES.has(tag.primary_type)) continue;
    if (tag.format === 'libro') continue;
    if (item.status !== 'active') continue;
    const stock = Number(item.available_quantity) || 0;
    if (stock <= 0) continue;
    const price = Number(item.price) || 0;
    if (price <= 0) continue;

    seen.add(item.id);
    dataset.push({
      id: item.id,
      title: item.title || '',
      price,
      image: imageForId(item.id),
      href: hrefForItem(item),
      primary_type: tag.primary_type,
      deck_family: tag.deck_family,
      language: tag.language,
      bundle: tag.bundle,
      level: tag.level,
      edition_style: tag.edition_style,
      stock,
    });
  }
  return dataset;
}
