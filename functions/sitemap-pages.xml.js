import { BASE } from './_shared/catalog.js';
import { urlsetXml, xmlResponse } from './_shared/sitemap.js';
import { SEO_SPECIALTIES, specialtyPath } from './_shared/seo-specialties.js';

export const STATIC_SITEMAP_PAGES = Object.freeze([
  `${BASE}/`,
  `${BASE}/catalogo`,
  `${BASE}/pedir-libro`,
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

export async function onRequest() {
  return xmlResponse(urlsetXml(STATIC_SITEMAP_PAGES.map(loc => ({ loc }))));
}
