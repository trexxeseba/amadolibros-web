import { BASE, fetchPausedIndex } from './_shared/catalog.js';
import { PAUSED_SEO_COHORT } from './_shared/paused-seo-cohort.js';
import { slugify } from './_shared/slug.js';
import { urlsetXml, xmlResponse } from './_shared/sitemap.js';

/**
 * Primera cohorte controlada de libros por encargo.
 *
 * La lista aprobada es estable, pero el sitemap sólo publica los IDs que
 * continúan pausados en el manifiesto vigente. Si un libro vuelve a estar
 * activo, deja este segmento y aparece en sitemap-books-active.xml sin crear
 * dos entradas para la misma publicación.
 */
export function pausedBookSitemapEntries(pausedIndex) {
  const pausedItems = Array.isArray(pausedIndex?.items) ? pausedIndex.items : [];
  const byId = new Map(pausedItems.map(item => [item.id, item]));
  return PAUSED_SEO_COHORT
    .map(entry => byId.get(entry.id))
    .filter(item => item?.status === 'paused' && item.id && item.title)
    .map(item => ({ loc: `${BASE}/libro/${item.id}/${slugify(item.title)}` }));
}

export async function onRequest(ctx) {
  const pausedIndex = await fetchPausedIndex(ctx);
  return xmlResponse(urlsetXml(pausedBookSitemapEntries(pausedIndex)), 300);
}
