import { BASE } from './_shared/catalog.js';
import { SEO_CATEGORIES } from './_shared/seo-categories.js';
import { urlsetXml, xmlResponse } from './_shared/sitemap.js';

export function categorySitemapEntries() {
  return SEO_CATEGORIES.map(category => ({
    loc: `${BASE}/libros/${category.id}`,
  }));
}

export async function onRequest(ctx) {
  return xmlResponse(ctx.request, urlsetXml(categorySitemapEntries()));
}
