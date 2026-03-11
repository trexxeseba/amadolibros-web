/**
 * functions/feed.xml.js
 * 
 * Tarea 2: Automatización del Feed para Google Merchant Center
 * Esta Cloudflare Pages Function genera un feed.xml en formato RSS 2.0 compatible con Google.
 * Se ejecuta cada vez que Google (o un usuario) accede a /feed.xml.
 */

export async function onRequest(context) {
    const KV = context.env.AMADO_KV;
    const BASE_URL = "https://www.amadolibros.com";
    const SITE_TITLE = "Amado Libros";

    try {
        const catalog = await KV.get("catalog:full", { type: "json" });

        if (!catalog || !Array.isArray(catalog) || catalog.length === 0) {
            return new Response(generateEmptyFeed(BASE_URL, SITE_TITLE), {
                headers: { "content-type": "application/xml;charset=UTF-8", "cache-control": "public, max-age=3600" },
            });
        }

        const feedItems = catalog.map(item => {
            if (!item || !item.id || !item.permalink) return ";

            const availability = item.stock > 0 ? 'in stock' : 'out of stock';
            
            // NOTA: La descripción detallada no está en el objeto del catálogo principal.
            // Usamos el título como fallback. Para una descripción completa, se necesitaría
            // una llamada adicional a la API de ML por cada item o enriquecer el objeto en KV.
            const description = item.title;

            // NOTA: El GTIN/ISBN no está en el objeto del catálogo.
            // Google requiere esto para libros. Se marca <g:identifier_exists> como 'no'.
            // Para una optimización completa, se debería añadir el ISBN al objeto en KV.
            const gtinEntry = `<g:identifier_exists>no</g:identifier_exists>`;

            return `
    <item>
        <g:id>${escapeXml(item.id)}</g:id>
        <g:title>${escapeXml(item.title)}</g:title>
        <g:description>${escapeXml(description)}</g:description>
        <g:link>${escapeXml(item.permalink)}</g:link>
        <g:image_link>${escapeXml(item.thumbnail)}</g:image_link>
        <g:availability>${availability}</g:availability>
        <g:price>${item.price} ${item.currency}</g:price>
        <g:condition>${item.condition || 'used'}</g:condition>
        ${gtinEntry}
        <g:brand>Amado Libros</g:brand>
    </item>`;
        }).join("");

        const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
<channel>
    <title>${SITE_TITLE}</title>
    <link>${BASE_URL}</link>
    <description>Catálogo de productos de ${SITE_TITLE}</description>${feedItems}
</channel>
</rss>`;

        return new Response(feed, {
            headers: {
                "content-type": "application/xml;charset=UTF-8",
                // Cacheamos el feed por 6 horas. Google no lo necesita más frecuente.
                "cache-control": "public, max-age=21600",
            },
        });

    } catch (error) {
        console.error("Error generando el feed de GMC:", error);
        return new Response(generateEmptyFeed(BASE_URL, SITE_TITLE), {
            status: 500,
            headers: { "content-type": "application/xml;charset=UTF-8" },
        });
    }
}

// --- Helpers ---

function generateEmptyFeed(baseUrl, siteTitle) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
<channel>
    <title>${siteTitle}</title>
    <link>${baseUrl}</link>
    <description>Catálogo de productos de ${siteTitle}</description>
</channel>
</rss>`;
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
