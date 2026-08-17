import { BASE, fetchPausedIndex } from './_shared/catalog.js';
import { urlsetXml, xmlResponse } from './_shared/sitemap.js';
import { SEO_SPECIALTIES, specialtyPath } from './_shared/seo-specialties.js';
import { SEO_AUTHORS } from './_shared/seo-authors.js';
import { orderHubPaginationEntries } from './_shared/order-hub.js';

export const STATIC_SITEMAP_PAGES = Object.freeze([
  `${BASE}/`,
  `${BASE}/catalogo`,
  `${BASE}/pedir-libro`,
  `${BASE}/como-identificar-edicion-correcta-isbn`,
  `${BASE}/libros-agotados-importados-uruguay`,
  `${BASE}/libros-por-encargo`,
  ...SEO_AUTHORS.map(author => `${BASE}${author.path}`),
  `${BASE}/politicas`,
  `${BASE}/envios`,
  `${BASE}/devoluciones`,
  `${BASE}/terminos`,
  `${BASE}/privacidad`,
  `${BASE}/contacto`,
  `${BASE}/quienes-somos`,
  ...SEO_SPECIALTIES.map(item => `${BASE}${specialtyPath(item.id)}`),
]);

const SIGNIFICANT_PAGE_UPDATES = Object.freeze({
  [`${BASE}/`]: '2026-08-12',
  [`${BASE}/pedir-libro`]: '2026-08-12',
  [`${BASE}/como-identificar-edicion-correcta-isbn`]: '2026-08-12',
  [`${BASE}/libros-agotados-importados-uruguay`]: '2026-08-12',
  [`${BASE}/libros-por-encargo`]: '2026-08-17',
  [`${BASE}/quienes-somos`]: '2026-08-12',
  ...Object.fromEntries(SEO_AUTHORS.map(author => [`${BASE}${author.path}`, '2026-08-14'])),
});

export const STATIC_SITEMAP_ENTRIES = Object.freeze(
  STATIC_SITEMAP_PAGES.map(loc => Object.freeze({
    loc,
    ...(SIGNIFICANT_PAGE_UPDATES[loc] ? { lastmod: SIGNIFICANT_PAGE_UPDATES[loc] } : {}),
  })),
);

export async function pageSitemapEntries(ctx, { loadPausedIndex = fetchPausedIndex } = {}) {
  let paginatedOrderHubEntries = [];
  try {
    const pausedIndex = await loadPausedIndex(ctx);
    paginatedOrderHubEntries = orderHubPaginationEntries(pausedIndex, BASE);
  } catch {
    // El sitemap institucional sigue disponible aunque R2 tenga una caída
    // temporal. La raíz del hub queda publicada y las páginas 2+ vuelven en
    // el siguiente request cuando el índice pausado se recupere.
  }
  return [
    ...STATIC_SITEMAP_ENTRIES,
    ...paginatedOrderHubEntries,
  ];
}

export async function onRequest(ctx) {
  return xmlResponse(urlsetXml(await pageSitemapEntries(ctx)));
}
