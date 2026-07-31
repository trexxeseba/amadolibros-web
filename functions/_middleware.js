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
