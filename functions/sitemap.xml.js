/**
 * functions/sitemap.xml.js
 * 
 * Tarea 1: Generación de Sitemap Dinámico (v3 - Estructura KV corregida)
 * 
 * CORRECCIONES:
 * 1. Usa la estructura real del KV: catalog_index + item:MLU...
 * 2. Fuerza el dominio canónico https://www.amadolibros.com en todas las URLs.
 * 3. Genera un bloque <url> por cada producto activo del catálogo.
 * 
 * ESTRUCTURA DEL KV:
 *   catalog_index        → { total: N, chunks: M }
 *   catalog_index:0      → ["MLU123", "MLU456", ...]
 *   catalog_index:1      → [...]
 *   item:MLU123          → { id, title, price, permalink, stock, ... }
 */

export async function onRequest(context) {
    const KV = context.env.AMADO_KV;
    const CANONICAL_BASE_URL = "https://www.amadolibros.com";
    const today = new Date().toISOString().split('T')[0];

    try {
        // 1. Leer el índice maestro
        const indexMeta = await KV.get('catalog_index', { type: 'json' });

        if (!indexMeta || !indexMeta.total || indexMeta.total === 0) {
            return new Response(generateBasicSitemap(CANONICAL_BASE_URL, today), {
                headers: {
                    "content-type": "application/xml;charset=UTF-8",
                    "cache-control": "public, max-age=3600"
                },
            });
        }

        // 2. Cargar todos los IDs desde los chunks del índice
        let allIds = [];
        const numChunks = indexMeta.chunks || 1;
        for (let i = 0; i < numChunks; i++) {
            const chunk = await KV.get(`catalog_index:${i}`, { type: 'json' });
            if (chunk && Array.isArray(chunk)) {
                allIds = allIds.concat(chunk);
            }
        }

        if (allIds.length === 0) {
            return new Response(generateBasicSitemap(CANONICAL_BASE_URL, today), {
                headers: {
                    "content-type": "application/xml;charset=UTF-8",
                    "cache-control": "public, max-age=3600"
                },
            });
        }

        // 3. Generar entradas del sitemap usando los IDs
        // Para el sitemap NO necesitamos cargar cada item individualmente.
        // La URL del producto se construye directamente desde el ID.
        const sitemapEntries = allIds.map(id => {
            if (!id) return '';
            // URL canónica del producto en el sitio
            const productUrl = `${CANONICAL_BASE_URL}/?book=${escapeXml(String(id))}`;
            return `
    <url>
        <loc>${productUrl}</loc>
        <lastmod>${today}</lastmod>
        <changefreq>weekly</changefreq>
        <priority>0.8</priority>
    </url>`;
        }).join('');

        const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url>
        <loc>${CANONICAL_BASE_URL}/</loc>
        <lastmod>${today}</lastmod>
        <changefreq>daily</changefreq>
        <priority>1.0</priority>
    </url>${sitemapEntries}
</urlset>`;

        return new Response(sitemap, {
            headers: {
                "content-type": "application/xml;charset=UTF-8",
                "cache-control": "public, max-age=21600", // Cache 6 horas
            },
        });

    } catch (error) {
        console.error("Error generando el sitemap (v3):", error);
        return new Response(generateBasicSitemap(CANONICAL_BASE_URL, today), {
            status: 500,
            headers: { "content-type": "application/xml;charset=UTF-8" },
        });
    }
}

function generateBasicSitemap(baseUrl, today) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <lastmod>${today}</lastmod>
    <priority>1.0</priority>
  </url>
</urlset>`;
}

function escapeXml(unsafe) {
    if (typeof unsafe !== 'string') return '';
    return unsafe.replace(/[<>&'"]/g, function (c) {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case "'": return '&apos;';
            case '"': return '&quot;';
        }
    });
}
