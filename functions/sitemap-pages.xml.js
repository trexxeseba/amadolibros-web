import { BASE } from './_shared/catalog.js';
import { urlsetXml, xmlResponse } from './_shared/sitemap.js';
import { SEO_SPECIALTIES, specialtyPath } from './_shared/seo-specialties.js';

export const STATIC_SITEMAP_PAGES = Object.freeze([
  `${BASE}/`,
  `${BASE}/catalogo`,
  `${BASE}/pedir-libro`,
  `${BASE}/como-identificar-edicion-correcta-isbn`,
  `${BASE}/libros-agotados-importados-uruguay`,
  `${BASE}/libros-maria-montessori-uruguay`,
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
  [`${BASE}/quienes-somos`]: '2026-08-12',
});

export const STATIC_SITEMAP_ENTRIES = Object.freeze(
  STATIC_SITEMAP_PAGES.map(loc => Object.freeze({
    loc,
    ...(SIGNIFICANT_PAGE_UPDATES[loc] ? { lastmod: SIGNIFICANT_PAGE_UPDATES[loc] } : {}),
  })),
);

export async function onRequest() {
  return xmlResponse(urlsetXml(STATIC_SITEMAP_ENTRIES));
}
