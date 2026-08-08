import { BASE, fetchCatalog } from './_shared/catalog.js';
import { slugify } from './_shared/slug.js';
import { urlsetXml, xmlResponse } from './_shared/sitemap.js';

export function activeBookSitemapEntries(catalog) {
  if (!catalog || !Array.isArray(catalog.items)) return [];
  return catalog.items
    .filter(item => item?.status === 'active' && Number(item.available_quantity) > 0 && item.id && item.title)
    .map(item => ({ loc: `${BASE}/libro/${item.id}/${slugify(item.title)}` }));
}

export async function onRequest(ctx) {
  const catalog = await fetchCatalog(ctx);
  return xmlResponse(urlsetXml(activeBookSitemapEntries(catalog)));
}
