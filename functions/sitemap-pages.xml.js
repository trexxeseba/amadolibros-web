import { BASE } from './_shared/catalog.js';
import { urlsetXml, xmlResponse } from './_shared/sitemap.js';

export const STATIC_SITEMAP_PAGES = Object.freeze([
  `${BASE}/`,
  `${BASE}/catalogo`,
  `${BASE}/libros-maria-montessori-uruguay`,
  `${BASE}/politicas`,
  `${BASE}/envios`,
  `${BASE}/devoluciones`,
  `${BASE}/terminos`,
  `${BASE}/privacidad`,
  `${BASE}/contacto`,
]);

export async function onRequest(ctx) {
  return xmlResponse(ctx.request, urlsetXml(STATIC_SITEMAP_PAGES.map(loc => ({ loc }))));
}
