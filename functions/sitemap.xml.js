/**
 * functions/sitemap.xml.js
 *
 * Sitemap dinámico con URLs de todas las fichas de producto.
 * Lee catalog.json desde R2 (vía URL pública + CF edge cache 1h).
 * Genera /libro/:id/:slug para cada item activo.
 */

const CATALOG_URL = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json';
const BASE        = 'https://www.amadolibros.com';

function slugify(text) {
    return (text || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 60);
}

async function fetchCatalog(ctx) {
    const cache    = caches.default;
    const cacheKey = new Request(CATALOG_URL);

    let resp = await cache.match(cacheKey);
    if (!resp) {
        const fetched = await fetch(CATALOG_URL);
        if (!fetched.ok) return null;
        resp = new Response(fetched.body, {
            status:  fetched.status,
            headers: {
                'Content-Type':  'application/json',
                'Cache-Control': 'public, max-age=3600',
            },
        });
        ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    }
    try {
        return await resp.json();
    } catch {
        return null;
    }
}

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
        { loc: `${BASE}/`,          changefreq: 'daily',   priority: '1.0', lastmod: today },
        { loc: `${BASE}/politicas`, changefreq: 'monthly', priority: '0.3', lastmod: today },
        { loc: `${BASE}/catalogo`,  changefreq: 'daily',   priority: '0.5', lastmod: today },
    ];

    let bookUrls = [];
    let catalogPages = [];
    const catalog = await fetchCatalog(ctx);
    if (catalog && Array.isArray(catalog.items)) {
        bookUrls = catalog.items.map(item => ({
            loc:        `${BASE}/libro/${item.id}/${slugify(item.title)}`,
            changefreq: 'weekly',
            priority:   '0.7',
            // Usar start_time real del item. Es la fecha de creación del listado en ML,
            // que es el mejor proxy de "cuándo apareció este libro" disponible en el catálogo.
            // Evita el patrón anterior donde lastmod era "hoy" para todos los items cada día,
            // lo que entrenaba a Google a creer que 7k+ páginas cambiaban diariamente.
            lastmod: toDateStr(item.start_time, today),
        }));

        // Páginas de catálogo paginado (páginas 2+ — la 1 ya está en staticPages).
        const activeCount = catalog.items.filter(b => b.status === 'active').length;
        const totalCatalogPages = Math.max(1, Math.ceil(activeCount / 200));
        for (let p = 2; p <= totalCatalogPages; p++) {
            catalogPages.push({
                loc:        `${BASE}/catalogo?page=${p}`,
                changefreq: 'daily',
                priority:   '0.4',
                lastmod:    today,
            });
        }
    }

    const allPages = [...staticPages, ...catalogPages, ...bookUrls];

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
