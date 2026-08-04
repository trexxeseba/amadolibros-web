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

const LEGACY_GONE_PATHS = new Set([
    '/my-orders',
    '/2',
    '/5',
    '/30',
    '/85',
]);

function withoutTrailingSlash(pathname) {
    return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

function isLegacyCatalogPath(pathname) {
    const path = withoutTrailingSlash(pathname);

    return path === '/shop'
        || path === '/tienda'
        || path === '/mas-vendidos'
        || /^\/tienda\/page\/\d+$/.test(path)
        || /^\/page\/(?:88|95|122)$/.test(path)
        || /^\/categoria-producto(?:\/.*)?$/.test(path);
}

function legacyGonePage() {
    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, follow">
  <title>Página no disponible | Amado Libros</title>
  <style>
    body{margin:0;background:#f8f5ef;color:#243047;font-family:Arial,sans-serif}
    main{max-width:680px;margin:10vh auto;padding:32px 24px;text-align:center}
    h1{font-size:clamp(1.8rem,5vw,2.6rem);margin:0 0 16px}
    p{font-size:1.05rem;line-height:1.6;margin:0 0 24px}
    nav{display:flex;flex-wrap:wrap;justify-content:center;gap:12px}
    a{display:inline-block;border-radius:8px;padding:12px 18px;background:#173f73;color:#fff;text-decoration:none;font-weight:700}
    a.secondary{background:#fff;color:#173f73;border:1px solid #173f73}
  </style>
</head>
<body>
  <main>
    <h1>Esta página ya no está disponible</h1>
    <p>El contenido pertenecía a la versión anterior de Amado Libros. Podés buscar el libro en el catálogo o consultarnos y te ayudamos a encontrarlo.</p>
    <nav aria-label="Opciones para continuar">
      <a href="/catalogo">Buscar en el catálogo</a>
      <a class="secondary" href="/contacto">Contacto</a>
      <a class="secondary" href="https://wa.me/59899841325?text=Hola%20Amado%20Libros%2C%20busco%20un%20libro" rel="noopener noreferrer">WhatsApp</a>
    </nav>
  </main>
</body>
</html>`;
}

export function legacyResponseForRequest(request) {
    const url = new URL(request.url);
    const path = withoutTrailingSlash(url.pathname);
    const isPreview = url.hostname.endsWith('.pages.dev');

    if (isLegacyCatalogPath(url.pathname)) {
        const destination = new URL(
            '/catalogo',
            isPreview ? url.origin : 'https://www.amadolibros.com',
        );
        return Response.redirect(destination.toString(), 301);
    }

    if (LEGACY_GONE_PATHS.has(path)) {
        return new Response(legacyGonePage(), {
            status: 410,
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'X-Robots-Tag': isPreview ? 'noindex, nofollow' : 'noindex, follow',
                'Cache-Control': 'no-store',
            },
        });
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
    const isPreview = url.hostname.endsWith('.pages.dev');
    const isHashedAstroAsset = /^\/_astro\/[^/]+\.[A-Za-z0-9_-]{6,}\.(?:css|js)$/.test(url.pathname);

    // --- SEO-LEGACY-1: resolver rutas WordPress antes del fallback SPA ---
    // En Producción se apunta directamente al host canónico para evitar una
    // cadena non-www → www → /catalogo. Los parámetros legacy (por ejemplo
    // ?add-to-cart=) se descartan deliberadamente.
    const legacyResponse = legacyResponseForRequest(context.request);
    if (legacyResponse) return legacyResponse;

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
