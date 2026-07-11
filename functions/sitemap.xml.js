/**
 * functions/sitemap.xml.js
 *
 * Sitemap dinámico con URLs de todas las fichas de producto.
 * Lee catalog.json desde R2 (vía URL pública + CF edge cache 1h).
 * Genera /libro/:id/:slug para cada item activo.
 */

import { slugify } from './_shared/slug.js';
import { BASE, fetchCatalog } from './_shared/catalog.js';

// Convierte un valor de start_time (ISO 8601) a fecha YYYY-MM-DD.
// Devuelve fallback si el valor es nulo, vacío o inválido.
function toDateStr(isoString, fallback) {
    if (!isoString) return fallback;
    try {
        const d = new Date(isoString);
        if (isNaN(d.getTime())) return fallback;
        return d.toISOString().split('T')[0];
    } catch {
        return fallback;
    }
}

export async function onRequest(ctx) {
    const today = new Date().toISOString().split('T')[0];

    // Páginas estáticas: lastmod = hoy (se actualizan con cada deploy).
    const staticPages = [
        { loc: `${BASE}/`,                                    changefreq: 'daily',   priority: '1.0', lastmod: today },
        { loc: `${BASE}/politicas`,                         changefreq: 'monthly', priority: '0.3', lastmod: today },
        { loc: `${BASE}/catalogo`,                          changefreq: 'daily',   priority: '0.5', lastmod: today },
        { loc: `${BASE}/libros-maria-montessori-uruguay`,   changefreq: 'weekly',  priority: '0.8', lastmod: today },
    ];

    let bookUrls = [];
    const catalog = await fetchCatalog(ctx);
    if (catalog && Array.isArray(catalog.items)) {
        bookUrls = catalog.items
            .filter(item => item.status === 'active')
            .map(item => ({
            loc:        `${BASE}/libro/${item.id}/${slugify(item.title)}`,
            changefreq: 'weekly',
            priority:   '0.7',
            // Usar start_time real del item. Es la fecha de creación del listado en ML,
            // que es el mejor proxy de "cuándo apareció este libro" disponible en el catálogo.
            // Evita el patrón anterior donde lastmod era "hoy" para todos los items cada día,
            // lo que entrenaba a Google a creer que 7k+ páginas cambiaban diariamente.
            lastmod: toDateStr(item.start_time, today),
        }));
    }

    const allPages = [...staticPages, ...bookUrls];

    const urls = allPages.map(p =>
        `  <url>\n    <loc>${p.loc}</loc>\n    <lastmod>${p.lastmod}</lastmod>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`
    ).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;

    return new Response(xml, {
        headers: {
            'content-type':  'application/xml;charset=UTF-8',
            'cache-control': 'public, max-age=3600',
        },
    });
}
