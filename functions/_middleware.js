/**
 * functions/_middleware.js
 *
 * Middleware global — se ejecuta antes que cualquier otro Function o asset.
 *
 * 1. Enforza el host canónico www.amadolibros.com con 301 permanente.
 *    (solo en producción; en preview .pages.dev el redirect no aplica)
 *
 * 2. En preview (hostname termina en .pages.dev):
 *    - Bloquea el webhook de Mercado Libre con 403 para evitar escrituras
 *      accidentales al KV de producción.
 *    - Inyecta X-Robots-Tag: noindex y Cache-Control: no-store en todas
 *      las respuestas de Pages Functions (los assets estáticos ya quedan
 *      cubiertos por astro-front/public/_headers).
 */

import { perfNow } from './_shared/perf.js';
import { fetchCatalog } from './_shared/catalog.js';
import { slugify } from './_shared/slug.js';

const LEGACY_REDIRECTS = [
    { pattern: /^\/(?:shop|tienda|mas-vendidos)$/, destination: '/catalogo' },
    { pattern: /^\/(?:shop|tienda)\/page\/\d+$/, destination: '/catalogo' },
    { pattern: /^\/page\/\d+$/, destination: '/catalogo' },
    { pattern: /^\/my-orders$/, destination: '/contacto' },
];

const LEGACY_CATEGORY_DESTINATIONS = new Map([
    ['infantil-juvenil', '/libros/infantil-juvenil'],
    ['infantil-y-juvenil', '/libros/infantil-juvenil'],
    ['literatura-infantil-y-juvenil', '/libros/infantil-juvenil'],
    ['esoterismo-tarot', '/libros/esoterismo-tarot'],
    ['esoterismo-y-tarot', '/libros/esoterismo-tarot'],
    ['tarot', '/libros/esoterismo-tarot'],
    ['medicina-salud', '/libros/medicina-salud'],
    ['medicina-y-salud', '/libros/medicina-salud'],
    ['literatura-ficcion', '/libros/literatura-ficcion'],
    ['literatura-y-ficcion', '/libros/literatura-ficcion'],
    ['idiomas', '/libros/idiomas-aprendizaje'],
    ['idiomas-aprendizaje', '/libros/idiomas-aprendizaje'],
    ['idiomas-y-aprendizaje', '/libros/idiomas-aprendizaje'],
    ['psicologia', '/libros/psicologia'],
    ['desarrollo-personal', '/libros/desarrollo-personal'],
    ['religion-espiritualidad', '/libros/religion-espiritualidad'],
    ['religion-y-espiritualidad', '/libros/religion-espiritualidad'],
]);

function withoutTrailingSlash(pathname) {
    return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

function navigationBase(url) {
    return url.hostname.endsWith('.pages.dev')
        ? url.origin
        : 'https://www.amadolibros.com';
}

function permanentRedirect(url, destination) {
    return Response.redirect(new URL(destination, navigationBase(url)).toString(), 301);
}

function goneResponse() {
    return new Response('Gone', {
        status: 410,
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'public, max-age=86400',
            'X-Robots-Tag': 'noindex, nofollow',
        },
    });
}

function legacyCategoryDestination(path) {
    const match = path.match(/^\/categoria-producto(?:\/(.*))?$/);
    if (!match) return null;

    const segments = (match[1] || '')
        .split('/')
        .filter(segment => segment && segment !== 'page' && !/^\d+$/.test(segment));
    for (const segment of segments.reverse()) {
        const destination = LEGACY_CATEGORY_DESTINATIONS.get(segment);
        if (destination) return destination;
    }
    return '/catalogo';
}

function legacyBookParam(url) {
    for (const [key, value] of url.searchParams) {
        if (key.toLowerCase() === 'book') return value.trim().toUpperCase();
    }
    return null;
}

/**
 * Recupera autoridad de URLs de WordPress con un reemplazo actual claro.
 *
 * Los parámetros viejos se descartan deliberadamente. En Producción se
 * apunta directamente al host canónico para evitar la cadena
 * non-www -> www -> destino; Preview conserva su propio host.
 */
export function legacyRedirectForRequest(request) {
    const url = new URL(request.url);
    const path = withoutTrailingSlash(url.pathname);
    const categoryDestination = legacyCategoryDestination(path);

    if (categoryDestination) return permanentRedirect(url, categoryDestination);

    const rule = LEGACY_REDIRECTS.find(({ pattern }) => pattern.test(path));
    if (rule) return permanentRedirect(url, rule.destination);

    if (/^\/wp-content\/plugins(?:\/|$)/.test(path)) return goneResponse();

    // `?book=MLU...` necesita consultar el catálogo y se resuelve en la
    // función asíncrona de abajo. No lo limpiamos primero para evitar dos
    // saltos: URL vieja -> URL sin otros parámetros -> ficha actual.
    if (legacyBookParam(url) !== null) return null;

    const cleanedUrl = new URL(url.toString());
    let changed = false;
    for (const key of [...cleanedUrl.searchParams.keys()]) {
        const normalizedKey = key.toLowerCase();
        const isLegacyLayout = normalizedKey === 'layout'
            && cleanedUrl.searchParams.get(key)?.toLowerCase() === 'list';
        if (normalizedKey === 'add-to-cart' || isLegacyLayout) {
            cleanedUrl.searchParams.delete(key);
            changed = true;
        }
    }

    if (!changed) return null;

    const destination = `${cleanedUrl.pathname}${cleanedUrl.search}${cleanedUrl.hash}`;
    return permanentRedirect(url, destination);
}

/**
 * Resuelve el antiguo `?book=MLU...` directamente a la ficha canónica.
 * Solo consulta R2 cuando ese parámetro existe, por lo que no agrega trabajo
 * a las solicitudes normales. Un fallo temporal del catálogo responde 503:
 * nunca convierte por error una ficha válida en 410 permanente.
 */
export async function legacyBookRedirectForRequest(context, getCatalog = fetchCatalog) {
    const url = new URL(context.request.url);
    const id = legacyBookParam(url);

    if (id === null) return null;
    if (!/^MLU\d+$/.test(id)) return goneResponse();

    const catalog = await getCatalog(context);
    if (!catalog || !Array.isArray(catalog.items)) {
        return new Response('Catalog temporarily unavailable', {
            status: 503,
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store',
                'Retry-After': '60',
                'X-Robots-Tag': 'noindex, nofollow',
            },
        });
    }

    const item = catalog.items.find(candidate =>
        String(candidate?.id || '').toUpperCase() === id
        && candidate?.status === 'active'
        && Number(candidate?.available_quantity) > 0
    );
    if (!item) return goneResponse();

    return permanentRedirect(url, `/libro/${id}/${slugify(item.title)}`);
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
    const isPreview = url.hostname.endsWith('.pages.dev');
    const isHashedAstroAsset = /^\/_astro\/[^/]+\.[A-Za-z0-9_-]{6,}\.(?:css|js)$/.test(url.pathname);

    // --- SEO-P3: redirecciones selectivas de la tienda WordPress anterior ---
    const legacyRedirect = legacyRedirectForRequest(context.request);
    if (legacyRedirect) return legacyRedirect;

    const legacyBookRedirect = await legacyBookRedirectForRequest(context);
    if (legacyBookRedirect) return legacyBookRedirect;

    // --- Producción: redirect non-www → www ---
    if (!isPreview && url.hostname === 'amadolibros.com') {
        url.hostname = 'www.amadolibros.com';
        return Response.redirect(url.toString(), 301);
    }

    // --- Preview: bloquear webhook Mercado Libre ---
    if (isPreview && url.pathname.startsWith('/api/webhooks/mercadolibre')) {
        return new Response('Forbidden on preview', {
            status: 403,
            headers: {
                'Content-Type':  'text/plain; charset=utf-8',
                'X-Robots-Tag':  'noindex, nofollow',
                'Cache-Control': 'no-store',
            },
        });
    }

    // --- Preview: inyectar noindex en todas las respuestas de functions ---
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
        return new Response(response.body, {
            status:     response.status,
            statusText: response.statusText,
            headers:    newHeaders,
        });
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

    return context.next();
}
