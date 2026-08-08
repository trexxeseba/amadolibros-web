/**
 * functions/producto/[[path]].js
 *
 * Limpieza de URLs viejas del sitio anterior (WooCommerce / CMS legacy).
 * Patrón: /producto/:slug/
 *
 * Intenta encontrar el libro equivalente en el catálogo actual (R2) comparando
 * el slug de la URL con el slug generado a partir del título de cada item.
 * Si hay coincidencia → 301 a /libro/:id/:slug (canonical).
 * Sin coincidencia → 410 Gone (página permanentemente eliminada, sin equivalente).
 */

import { slugify } from '../_shared/slug.js';
import { BASE, fetchCatalog } from '../_shared/catalog.js';
import { goneResponse } from '../_shared/gone.js';

export function findLegacyProductMatch(catalog, incomingSlug) {
    if (!incomingSlug || !catalog || !Array.isArray(catalog.items)) return null;
    return catalog.items.find(item => slugify(item.title) === incomingSlug) || null;
}

export async function onRequest(context) {
    const pathParts = Array.isArray(context.params.path)
        ? context.params.path
        : [context.params.path].filter(Boolean);
    const incomingSlug = (pathParts[0] || '').toLowerCase().replace(/\/+$/, '');

    if (incomingSlug) {
        const catalog = await fetchCatalog(context);
        const match = findLegacyProductMatch(catalog, incomingSlug);
        if (match) {
            const canonicalSlug = slugify(match.title);
            return Response.redirect(`${BASE}/libro/${match.id}/${canonicalSlug}`, 301);
        }
    }

    return goneResponse();
}
