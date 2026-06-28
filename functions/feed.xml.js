/**
 * functions/feed.xml.js
 *
 * Feed RSS para Google Merchant Center (v4 — fuente única: R2 catalog.json)
 *
 * CAMBIO v4:
 *   Migrado de KV (catalog_index + item:MLU...) a R2 catalog.json.
 *   Razón: el catálogo real está en R2. La fuente KV estaba desactualizada
 *   porque el sync actual (Pages Function) escribe catalog:full, no catalog_index
 *   + item:*, que era el esquema de una versión anterior del Worker.
 *   Resultado: el feed leía datos vacíos o stale de KV.
 *
 *   Ahora usa exactamente la misma fuente que catalogo.js, sitemap.xml.js
 *   y libro/[[path]].js: R2 catalog.json vía URL pública + CF edge cache.
 *   Esto elimina la posibilidad de desincronía de slugs entre feed y fichas.
 *
 * ESTRUCTURA DE catalog.json (R2):
 *   { "items": [ { id, title, author, price, status, available_quantity,
 *                  thumbnail, pictures, permalink, start_time }, ... ] }
 *   Solo contiene items con status == "active".
 *
 */

import { slugify } from './_shared/slug.js';

const CATALOG_URL = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json';


// Idéntico al fetchCatalog de catalogo.js y sitemap.xml.js.
// Usa CF edge cache con TTL 1h para no hacer fetch a R2 en cada request.
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

export async function onRequest(context) {
    const CANONICAL_BASE_URL = "https://www.amadolibros.com";
    const SITE_TITLE = "Amado Libros";
    // Límite de items para el feed (Google procesa hasta 10M pero el Worker tiene límite de CPU)
    const MAX_ITEMS = 5000;

    try {
        const catalog = await fetchCatalog(context);
        const items = (catalog && Array.isArray(catalog.items)) ? catalog.items : [];

        if (items.length === 0) {
            return new Response(generateEmptyFeed(CANONICAL_BASE_URL, SITE_TITLE), {
                headers: { "content-type": "application/xml;charset=UTF-8", "cache-control": "public, max-age=3600" },
            });
        }

        const itemsToProcess = items.slice(0, MAX_ITEMS);
        let feedItems = '';

        for (const item of itemsToProcess) {
            if (!item || !item.id || !item.permalink) continue;

            // catalog.json usa available_quantity (no stock); currency no está presente en R2
            const stock    = item.available_quantity ?? item.stock ?? 0;
            const currency = item.currency ?? 'UYU';
            const cond     = item.condition ?? 'used';

            const availability = (stock > 0) ? 'in stock' : 'out of stock';
            const price = item.price ? `${item.price} ${currency}` : null;
            if (!price) continue; // Omitir items sin precio

            const imageLink = item.thumbnail
                ? item.thumbnail.replace('http://', 'https://').replace('-I.jpg', '-O.jpg')
                : '';

            feedItems += `
    <item>
        <g:id>${escapeXml(item.id)}</g:id>
        <g:title>${escapeXml(item.title || '')}</g:title>
        <g:description>${escapeXml(item.title || '')}</g:description>
        <g:link>${escapeXml(`${CANONICAL_BASE_URL}/libro/${item.id}/${slugify(item.title || '')}`)}</g:link>
        ${imageLink ? `<g:image_link>${escapeXml(imageLink)}</g:image_link>` : ''}
        <g:availability>${availability}</g:availability>
        <g:price>${escapeXml(price)}</g:price>
        <g:condition>${escapeXml(cond)}</g:condition>
        <g:identifier_exists>no</g:identifier_exists>
        <g:brand>Amado Libros</g:brand>
    </item>`;
        }

        const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
<channel>
    <title>${SITE_TITLE}</title>
    <link>${CANONICAL_BASE_URL}</link>
    <description>Catálogo de libros de ${SITE_TITLE} - Uruguay</description>${feedItems}
</channel>
</rss>`;

        return new Response(feed, {
            headers: {
                "content-type": "application/xml;charset=UTF-8",
                "cache-control": "public, max-age=21600", // Cache 6 horas
            },
        });

    } catch (error) {
        console.error("Error generando el feed GMC (v4):", error);
        return new Response(generateEmptyFeed(CANONICAL_BASE_URL, SITE_TITLE), {
            status: 500,
            headers: { "content-type": "application/xml;charset=UTF-8" },
        });
    }
}

function generateEmptyFeed(baseUrl, siteTitle) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
<channel>
    <title>${siteTitle}</title>
    <link>${baseUrl}</link>
    <description>Catálogo de libros de ${siteTitle} - Uruguay</description>
</channel>
</rss>`;
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
