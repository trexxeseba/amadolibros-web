/**
 * functions/feed.xml.js
 *
 * Feed RSS para Google Merchant Center (v5 — cobertura completa + GTIN/ISBN)
 *
 * SEO-GMC-FEED-1:
 *   - Elimina el tope artificial de 5.000 ítems (v4). El feed ahora publica
 *     TODO el universo elegible calculado en tiempo real desde catalog.json
 *     — nunca un número hardcodeado. El tamaño real del catálogo elegible
 *     varía con cada sync; no se asume ni se fija ningún valor.
 *   - Usa el ISBN ya presente en catalog.json (worker-sync/meli-catalog.js
 *     lo extrae de los atributos ISBN/EAN/GTIN/BAR_CODE de MercadoLibre)
 *     como <g:gtin>, validando el dígito de control antes de publicarlo.
 *     Nunca se usa el ID interno (MLU...) como GTIN.
 *   - Elimina <g:brand>Amado Libros</g:brand>: Amado Libros es el vendedor,
 *     no la marca/editorial del libro. No se reemplaza automáticamente por
 *     la editorial: `catalog.json.items[].publisher` combina de forma
 *     indistinguible los atributos PUBLISHER/EDITORIAL/BRAND de ML
 *     (worker-sync/meli-catalog.js:extractPublisher — getAttrValue no
 *     conserva cuál de los tres matcheó), así que no hay ninguna señal
 *     confiable de "esto es la marca real" separable de "esto es la
 *     editorial". Mientras esa ambigüedad exista en el origen de datos,
 *     <g:brand> se omite para todos los ítems — no se inventa ni se
 *     adivina. La editorial sí puede aparecer en <g:description> (texto
 *     bibliográfico, no una declaración de marca).
 *   - La descripción deja de repetir el título: se arma con campos reales
 *     ya presentes en catalog.json (título, autor, editorial, condición),
 *     nunca inventados.
 *   - Deduplicación controlada por GTIN+condition (decisión de Seba tras
 *     revisar el hallazgo): el 89% de los activos elegibles comparte ISBN
 *     con al menos otro MLU activo (mismo libro publicado más de una vez
 *     en MercadoLibre). Google prohíbe enviar más de una oferta con el
 *     mismo GTIN+atributos de variante (condition cuenta como atributo de
 *     variante) al mismo país/idioma, y item_group_id es solo para
 *     variantes reales — no aplica acá, son publicaciones repetidas del
 *     mismo producto, no variantes. Por cada grupo de mismo GTIN+condition
 *     se publica una sola oferta representante (ver pickRepresentativeItem);
 *     el resto de las publicaciones de ese grupo no entra al feed, pero no
 *     se toca en MercadoLibre, en catalog.json ni en la ficha — solo se
 *     excluye de /feed.xml. Un mismo GTIN puede seguir apareciendo una vez
 *     como `new` y otra como `used`: son grupos distintos. Los ítems sin
 *     GTIN válido nunca se deduplican entre sí (no hay deduplicación por
 *     semejanza de título).
 *
 * ESTRUCTURA DE catalog.json (R2) — sin cambios:
 *   { "items": [ { id, title, author, price, status, available_quantity,
 *                  thumbnail, pictures, permalink, start_time, condition,
 *                  isbn, publisher, pages, dimensions }, ... ] }
 *   Contiene únicamente activos (worker-sync/index.js runSync llama a
 *   buildCatalog con statuses:['active']). Los libros "por encargo"
 *   (pausados) viven en un manifest/índice separado y quedan
 *   deliberadamente fuera de este feed.
 */

import { slugify } from './_shared/slug.js';
import { fetchCatalog } from './_shared/catalog.js';

const CANONICAL_BASE_URL = "https://www.amadolibros.com";
const SITE_TITLE = "Amado Libros";

export async function onRequest(context) {
    try {
        const catalog = await fetchCatalog(context);
        const items = (catalog && Array.isArray(catalog.items)) ? catalog.items : [];

        if (items.length === 0) {
            return new Response(generateEmptyFeed(CANONICAL_BASE_URL, SITE_TITLE), {
                headers: { "content-type": "application/xml;charset=UTF-8", "cache-control": "public, max-age=3600" },
            });
        }

        // Universo elegible: activo + con stock + comprable (precio válido) +
        // con ficha válida (id + permalink). Calculado siempre desde los
        // datos actuales — nunca cortado a un número fijo. Los libros "por
        // encargo" (pausados) ya no llegan en `items` (ver comentario de
        // arriba), así que no hace falta filtrarlos acá explícitamente.
        const eligibleItems = items.filter(isEligibleForFeed);

        // Deduplicación controlada: una sola oferta por GTIN+condition (ver
        // comentario de cabecera). Los ítems sin GTIN válido pasan todos,
        // sin deduplicar entre sí.
        const dedupedItems = dedupeByGtinAndCondition(eligibleItems);

        // Orden determinístico por id ascendente. No es un criterio
        // comercial (no prioriza ni excluye nada más allá de la
        // deduplicación de arriba); solo evita que el feed cambie de orden
        // entre syncs por variaciones no garantizadas en el orden de
        // scroll de la API de MercadoLibre.
        const sortedItems = [...dedupedItems].sort((a, b) =>
            a.id < b.id ? -1 : a.id > b.id ? 1 : 0
        );

        let feedItems = '';
        for (const item of sortedItems) {
            feedItems += renderFeedItem(item);
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
        console.error("Error generando el feed GMC (v5):", error);
        return new Response(generateEmptyFeed(CANONICAL_BASE_URL, SITE_TITLE), {
            status: 500,
            headers: { "content-type": "application/xml;charset=UTF-8" },
        });
    }
}

// ---------------------------------------------------------------------------
// Elegibilidad
// ---------------------------------------------------------------------------

/**
 * Reglas comerciales del feed — sin cambios respecto a v4, salvo que ahora
 * no hay corte de cantidad. Activo, con stock, con precio válido, con id y
 * permalink. No excluye por condición: los usados (`condition: 'used'`)
 * siguen publicándose con su condición real.
 */
export function isEligibleForFeed(item) {
    if (!item || !item.id || !item.permalink) return false;
    if (item.status !== 'active') return false;
    if (!(Number(item.available_quantity) > 0)) return false;
    if (!(Number(item.price) > 0)) return false;
    return true;
}

// ---------------------------------------------------------------------------
// ISBN → GTIN
// ---------------------------------------------------------------------------

/**
 * Limpia un ISBN crudo de MercadoLibre: espacios, guiones y prefijos como
 * "ISBN", "ISBN-13", "ISBN-10". No corrige ni completa dígitos — solo quita
 * separadores y prefijos textuales conocidos.
 */
export function cleanIsbnRaw(raw) {
    if (raw == null) return '';
    return String(raw)
        .trim()
        .toUpperCase()
        .replace(/^ISBN(-1[03])?:?\s*/, '')
        .replace(/[\s-]+/g, '');
}

/** Valida el dígito de control de un ISBN-13 (o EAN-13 de libro). */
export function isValidIsbn13(digits) {
    if (!/^\d{13}$/.test(digits)) return false;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
    const check = (10 - (sum % 10)) % 10;
    return check === Number(digits[12]);
}

/** Valida el dígito de control de un ISBN-10 (último carácter puede ser X). */
export function isValidIsbn10(value) {
    if (!/^\d{9}[\dX]$/.test(value)) return false;
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += Number(value[i]) * (10 - i);
    sum += value[9] === 'X' ? 10 : Number(value[9]);
    return sum % 11 === 0;
}

/** Convierte un ISBN-10 ya validado a ISBN-13 (prefijo 978 + checksum nuevo). */
export function isbn10to13(isbn10) {
    const base = '978' + isbn10.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(base[i]) * (i % 2 === 0 ? 1 : 3);
    const check = (10 - (sum % 10)) % 10;
    return base + String(check);
}

/**
 * Normaliza un ISBN crudo a un GTIN publicable.
 * - hadValue: había algo no vacío en el campo isbn (para reportar cuántos
 *   son "no vacíos pero inválidos", sin publicarlos).
 * - valid: el valor limpio pasó la validación de ISBN-13 o ISBN-10.
 * - gtin: ISBN-13 listo para <g:gtin> (ISBN-10 válido ya convertido).
 * Nunca inventa, completa ni corrige dígitos — un ISBN inválido queda
 * simplemente sin GTIN, con la causa medible aparte.
 */
export function normalizeIsbnToGtin(rawIsbn) {
    const cleaned = cleanIsbnRaw(rawIsbn);
    if (!cleaned) return { gtin: null, hadValue: false, valid: false };
    if (isValidIsbn13(cleaned)) return { gtin: cleaned, hadValue: true, valid: true };
    if (isValidIsbn10(cleaned)) return { gtin: isbn10to13(cleaned), hadValue: true, valid: true };
    return { gtin: null, hadValue: true, valid: false };
}

// ---------------------------------------------------------------------------
// Deduplicación por GTIN + condition
// ---------------------------------------------------------------------------

/**
 * Dentro de un grupo de ítems con el mismo GTIN+condition, elige la oferta
 * representante con un criterio 100% determinista (no depende de la
 * posición en el array de entrada ni de `start_time`):
 *   1. mayor `available_quantity`;
 *   2. empate → menor `price`;
 *   3. empate → menor `id` (orden alfanumérico), como desempate estable.
 * Devuelve el ítem elegido tal cual — nunca mezcla campos de dos
 * publicaciones distintas ni suma cantidades entre ellas.
 */
export function pickRepresentativeItem(group) {
    return [...group].sort((a, b) => {
        const qtyA = Number(a.available_quantity) || 0;
        const qtyB = Number(b.available_quantity) || 0;
        if (qtyB !== qtyA) return qtyB - qtyA;

        const priceA = Number(a.price);
        const priceB = Number(b.price);
        if (priceA !== priceB) return priceA - priceB;

        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })[0];
}

/**
 * Agrupa los ítems elegibles por GTIN+condition y deja pasar una sola
 * oferta por grupo (ver pickRepresentativeItem). Los ítems sin GTIN válido
 * nunca se agrupan entre sí — cada uno se conserva individualmente,
 * siempre que tenga id/URL propios (ya garantizado por isEligibleForFeed).
 * No toca MercadoLibre, catalog.json ni las fichas: la exclusión es
 * exclusivamente de /feed.xml.
 */
export function dedupeByGtinAndCondition(eligibleItems) {
    const noGtinItems = [];
    const groups = new Map();

    for (const item of eligibleItems) {
        const gtinResult = normalizeIsbnToGtin(item.isbn);
        if (!gtinResult.valid) {
            noGtinItems.push(item);
            continue;
        }
        const key = `${gtinResult.gtin}|${item.condition ?? 'used'}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }

    const deduped = [];
    for (const group of groups.values()) {
        deduped.push(group.length === 1 ? group[0] : pickRepresentativeItem(group));
    }

    return [...noGtinItems, ...deduped];
}

// ---------------------------------------------------------------------------
// Editorial (solo para texto de descripción — nunca para <g:brand>)
// ---------------------------------------------------------------------------

/**
 * Mismo criterio que la ficha (functions/libro/[[path]].js:normalizePublisher):
 * descarta el placeholder "Amado Libros" cuando el atributo de origen
 * resolvió al vendedor en vez de a una editorial real. No inventa una
 * editorial cuando no hay dato.
 */
export function normalizePublisherForDescription(publisher) {
    if (!publisher) return null;
    const s = String(publisher).trim();
    if (!s || s.toUpperCase() === 'AMADO LIBROS') return null;
    return s;
}

// ---------------------------------------------------------------------------
// Descripción
// ---------------------------------------------------------------------------

/**
 * Arma una descripción breve con campos reales del catálogo, sin repetir
 * el título tal cual. catalog.json no trae hoy un campo `description`
 * propio (solo título) — si en el futuro lo tuviera, se preferiría acá
 * siempre que sea distinto del título; hasta entonces esta rama nunca se
 * activa, no es código especulativo agregado por este lote sino el primer
 * paso del algoritmo pedido.
 */
export function buildFeedDescription(item) {
    const title = (item.title || '').trim();
    if (item.description && item.description.trim() && item.description.trim() !== title) {
        return item.description.trim();
    }

    const parts = [title ? `Libro "${title}"` : 'Libro'];
    if (item.author) parts.push(`de ${item.author}`);
    const publisher = normalizePublisherForDescription(item.publisher);
    if (publisher) parts.push(`publicado por ${publisher}`);

    let sentence = parts.join(', ');
    if (item.condition === 'new') sentence += '. Ejemplar nuevo.';
    else if (item.condition === 'used') sentence += '. Ejemplar usado.';
    return sentence;
}

// ---------------------------------------------------------------------------
// Render de un <item>
// ---------------------------------------------------------------------------

export function renderFeedItem(item) {
    const stock = Number(item.available_quantity) || 0;
    const currency = item.currency ?? 'UYU';
    const cond = item.condition ?? 'used';
    const availability = stock > 0 ? 'in stock' : 'out of stock';
    const price = `${item.price} ${currency}`;

    const imageLink = item.thumbnail
        ? item.thumbnail.replace('http://', 'https://').replace('-I.jpg', '-O.jpg')
        : '';

    const isbnResult = normalizeIsbnToGtin(item.isbn);
    // GTIN válido: se omite identifier_exists (default = yes, según spec de
    // Google). Sin GTIN válido: identifier_exists=no, sin inventar uno.
    const gtinTag = isbnResult.valid
        ? `\n        <g:gtin>${escapeXml(isbnResult.gtin)}</g:gtin>`
        : '';
    const identifierExistsTag = isbnResult.valid
        ? ''
        : `\n        <g:identifier_exists>no</g:identifier_exists>`;

    const description = buildFeedDescription(item);

    return `
    <item>
        <g:id>${escapeXml(item.id)}</g:id>
        <g:title>${escapeXml(item.title || '')}</g:title>
        <g:description>${escapeXml(description)}</g:description>
        <g:link>${escapeXml(`${CANONICAL_BASE_URL}/libro/${item.id}/${slugify(item.title || '')}`)}</g:link>
        ${imageLink ? `<g:image_link>${escapeXml(imageLink)}</g:image_link>` : ''}
        <g:availability>${availability}</g:availability>
        <g:price>${escapeXml(price)}</g:price>
        <g:condition>${escapeXml(cond)}</g:condition>${gtinTag}${identifierExistsTag}
    </item>`;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

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

export function escapeXml(unsafe) {
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
