/**
 * functions/sitemap.xml.js
 * 
 * Tarea 1: Generación de Sitemap Dinámico (v2 - Corregido)
 * Corrige 2 fallas críticas de SEO:
 * 1. Itera sobre el catálogo para generar URLs de productos individuales.
 * 2. Fuerza el dominio canónico https://www.amadolibros.com en todas las URLs.
 */

export async function onRequest(context) {
    const KV = context.env.AMADO_KV;
    // CORRECCIÓN 2: Forzar el dominio canónico con 'www'
    const CANONICAL_BASE_URL = "https://www.amadolibros.com";

    try {
        const catalog = await KV.get("catalog:full", { type: "json" });

        if (!catalog || !Array.isArray(catalog) || catalog.length === 0) {
            return new Response(generateBasicSitemap(CANONICAL_BASE_URL), {
                headers: {
                    "content-type": "application/xml;charset=UTF-8",
                    "cache-control": "public, max-age=3600"
                },
            });
        }

        // CORRECCIÓN 1: Iterar sobre el catálogo y generar URLs de productos
        const sitemapEntries = catalog.map(item => {
            if (!item || !item.id) return '';

            // El sitio usa un parámetro de búsqueda `?book=MLU...` para mostrar productos
            const productUrl = `${CANONICAL_BASE_URL}/?book=${item.id}`;
            const escapedUrl = escapeXml(productUrl);

            return `
    <url>
        <loc>${escapedUrl}</loc>
        <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
        <changefreq>weekly</changefreq>
        <priority>0.8</priority>
    </url>`;
        }).join('');

        const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url>
        <loc>${CANONICAL_BASE_URL}/</loc>
        <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
        <changefreq>daily</changefreq>
        <priority>1.0</priority>
    </url>${sitemapEntries}
</urlset>`;

        return new Response(sitemap, {
            headers: {
                "content-type": "application/xml;charset=UTF-8",
                "cache-control": "public, max-age=21600", // Cache por 6 horas
            },
        });

    } catch (error) {
        console.error("Error generando el sitemap (v2):", error);
        return new Response(generateBasicSitemap(CANONICAL_BASE_URL), {
            status: 500,
            headers: { "content-type": "application/xml;charset=UTF-8" },
        });
    }
}

// --- Helpers ---

function generateBasicSitemap(baseUrl) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
    <priority>1.0</priority>
  </url>
</urlset>`;
}

function escapeXml(unsafe) {
    if (typeof unsafe !== 'string') return '';
    return unsafe.replace(/[<>&'"']/g, function (c) {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
        }
    });
}
