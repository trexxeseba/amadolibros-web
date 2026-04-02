/**
 * functions/feed.xml.js
 *
 * Feed RSS para Google Merchant Center (v3 — links canónicos amadolibros.com)
 *
 * CORRECCIONES v3:
 * 1. g:link apunta a /libro/{id}/{slug} en amadolibros.com (antes: permalink ML).
 *    Razón: Google Shopping debe dirigir tráfico al sitio, no a MercadoLibre.
 * 2. slugify() agregado — debe mantenerse idéntico al de libro/[[path]].js y
 *    sitemap.xml.js. Si se cambia uno, cambiar los tres.
 *
 * ADVERTENCIA — DIFERENCIA DE FUENTES DE DATOS:
 *   Este feed lee de KV (AMADO_KV, vía catalog_index + item:MLU...).
 *   Las fichas de producto SSR y el sitemap leen de R2 (catalog.json).
 *   Si ambas fuentes tienen tiempos de sincronización distintos, un item
 *   puede aparecer en el feed con un slug generado desde el título en KV
 *   que difiera del slug generado desde el título en R2 (si el título fue
 *   editado en ML entre syncs). Resultado: g:link puede apuntar a una URL
 *   diferente de la canonical del sitemap. Riesgo bajo en la práctica
 *   (los títulos rara vez cambian), pero documentado aquí.
 *
 * ESTRUCTURA DEL KV:
 *   catalog_index        → { total: N, chunks: M }
 *   catalog_index:0      → ["MLU123", "MLU456", ...]
 *   item:MLU123          → { id, title, price, currency, permalink, thumbnail, stock, condition }
 */

// Genera el slug de URL a partir del título.
// CRÍTICO: debe mantenerse idéntico al slugify de libro/[[path]].js y sitemap.xml.js.
function slugify(text) {
    return (text || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 60);
}

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
        <g:link>${escapeXml(`${CANONICAL_BASE_URL}/libro/${item.id}/${slugify(item.title || '')}`)}</g:link>
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
