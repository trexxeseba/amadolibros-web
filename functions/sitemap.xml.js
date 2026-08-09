/**
 * functions/sitemap.xml.js
 *
 * Entrada estable de sitemaps. Segmenta por tipo para observabilidad en GSC.
 * No usa priority/changefreq ni lastmod inventado.
 */

import { sitemapIndexXml, xmlResponse } from './_shared/sitemap.js';

export async function onRequest() {
    return xmlResponse(sitemapIndexXml());
}
