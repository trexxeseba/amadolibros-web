/**
 * functions/sitemap.xml.js
 *
 * Sitemap estático de páginas canónicas e indexables.
 * No incluye URLs de productos SPA (?book=MLU...) porque son JS-rendered
 * y no representan páginas independientes para Google.
 *
 * Para indexar productos individualmente se necesita SSG/SSR (fuera de alcance).
 */

export async function onRequest() {
    const BASE = "https://www.amadolibros.com";
    const today = new Date().toISOString().split('T')[0];

    const pages = [
        { loc: `${BASE}/`,          changefreq: "daily",   priority: "1.0" },
        { loc: `${BASE}/politicas`, changefreq: "monthly", priority: "0.6" },
    ];

    const urls = pages.map(p => `
  <url>
    <loc>${p.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join('');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

    return new Response(xml, {
        headers: {
            "content-type": "application/xml;charset=UTF-8",
            "cache-control": "public, max-age=86400",
        },
    });
}
