/**
 * functions/catalogo.js
 *
 * Página de índice SSR — vector de descubrimiento para Googlebot.
 *
 * PROPÓSITO SEO:
 *   La home (index.html) carga los libros vía JS client-side (fetch R2 → DOM).
 *   Googlebot puede ejecutar JS, pero lo hace en una segunda pasada con delay.
 *   Esta página sirve HTML estático con <a href="/libro/{id}/{slug}"> para
 *   cada libro activo, permitiendo descubrimiento en el primer crawl pass.
 *
 *   Es una página visible y accesible para usuarios (no un div oculto).
 *   Linked desde el footer de index.html y listada en el sitemap.
 *
 * DATOS: R2 catalog.json — misma fuente que libro/[[path]].js y sitemap.xml.js.
 *
 */

import { slugify } from './_shared/slug.js';
import { BASE, fetchCatalog } from './_shared/catalog.js';

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#39;');
}


export async function onRequest(ctx) {
    const catalog = await fetchCatalog(ctx);
    const items   = (catalog && Array.isArray(catalog.items)) ? catalog.items : [];

    // Solo items activos. Paused se muestran en la home como "por encargo" pero
    // aquí se omiten para no inflar el índice con páginas de stock incierto.
    const activeItems = items.filter(b => b.status === 'active');

    const rows = activeItems.map(b => {
        const slug   = slugify(b.title);
        const href   = `${BASE}/libro/${b.id}/${slug}`;
        const author = b.author ? ` — ${escapeHtml(b.author)}` : '';
        return `    <li><a href="${escapeHtml(href)}">${escapeHtml(b.title)}${author}</a></li>`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Catálogo completo de libros — Amado Libros</title>
  <meta name="description" content="Índice completo de ${activeItems.length} libros disponibles en Amado Libros. Importados y por encargo en Uruguay.">
  <link rel="canonical" href="${BASE}/catalogo">
  <meta name="robots" content="index, follow">
  <script type="application/ld+json">${JSON.stringify({
    '@context':   'https://schema.org',
    '@type':      'CollectionPage',
    'name':       'Catálogo de libros importados y por encargo en Uruguay',
    'url':        `${BASE}/catalogo`,
    'description':'Catálogo de Amado Libros con libros importados, libros por encargo y títulos difíciles de conseguir en Uruguay.',
    'isPartOf':   { '@type': 'WebSite', 'name': 'Amado Libros', 'url': BASE },
    'publisher':  { '@type': 'BookStore', 'name': 'Amado Libros', 'url': BASE },
  })}</script>
  <style>
    body   { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
             max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #1e293b; background: #faf7f2; }
    h1     { font-size: 1.4rem; font-weight: 800; margin-bottom: 0.4rem; }
    .sub   { color: #64748b; font-size: 0.875rem; margin-bottom: 1.5rem; }
    ul     { list-style: none; padding: 0; column-count: 2; column-gap: 1.5rem; }
    @media (max-width: 600px) { ul { column-count: 1; } }
    li     { margin-bottom: 0.4rem; font-size: 0.82rem; break-inside: avoid; }
    a      { color: #1c1917; text-decoration: none; }
    a:hover { text-decoration: underline; color: #3b82f6; }
    nav    { margin-bottom: 1.5rem; font-size: 0.85rem; }
    nav a  { color: #3b82f6; }
    footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #e2e8f0;
             font-size: 0.78rem; color: #94a3b8; }
  </style>
</head>
<body>
  <nav><a href="/">← Amado Libros</a></nav>
  <h1>Catálogo completo</h1>
  <p class="sub">${activeItems.length} títulos disponibles. Libros importados y por encargo en Uruguay.</p>
  <ul>
${rows}
  </ul>
  <footer>
    <a href="/">Volver al catálogo</a> · <a href="/politicas">Políticas</a> ·
    &copy; 2026 Amado Libros
  </footer>
</body>
</html>`;

    return new Response(html, {
        headers: {
            'content-type':  'text/html;charset=UTF-8',
            'cache-control': 'public, max-age=3600',
        },
    });
}
