import { BASE } from './catalog.js';

export const SITEMAP_SEGMENTS = Object.freeze([
  `${BASE}/sitemap-pages.xml`,
  `${BASE}/sitemap-categories.xml`,
  `${BASE}/sitemap-books-active.xml`,
]);

export function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function sitemapIndexXml(locations = SITEMAP_SEGMENTS) {
  const rows = locations
    .map(loc => `  <sitemap>\n    <loc>${escapeXml(loc)}</loc>\n  </sitemap>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows}\n</sitemapindex>`;
}

export function urlsetXml(entries = []) {
  const rows = entries
    .map(entry => {
      const lastmod = entry?.lastmod
        ? `\n    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`
        : '';
      return `  <url>\n    <loc>${escapeXml(entry.loc)}</loc>${lastmod}\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows}\n</urlset>`;
}

export function xmlResponse(xml, maxAge = 3600) {
  return new Response(xml, {
    headers: {
      'content-type': 'application/xml;charset=UTF-8',
      'cache-control': `public, max-age=${maxAge}`,
    },
  });
}
