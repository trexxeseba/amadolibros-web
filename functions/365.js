/**
 * Redirección permanente de la ficha legacy indexada por Google.
 *
 * Cloudflare Pages enruta tanto /365 como /365/ a esta Function.
 */

const CURRENT_BOOK_URL =
    'https://www.amadolibros.com/libro/MLU1330191560/libro-club-de-brujas-mel-knarik-ayelen-romano';

export function onRequest() {
    return Response.redirect(CURRENT_BOOK_URL, 301);
}
