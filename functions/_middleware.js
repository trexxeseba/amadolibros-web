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

    if (/^\/(?:tienda|shop)\/page\/\d+$/.test(path) || /^\/page\/\d+$/.test(path)) {
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

export async function onRequest(context) {
    const workerStartedAt = perfNow();
    const url = new URL(context.request.url);
    const isPreview = isPreviewUrl(url);
    const isHashedAstroAsset = /^\/_astro\/[^/]+\.[A-Za-z0-9_-]{6,}\.(?:css|js)$/.test(url.pathname);

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
        appendServerTiming(newHeaders, 'middleware_before', middlewareBeforeMs);
        appendServerTiming(newHeaders, 'worker_total', perfNow() - workerStartedAt);
        newHeaders.set('X-Robots-Tag',  'noindex, nofollow');
        newHeaders.set(
            'Cache-Control',
            isHashedAstroAsset
                ? 'public, max-age=31536000, immutable'
                : 'no-store',
        );
        return finish(new Response(response.body, {
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
