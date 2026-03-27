/**
 * functions/_middleware.js
 *
 * Middleware global — se ejecuta antes que cualquier otro Function o asset.
 * Enforza el host canónico www.amadolibros.com con 301 permanente.
 *
 * Sin esto, amadolibros.com (non-www) sirve contenido con 200 en todas
 * las rutas estáticas (/, /politicas, /sitemap.xml, etc.), generando
 * URLs duplicadas visibles para Googlebot aunque el canonical diga www.
 *
 * Las fichas /libro/:id/:slug ya hacen su propio redirect a www dentro
 * del Function, pero este middleware los cubre también por consistencia.
 */

export async function onRequest(context) {
    const url = new URL(context.request.url);

    if (url.hostname === 'amadolibros.com') {
        url.hostname = 'www.amadolibros.com';
        return Response.redirect(url.toString(), 301);
    }

    return context.next();
}
