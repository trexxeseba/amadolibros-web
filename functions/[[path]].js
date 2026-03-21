/**
 * functions/[[path]].js
 *
 * SPA Fallback — delega a Cloudflare Pages nativo.
 * _redirects ya maneja /* → /index.html 200.
 */

export async function onRequest(context) {
    return context.next();
}
