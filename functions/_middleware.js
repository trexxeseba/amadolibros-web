/**
 * functions/_middleware.js
 *
 * Middleware global — se ejecuta antes que cualquier otro Function o asset.
 *
 * SEO-LEGACY-URL-CLEANUP-1:
 * - normaliza URLs históricas de WordPress/WooCommerce antes del routing actual;
 * - 301 únicamente cuando existe un reemplazo inequívoco;
 * - 410 cuando el contenido legacy no tiene equivalente;
 * - evita cadenas non-www -> www -> destino;
 * - no modifica URLs actuales salvo quitar el parámetro de presentación `layout`.
 *
 * SEO-CRAWL-LOGS-3:
 * - agenda observabilidad de crawl fuera del camino crítico con waitUntil();
 * - nunca lee/bufferea el body de respuesta para medir bytes;
 * - el flag, muestreo, verificación Googlebot y escritura D1 ocurren en background.
 *
 * Además conserva las protecciones existentes de Preview y cache de assets Astro.
 */

import { perfNow } from './_shared/perf.js';
import { BASE, fetchCatalog, fetchPausedItem } from './_shared/catalog.js';
import { slugify } from './_shared/slug.js';
import { goneResponse } from './_shared/gone.js';
import { scheduleCrawlAnalytics } from './_shared/crawl-analytics.js';
import { getPreviewBookIntelligenceEntry } from './_shared/book-intelligence-enrichment-preview.js';

const LEGACY_ROOT_REDIRECTS = [
    { pattern: /^\/(?:shop|tienda|mas-vendidos)$/, destination: '/catalogo', name: 'legacy_root_catalog' },
    { pattern: /^\/my-orders$/, destination: '/contacto', name: 'legacy_my_orders' },
];

export const LEGACY_CATEGORY_MAP = Object.freeze({
    'libros-revistas-y-comics': '/catalogo',
    'novelas': '/libros/literatura-ficcion',
    'infantil-juvenil': '/libros/infantil-juvenil',
    'esoterismo-tarot': '/libros/esoterismo-tarot',
    'medicina-salud': '/libros/medicina-salud',
    'literatura-ficcion': '/libros/literatura-ficcion',
    'idiomas-aprendizaje': '/libros/idiomas-aprendizaje',
    'psicologia': '/libros/psicologia',
    'desarrollo-personal': '/libros/desarrollo-personal',
    'religion-espiritualidad': '/libros/religion-espiritualidad',
});

const BOOK_INTELLIGENCE_PRODUCT_RE = /^\/libro\/(MLU\d+)(?:\/|$)/i;
const BOOK_INTELLIGENCE_MARKER = 'data-book-intelligence-preview="v1"';
const BOOK_INTELLIGENCE_FACT_LABELS = Object.freeze({
    publisher: 'Editorial',
    pages: 'Páginas',
    language: 'Idioma',
    publication_year: 'Año',
    format: 'Formato',
});

function withoutTrailingSlash(pathname) {
    return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

function safeDecodeURIComponent(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function isPreviewUrl(url) {
    return url.hostname.endsWith('.pages.dev');
}

function navigationBase(url) {
    return isPreviewUrl(url) ? url.origin : BASE;
}

function redirectTo(url, destination) {
    return Response.redirect(new URL(destination, navigationBase(url)).toString(), 301);
}

function logLegacy(request, pattern, response, destination = null) {
    const userAgent = request.headers.get('user-agent') || '';
    console.log(JSON.stringify({
        event: 'seo_legacy_url_cleanup',
        pattern,
        path: new URL(request.url).pathname,
        status: response.status,
        destination,
        googlebotUa: /Googlebot/i.test(userAgent),
    }));
}

function goneFor(request, pattern) {
    const response = goneResponse();
    logLegacy(request, pattern, response);
    return response;
}

function redirectFor(request, pattern, destination) {
    const url = new URL(request.url);
    const response = redirectTo(url, destination);
    logLegacy(request, pattern, response, response.headers.get('location'));
    return response;
}

async function lookupLegacyBook(context, id) {
    let catalog;
    try {
        catalog = await fetchCatalog(context);
    } catch {
        return { state: 'unavailable' };
    }

    if (!catalog || !Array.isArray(catalog.items)) {
        return { state: 'unavailable' };
    }

    const active = catalog.items.find(item => item?.id === id);
    if (active) return { state: 'found', item: active };

    if (['preview', 'production'].includes(context.env?.APP_ENV)) {
        try {
            const paused = await fetchPausedItem(context, id);
            if (paused) return { state: 'found', item: paused };
        } catch {
            return { state: 'unavailable' };
        }
    }

    return { state: 'missing' };
}

export async function legacyResponseForRequest(context, options = {}) {
    const request = context.request;
    const url = new URL(request.url);
    const path = withoutTrailingSlash(url.pathname);
    const lookupBook = options.lookupBook || lookupLegacyBook;

    if (url.searchParams.has('book')) {
        const id = String(url.searchParams.get('book') || '').trim().toUpperCase();
        if (!/^MLU\d+$/.test(id)) return goneFor(request, 'query_book_invalid');

        const result = await lookupBook(context, id);
        if (result?.state === 'unavailable') {
            const response = new Response('Servicio temporalmente no disponible', {
                status: 503,
                headers: {
                    'content-type': 'text/plain;charset=UTF-8',
                    'cache-control': 'no-store',
                    'retry-after': '60',
                },
            });
            logLegacy(request, 'query_book_catalog_unavailable', response);
            return response;
        }
        if (result?.state !== 'found' || !result.item?.title) {
            return goneFor(request, 'query_book_missing');
        }

        const destination = `/libro/${id}/${slugify(result.item.title)}`;
        return redirectFor(request, 'query_book_resolved', destination);
    }

    if (url.searchParams.has('add-to-cart')) {
        return goneFor(request, 'query_add_to_cart');
    }

    // SEO-LEGACY-TIENDA-PAGINATION: Search Console todavía atribuye clics e
    // impresiones de marca a /tienda/page/N. La tienda legacy sí tiene un
    // reemplazo inequívoco en /catalogo, pero el número de página histórico no
    // garantiza el mismo conjunto/orden de libros, por eso no se traslada N.
    if (/^\/tienda\/page\/\d+$/.test(path)) {
        return redirectFor(request, 'legacy_tienda_pagination_catalog', '/catalogo');
    }

    if (/^\/shop\/page\/\d+$/.test(path) || /^\/page\/\d+$/.test(path)) {
        return goneFor(request, 'legacy_pagination');
    }

    if (path === '/categoria-producto') {
        return redirectFor(request, 'legacy_category_root', '/catalogo');
    }
    const categoryMatch = path.match(/^\/categoria-producto\/([^/]+)$/);
    if (categoryMatch) {
        const legacySlug = safeDecodeURIComponent(categoryMatch[1]).toLowerCase();
        const destination = LEGACY_CATEGORY_MAP[legacySlug];
        if (destination) return redirectFor(request, 'legacy_category_mapped', destination);
        return goneFor(request, 'legacy_category_unmapped');
    }
    if (/^\/categoria-producto(?:\/|$)/.test(path)) {
        return goneFor(request, 'legacy_category_pagination_or_nested');
    }

    const rootRule = LEGACY_ROOT_REDIRECTS.find(({ pattern }) => pattern.test(path));
    if (rootRule) {
        return redirectFor(request, rootRule.name, rootRule.destination);
    }

    if (url.searchParams.has('layout')) {
        const clean = new URL(url.toString());
        clean.searchParams.delete('layout');
        const destination = `${clean.pathname}${clean.search}`;
        return redirectFor(request, 'query_layout_normalized', destination);
    }

    return null;
}

function appendServerTiming(headers, name, duration) {
    const rounded = Math.round(duration * 100) / 100;
    const current = headers.get('Server-Timing');
    headers.set(
        'Server-Timing',
        current ? `${current}, ${name};dur=${rounded}` : `${name};dur=${rounded}`,
    );
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function previewIntelligenceStyles() {
    return `
    .book-intelligence-preview{grid-column:1/-1;margin:1.15rem 0;background:#fff;border:1px solid #ded8cf;
      border-radius:.8rem;padding:1.25rem 1.35rem;box-shadow:0 8px 24px rgba(15,23,42,.045)}
    .book-intelligence-preview .bip-eyebrow{margin:0 0 .3rem;color:#8f4436;font-size:.76rem;font-weight:850;
      letter-spacing:.055em;text-transform:uppercase}
    .book-intelligence-preview h2{margin:0;color:#18120e;font-size:1.25rem;line-height:1.3}
    .book-intelligence-preview .bip-note{margin:.45rem 0 0;color:#64748b;font-size:.82rem;line-height:1.5}
    .book-intelligence-preview .bip-topics{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0 0;padding:0;list-style:none}
    .book-intelligence-preview .bip-topics li{padding:.45rem .65rem;background:#fff8f4;border:1px solid #ecd1c6;
      border-radius:999px;color:#5e3b32;font-size:.84rem;line-height:1.25}
    .book-intelligence-preview .bip-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.55rem 1rem;
      margin:1rem 0 0;padding-top:1rem;border-top:1px solid #eef2f7}
    .book-intelligence-preview .bip-fact{display:grid;grid-template-columns:105px 1fr;gap:.6rem;font-size:.84rem}
    .book-intelligence-preview .bip-fact dt{font-weight:800;color:#334155}
    .book-intelligence-preview .bip-fact dd{margin:0;color:#475569}
    .book-intelligence-preview details{margin-top:1rem;padding-top:.85rem;border-top:1px solid #eef2f7}
    .book-intelligence-preview summary{cursor:pointer;color:#64748b;font-size:.8rem;font-weight:750}
    .book-intelligence-preview .bip-sources{display:flex;flex-wrap:wrap;gap:.45rem .85rem;margin-top:.55rem}
    .book-intelligence-preview .bip-sources a{color:#8f4436;font-size:.8rem;font-weight:750;text-decoration:none}
    .book-intelligence-preview .bip-sources a:hover{text-decoration:underline}
    @media(max-width:620px){
      .book-intelligence-preview{padding:1.05rem}
      .book-intelligence-preview .bip-facts{grid-template-columns:1fr}
    }
    `;
}

function sourceLabel(source) {
    if (source?.source === 'publisher') return 'Fuente editorial';
    if (source?.source === 'author_site') return 'Sitio oficial de autor';
    if (source?.source === 'national_library' || source?.source === 'library_catalog') return 'Catálogo bibliográfico';
    return 'Fuente bibliográfica';
}

function renderPreviewBookIntelligence(entry) {
    const topics = Array.isArray(entry?.work?.topic_seeds)
        ? entry.work.topic_seeds.filter(Boolean).slice(0, 8)
        : [];
    const editionFields = entry?.edition?.auto_publishable_fields || {};
    const facts = Object.entries(BOOK_INTELLIGENCE_FACT_LABELS)
        .filter(([field]) => editionFields[field]?.value !== undefined && editionFields[field]?.value !== null && editionFields[field]?.value !== '')
        .map(([field, label]) => ({ label, value: editionFields[field].value }));
    const seenUrls = new Set();
    const sources = (Array.isArray(entry?.provenance) ? entry.provenance : [])
        .filter(source => source?.official && /^https:\/\//i.test(String(source?.url || '')))
        .filter(source => {
            if (seenUrls.has(source.url)) return false;
            seenUrls.add(source.url);
            return true;
        })
        .slice(0, 3);

    if (topics.length === 0 && facts.length === 0) return '';

    const topicsHtml = topics.length
        ? `<ul class="bip-topics">${topics.map(topic => `<li>${escapeHtml(topic)}</li>`).join('')}</ul>`
        : '';
    const factsHtml = facts.length
        ? `<dl class="bip-facts">${facts.map(fact => `<div class="bip-fact"><dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(fact.value)}</dd></div>`).join('')}</dl>`
        : '';
    const sourcesHtml = sources.length
        ? `<details><summary>Fuentes consultadas</summary><div class="bip-sources">${sources.map(source => `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(sourceLabel(source))}</a>`).join('')}</div></details>`
        : '';

    return `<section class="book-intelligence-preview" ${BOOK_INTELLIGENCE_MARKER} aria-labelledby="book-intelligence-preview-title">
      <p class="bip-eyebrow">Sobre este libro</p>
      <h2 id="book-intelligence-preview-title">Temas de esta obra</h2>
      <p class="bip-note">Información contrastada con fuentes editoriales y bibliográficas.</p>
      ${topicsHtml}
      ${factsHtml}
      ${sourcesHtml}
    </section>`;
}

export function enrichPreviewBookIntelligenceHtml(html, entry) {
    const source = String(html || '');
    if (!entry || entry.decision !== 'auto_publish' || source.includes(BOOK_INTELLIGENCE_MARKER)) return source;
    const block = renderPreviewBookIntelligence(entry);
    if (!block) return source;

    let result = source;
    const markers = ['<section class="related-books"', '<section class="order-hub-links"'];
    const insertionIndex = markers
        .map(marker => result.indexOf(marker))
        .filter(index => index >= 0)
        .sort((a, b) => a - b)[0];
    result = insertionIndex >= 0
        ? `${result.slice(0, insertionIndex)}${block}\n  ${result.slice(insertionIndex)}`
        : result.replace('</main>', `${block}\n</main>`);

    if (!result.includes('.book-intelligence-preview{')) {
        result = result.replace('</style>', `${previewIntelligenceStyles()}\n  </style>`);
    }
    return result;
}

export async function onRequest(context) {
    const workerStartedAt = perfNow();
    const url = new URL(context.request.url);
    const isPreview = isPreviewUrl(url);
    const isHashedAstroAsset = /^\/_astro\/[^/]+\.[A-Za-z0-9_-]{6,}\.(?:css|js)$/.test(url.pathname);
    const previewProductId = isPreview
        ? url.pathname.match(BOOK_INTELLIGENCE_PRODUCT_RE)?.[1]?.toUpperCase() || null
        : null;

    const finish = response => {
        if (!isHashedAstroAsset) {
            scheduleCrawlAnalytics(context, response, perfNow() - workerStartedAt);
        }
        return response;
    };

    const legacyResponse = await legacyResponseForRequest(context);
    if (legacyResponse) return finish(legacyResponse);

    if (!isPreview && url.hostname === 'amadolibros.com') {
        url.hostname = 'www.amadolibros.com';
        return finish(Response.redirect(url.toString(), 301));
    }

    if (isPreview && url.pathname.startsWith('/api/webhooks/mercadolibre')) {
        return finish(new Response('Forbidden on preview', {
            status: 403,
            headers: {
                'Content-Type':  'text/plain; charset=utf-8',
                'X-Robots-Tag':  'noindex, nofollow',
                'Cache-Control': 'no-store',
            },
        }));
    }

    if (isPreview) {
        const middlewareBeforeMs = perfNow() - workerStartedAt;
        const response = await context.next();
        const newHeaders = new Headers(response.headers);
        let body = response.body;

        if (previewProductId && response.status === 200 && (response.headers.get('content-type') || '').toLowerCase().includes('text/html')) {
            const intelligenceStartedAt = perfNow();
            const entry = await getPreviewBookIntelligenceEntry(context.env, previewProductId);
            appendServerTiming(newHeaders, 'book_intel', perfNow() - intelligenceStartedAt);
            if (entry) {
                const html = await response.text();
                body = enrichPreviewBookIntelligenceHtml(html, entry);
                newHeaders.delete('content-length');
                newHeaders.delete('etag');
            }
        }

        appendServerTiming(newHeaders, 'middleware_before', middlewareBeforeMs);
        appendServerTiming(newHeaders, 'worker_total', perfNow() - workerStartedAt);
        newHeaders.set('X-Robots-Tag',  'noindex, nofollow');
        newHeaders.set(
            'Cache-Control',
            isHashedAstroAsset
                ? 'public, max-age=31536000, immutable'
                : 'no-store',
        );
        return finish(new Response(body, {
            status:     response.status,
            statusText: response.statusText,
            headers:    newHeaders,
        }));
    }

    if (isHashedAstroAsset) {
        const response = await context.next();
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Cache-Control', 'public, max-age=31536000, immutable');
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
        });
    }

    // Producción también expone el tramo que antes quedaba fuera de los
    // timers de cada ruta. Así `worker_total` se puede comparar contra el
    // TTFB externo y `/api/health` funciona como control sin R2 ni SSR.
    const middlewareBeforeMs = perfNow() - workerStartedAt;
    const response = await context.next();
    const newHeaders = new Headers(response.headers);
    appendServerTiming(newHeaders, 'middleware_before', middlewareBeforeMs);
    appendServerTiming(newHeaders, 'worker_total', perfNow() - workerStartedAt);
    return finish(new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
    }));
}
