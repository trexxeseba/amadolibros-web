/**
 * functions/autor/[[path]].js
 *
 * Página de autor SSR — lista todos los libros de un autor dado.
 *
 * URL: /autor/:slug
 *   slug = slugify(author_name), mismo algoritmo que catalogo.js y sitemap.xml.js.
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
    const pathParts    = Array.isArray(ctx.params.path)
        ? ctx.params.path
        : [ctx.params.path].filter(Boolean);
    const incomingSlug = (pathParts[0] || '').toLowerCase().replace(/\/+$/, '');

    if (!incomingSlug) {
        return Response.redirect(`${BASE}/autores`, 301);
    }

    const catalog     = await fetchCatalog(ctx);
    const items       = (catalog && Array.isArray(catalog.items)) ? catalog.items : [];
    const activeItems = items.filter(b => b.status === 'active');

    // Find all books whose author slug matches
    const authorBooks = activeItems.filter(b => b.author && slugify(b.author) === incomingSlug);

    if (authorBooks.length === 0) {
        const html404 = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Autor no encontrado — Amado Libros</title>
  <meta name="robots" content="noindex">
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         max-width:600px;margin:4rem auto;padding:1rem;text-align:center;color:#1e293b}
    a{color:#3b82f6}
  </style>
</head>
<body>
  <h1 style="font-size:1.5rem;margin-bottom:1rem">Autor no encontrado</h1>
  <p style="color:#64748b;margin-bottom:1.5rem">No hay libros de este autor en el catálogo.</p>
  <a href="/autores">← Ver todos los autores</a>
</body>
</html>`;
        return new Response(html404, {
            status: 404,
            headers: { 'content-type': 'text/html;charset=UTF-8' },
        });
    }

    // Canonical author name: use the most frequent spelling
    const nameFreq = new Map();
    for (const b of authorBooks) {
        const n = b.author.trim();
        nameFreq.set(n, (nameFreq.get(n) || 0) + 1);
    }
    const authorName   = [...nameFreq.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const canonicalUrl = `${BASE}/autor/${slugify(authorName)}`;

    // Sort books: most recent first, then alphabetically
    const sorted = [...authorBooks].sort((a, b) => {
        const da = new Date(a.start_time || 0);
        const db = new Date(b.start_time || 0);
        if (db - da !== 0) return db - da;
        return (a.title || '').localeCompare(b.title || '', 'es', { sensitivity: 'base' });
    });

    const rows = sorted.map(b => {
        const slug = slugify(b.title);
        const href = `${BASE}/libro/${b.id}/${slug}`;
        return `    <li><a href="${escapeHtml(href)}">${escapeHtml(b.title)}</a></li>`;
    }).join('\n');

    const bookCount = sorted.length;
    const safeAuthor = escapeHtml(authorName);
    const metaDesc = `${bookCount} libro${bookCount !== 1 ? 's' : ''} de ${safeAuthor} disponibles en Amado Libros. Importados y por encargo en Uruguay.`;

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeAuthor} — Libros en Amado Libros</title>
  <meta name="description" content="${escapeHtml(metaDesc)}">
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  <meta name="robots" content="index, follow">
  <script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      'name': `Libros de ${authorName}`,
      'description': metaDesc,
      'url': canonicalUrl,
      'author': { '@type': 'Person', 'name': authorName },
  })}</script>
  <style>
    body  { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #1e293b; background: #faf7f2; }
    h1    { font-size: 1.4rem; font-weight: 800; margin-bottom: 0.4rem; }
    .sub  { color: #64748b; font-size: 0.875rem; margin-bottom: 1.5rem; }
    ul    { list-style: none; padding: 0; column-count: 2; column-gap: 1.5rem; }
    @media (max-width: 600px) { ul { column-count: 1; } }
    li    { margin-bottom: 0.4rem; font-size: 0.82rem; break-inside: avoid; }
    a     { color: #1c1917; text-decoration: none; }
    a:hover { text-decoration: underline; color: #3b82f6; }
    nav   { margin-bottom: 1.5rem; font-size: 0.85rem; }
    nav a { color: #3b82f6; }
    footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #e2e8f0;
             font-size: 0.78rem; color: #94a3b8; }
  </style>
</head>
<body>
  <nav><a href="/autores">← Autores</a></nav>
  <h1>${safeAuthor}</h1>
  <p class="sub">${bookCount} libro${bookCount !== 1 ? 's' : ''} en el catálogo</p>
  <ul>
${rows}
  </ul>
  <footer>
    <a href="/">Volver al catálogo</a> · <a href="/autores">Autores</a> · <a href="/catalogo">Índice de libros</a> · <a href="/politicas">Políticas</a> ·
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
