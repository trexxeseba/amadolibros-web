/**
 * functions/index.js
 *
 * Ruta raíz "/" — Cloudflare Pages
 *
 * Deja pasar la request al archivo estático public/index.html.
 * El sitio SPA completo está en public/index.html con Tailwind CSS.
 */

export async function onRequest(context) {
    return context.next();
}
