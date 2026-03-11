/**
 * functions/sitemap.xml.js
 * 
 * Tarea 1: Generación de Sitemap Dinámico
 * Esta Cloudflare Pages Function genera un sitemap.xml sobre la marcha.
 * Se ejecuta cada vez que un usuario o un motor de búsqueda accede a /sitemap.xml.
 */

export async function onRequest(context) {
    // El binding al KV se configura en el dashboard de Cloudflare Pages
    const KV = context.env.AMADO_KV;
    const BASE_URL = "https://www.amadolibros.com";

    try {
        // Estrategia 1: Intentar obtener el catálogo completo desde la llave única.
        // Es más rápido que obtener miles de llaves individuales.
        const catalog = await KV.get("catalog:full", { type: "json" });

        if (!catalog || !Array.isArray(catalog) || catalog.length === 0) {
            // Si no hay catálogo, devolver un sitemap básico para no dar un error 404.
            return new Response(generateBasicSitemap(BASE_URL), {
                headers: {
                    "content-type": "application/xml;charset=UTF-8",
                    "cache-control": "public, max-age=3600" // Cache por 1 hora
                },
            });
        }

        const sitemapEntries = catalog.map(item => {
            // Aseguramos que el item tiene un permalink válido
            if (!item || !item.permalink) return '';

            // Escapamos la URL para XML por si contiene caracteres especiales
            const escapedUrl = escapeXml(item.permalink);

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
        <loc>${BASE_URL}/</loc>
        <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
        <changefreq>daily</changefreq>
        <priority>1.0</priority>
    </url>${sitemapEntries}
</urlset>`;

        return new Response(sitemap, {
            headers: {
                "content-type": "application/xml;charset=UTF-8",
                // Cacheamos el sitemap por 6 horas para no sobrecargar el KV
                "cache-control": "public, max-age=21600",
            },
        });

    } catch (error) {
        console.error("Error generando el sitemap:", error);
        // En caso de error, devolver un sitemap básico y loguear el problema.
        return new Response(generateBasicSitemap(BASE_URL), {
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
