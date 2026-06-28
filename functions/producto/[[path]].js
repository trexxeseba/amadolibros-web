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
 *
 */

import { slugify } from '../_shared/slug.js';

const CATALOG_URL = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json';
const BASE        = 'https://www.amadolibros.com';


async function fetchCatalog() {
    try {
        const resp = await fetch(CATALOG_URL);
        if (!resp.ok) return null;
        return await resp.json();
    } catch {
        return null;
    }
}

export async function onRequest(context) {
    // Extract the slug from the incoming /producto/:slug URL
    const pathParts = Array.isArray(context.params.path)
        ? context.params.path
        : [context.params.path].filter(Boolean);
    const incomingSlug = (pathParts[0] || '').toLowerCase().replace(/\/+$/, '');

    if (incomingSlug) {
        const catalog = await fetchCatalog();
        if (catalog && Array.isArray(catalog.items)) {
            const match = catalog.items.find(
                item => slugify(item.title) === incomingSlug
            );
            if (match) {
                const canonicalSlug = slugify(match.title);
                return Response.redirect(`${BASE}/libro/${match.id}/${canonicalSlug}`, 301);
            }
        }
    }

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Página no disponible — Amado Libros</title>
  <meta name="robots" content="noindex">
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         max-width:600px;margin:4rem auto;padding:1rem;text-align:center;color:#1e293b}
    a{color:#3b82f6;text-decoration:none}
    a:hover{text-decoration:underline}
  </style>
</head>
<body>
  <h1 style="font-size:1.5rem;margin-bottom:1rem">Esta página ya no existe</h1>
  <p style="color:#64748b;margin-bottom:1.5rem">
    El catálogo fue actualizado. Buscá tu libro en el catálogo completo.
  </p>
  <a href="/">← Ir al catálogo de Amado Libros</a>
</body>
</html>`;

    return new Response(html, {
        status: 410,
        headers: {
            'content-type': 'text/html;charset=UTF-8',
            'cache-control': 'public, max-age=86400',
        },
    });
}
