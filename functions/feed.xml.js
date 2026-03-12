/**
 * functions/feed.xml.js
 * 
 * Tarea 2: Feed para Google Merchant Center (v2 - Estructura KV corregida)
 * 
 * CORRECCIONES:
 * 1. Usa la estructura real del KV: catalog_index + item:MLU...
 * 2. Procesa los items en lotes para no exceder el tiempo de CPU del Worker.
 * 3. Fuerza el dominio canónico https://www.amadolibros.com.
 * 
 * ESTRUCTURA DEL KV:
 *   catalog_index        → { total: N, chunks: M }
 *   catalog_index:0      → ["MLU123", "MLU456", ...]
 *   item:MLU123          → { id, title, price, currency, permalink, thumbnail, stock, condition }
 */

export async function onRequest(context) {
    const KV = context.env.AMADO_KV;
    const CANONICAL_BASE_URL = "https://www.amadolibros.com";
    const SITE_TITLE = "Amado Libros";
    // Límite de items para el feed (Google procesa hasta 10M pero el Worker tiene límite de CPU)
    const MAX_ITEMS = 5000;

    try {
        // 1. Leer el índice maestro
        const indexMeta = await KV.get('catalog_index', { type: 'json' });

        if (!indexMeta || !indexMeta.total || indexMeta.total === 0) {
            return new Response(generateEmptyFeed(CANONICAL_BASE_URL, SITE_TITLE), {
                headers: { "content-type": "application/xml;charset=UTF-8", "cache-control": "public, max-age=3600" },
            });
        }

        // 2. Cargar todos los IDs desde los chunks
        let allIds = [];
        const numChunks = indexMeta.chunks || 1;
        for (let i = 0; i < numChunks; i++) {
            const chunk = await KV.get(`catalog_index:${i}`, { type: 'json' });
            if (chunk && Array.isArray(chunk)) {
                allIds = allIds.concat(chunk);
            }
        }

        // Limitar para no exceder el tiempo de CPU del Worker
        const idsToProcess = allIds.slice(0, MAX_ITEMS);

        // 3. Cargar los detalles de cada item en lotes de 50
        const BATCH_SIZE = 50;
        let feedItems = '';
        for (let i = 0; i < idsToProcess.length; i += BATCH_SIZE) {
            const batch = idsToProcess.slice(i, i + BATCH_SIZE);
            const items = await Promise.all(
                batch.map(id => KV.get(`item:${id}`, { type: 'json' }).catch(() => null))
            );

            for (const item of items) {
                if (!item || !item.id || !item.permalink) continue;

                const availability = (item.stock > 0) ? 'in stock' : 'out of stock';
                const price = item.price ? `${item.price} ${item.currency || 'UYU'}` : null;
                if (!price) continue; // Omitir items sin precio

                const imageLink = item.thumbnail
                    ? item.thumbnail.replace('http://', 'https://').replace('-I.jpg', '-O.jpg')
                    : '';

                feedItems += `
    <item>
        <g:id>${escapeXml(item.id)}</g:id>
        <g:title>${escapeXml(item.title || '')}</g:title>
        <g:description>${escapeXml(item.title || '')}</g:description>
        <g:link>${escapeXml(item.permalink)}</g:link>
        ${imageLink ? `<g:image_link>${escapeXml(imageLink)}</g:image_link>` : ''}
        <g:availability>${availability}</g:availability>
        <g:price>${escapeXml(price)}</g:price>
        <g:condition>${escapeXml(item.condition || 'used')}</g:condition>
        <g:identifier_exists>no</g:identifier_exists>
        <g:brand>Amado Libros</g:brand>
    </item>`;
            }
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
        console.error("Error generando el feed GMC (v2):", error);
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
