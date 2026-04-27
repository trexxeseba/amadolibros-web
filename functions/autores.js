/**
 * functions/autores.js
 *
 * Índice de autores SSR — vector de descubrimiento para Googlebot.
 *
 * Lista todos los autores únicos del catálogo activo, ordenados
 * alfabéticamente, con recuento de libros y enlace a /autor/:slug.
 *
 * DATOS: R2 catalog.json — misma fuente que catalogo.js y sitemap.xml.js.
 */

const CATALOG_URL = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json';
const BASE        = 'https://www.amadolibros.com';

function slugify(text) {
    return (text || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 60);
}

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#39;');
}

async function fetchCatalog(ctx) {
    const cache    = caches.default;
    const cacheKey = new Request(CATALOG_URL);

    let resp = await cache.match(cacheKey);
    if (!resp) {
        const fetched = await fetch(CATALOG_URL);
        if (!fetched.ok) return null;
        resp = new Response(fetched.body, {
            status:  fetched.status,
            headers: {
                'Content-Type':  'application/json',
                'Cache-Control': 'public, max-age=3600',
            },
        });
        ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    }
    try {
        return await resp.json();
    } catch {
        return null;
    }
}

export async function onRequest(ctx) {
    const catalog     = await fetchCatalog(ctx);
    const items       = (catalog && Array.isArray(catalog.items)) ? catalog.items : [];
    const activeItems = items.filter(b => b.status === 'active' && b.author);

    // Aggregate authors: name → count
    const authorMap = new Map();
    for (const b of activeItems) {
        const name = b.author.trim();
        authorMap.set(name, (authorMap.get(name) || 0) + 1);
    }

    // Sort alphabetically (locale-aware for Spanish)
    const authors = [...authorMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b, 'es', { sensitivity: 'base' }));

    const totalAuthors = authors.length;

    const rows = authors.map(([name, count]) => {
        const slug  = slugify(name);
        const href  = `${BASE}/autor/${slug}`;
        const label = count === 1 ? '1 libro' : `${count} libros`;
        return `    <li><a href="${escapeHtml(href)}">${escapeHtml(name)}</a> <span class="cnt">(${label})</span></li>`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Autores — Amado Libros</title>
  <meta name="description" content="Índice de ${totalAuthors} autores disponibles en Amado Libros. Libros importados y por encargo en Uruguay.">
  <link rel="canonical" href="${BASE}/autores">
  <meta name="robots" content="index, follow">
  <style>
    body  { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #1e293b; background: #faf7f2; }
    h1    { font-size: 1.4rem; font-weight: 800; margin-bottom: 0.4rem; }
    .sub  { color: #64748b; font-size: 0.875rem; margin-bottom: 1.5rem; }
    ul    { list-style: none; padding: 0; column-count: 3; column-gap: 1.5rem; }
    @media (max-width: 700px) { ul { column-count: 2; } }
    @media (max-width: 420px) { ul { column-count: 1; } }
    li    { margin-bottom: 0.35rem; font-size: 0.82rem; break-inside: avoid; }
    a     { color: #1c1917; text-decoration: none; }
    a:hover { text-decoration: underline; color: #3b82f6; }
    .cnt  { color: #94a3b8; font-size: 0.75rem; }
    nav   { margin-bottom: 1.5rem; font-size: 0.85rem; }
    nav a { color: #3b82f6; }
    footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #e2e8f0;
             font-size: 0.78rem; color: #94a3b8; }
  </style>
</head>
<body>
  <nav><a href="/">← Amado Libros</a></nav>
  <h1>Autores</h1>
  <p class="sub">${totalAuthors} autores · <a href="/catalogo">Ver catálogo completo</a></p>
  <ul>
${rows}
  </ul>
  <footer>
    <a href="/">Volver al catálogo</a> · <a href="/catalogo">Índice de libros</a> · <a href="/politicas">Políticas</a> ·
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
