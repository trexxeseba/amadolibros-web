/**
 * functions/catalogo.js
 *
 * Página de índice SSR — vector de descubrimiento para Googlebot.
 *
 * PROPÓSITO SEO:
 *   La home (index.html) carga los libros vía JS client-side.
 *   Esta página sirve HTML estático con <a href="/libro/{id}/{slug}"> para
 *   cada libro activo, permitiendo descubrimiento en el primer crawl pass.
 *
 * PAGINACIÓN:
 *   /catalogo        → página 1, PAGE_SIZE items
 *   /catalogo?page=N → página N, PAGE_SIZE items
 *   Cada página incluye <link rel="prev"> / <link rel="next"> en <head>
 *   y nav con enlaces prev/next como HTML estático visible a crawlers.
 *
 * DATOS: R2 catalog.json — misma fuente que libro/[[path]].js y sitemap.xml.js.
 *
 * NOTA: slugify() debe mantenerse idéntico al de libro/[[path]].js y sitemap.xml.js.
 */

const CATALOG_URL = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json';
const BASE        = 'https://www.amadolibros.com';
const PAGE_SIZE   = 200;

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

function pageUrl(p) {
    return p <= 1 ? `${BASE}/catalogo` : `${BASE}/catalogo?page=${p}`;
}

export async function onRequest(ctx) {
    const catalog     = await fetchCatalog(ctx);
    const items       = (catalog && Array.isArray(catalog.items)) ? catalog.items : [];
    const activeItems = items.filter(b => b.status === 'active');

    // Parse ?page= — clamp to valid range
    const reqUrl     = new URL(ctx.request.url);
    const rawPage    = parseInt(reqUrl.searchParams.get('page') || '1', 10);
    const totalPages = Math.max(1, Math.ceil(activeItems.length / PAGE_SIZE));
    const page       = Math.min(Math.max(1, isNaN(rawPage) ? 1 : rawPage), totalPages);

    const start     = (page - 1) * PAGE_SIZE;
    const pageItems = activeItems.slice(start, start + PAGE_SIZE);

    const canonicalUrl = pageUrl(page);
    const prevUrl      = page > 1 ? pageUrl(page - 1) : null;
    const nextUrl      = page < totalPages ? pageUrl(page + 1) : null;

    const rows = pageItems.map(b => {
        const slug   = slugify(b.title);
        const href   = `${BASE}/libro/${b.id}/${slug}`;
        const author = b.author ? ` — ${escapeHtml(b.author)}` : '';
        return `    <li><a href="${escapeHtml(href)}">${escapeHtml(b.title)}${author}</a></li>`;
    }).join('\n');

    const pageTitle = page === 1
        ? `Catálogo completo de libros — Amado Libros`
        : `Catálogo de libros, página ${page} de ${totalPages} — Amado Libros`;

    const metaDesc = page === 1
        ? `Índice completo de ${activeItems.length} libros disponibles en Amado Libros. Importados y por encargo en Uruguay.`
        : `Libros disponibles en Amado Libros — página ${page} de ${totalPages}. Importados y por encargo en Uruguay.`;

    const paginationNav = totalPages > 1 ? `
  <nav aria-label="Paginación del catálogo" style="margin:1.5rem 0;display:flex;gap:1rem;flex-wrap:wrap;align-items:center;font-size:.85rem">
    ${prevUrl ? `<a href="${escapeHtml(prevUrl)}" rel="prev" style="color:#3b82f6">← Página anterior</a>` : '<span style="color:#cbd5e1">← Página anterior</span>'}
    <span style="color:#64748b">Página ${page} de ${totalPages} · ${activeItems.length} libros</span>
    ${nextUrl ? `<a href="${escapeHtml(nextUrl)}" rel="next" style="color:#3b82f6">Página siguiente →</a>` : '<span style="color:#cbd5e1">Página siguiente →</span>'}
  </nav>` : '';

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(metaDesc)}">
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  <meta name="robots" content="index, follow">
  ${prevUrl ? `<link rel="prev" href="${escapeHtml(prevUrl)}">` : ''}
  ${nextUrl ? `<link rel="next" href="${escapeHtml(nextUrl)}">` : ''}
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
  ${paginationNav}
  <ul>
${rows}
  </ul>
  ${paginationNav}
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
