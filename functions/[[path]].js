/**
 * functions/[[path]].js
 *
 * SPA Fallback — Cloudflare Pages
 *
 * Para cualquier ruta que no tenga un archivo estático correspondiente,
 * sirve index.html. Esto permite que el router del lado del cliente
 * (JavaScript en index.html) maneje la navegación.
 *
 * Las rutas /api/* son manejadas por functions/api/[[route]].js
 */

export async function onRequest(context) {
    const url = new URL(context.request.url);

    // Las rutas de API tienen su propio handler — dejar pasar
    if (url.pathname.startsWith('/api/')) {
        return context.next();
    }

    // Para todo lo demás, servir index.html (SPA routing)
    try {
        const indexUrl = new URL('/index.html', context.request.url);
        const response = await context.env.ASSETS.fetch(new Request(indexUrl.toString(), context.request));
        return new Response(response.body, {
            status: 200,
            headers: response.headers,
        });
    } catch (e) {
        return context.next();
    }
}
