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

const MAX_RESULTS = 48;

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#39;');
}

function normalizeText(value = '') {
    return String(value)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
}

function tokenize(value = '') {
    return normalizeText(value).split(/[^a-z0-9]+/).filter(Boolean);
}

function onlyDigits(value = '') {
    return String(value).replace(/\D/g, '');
}

function tokenMatches(queryToken, itemTokens) {
    return itemTokens.some(t => t === queryToken || t.startsWith(queryToken));
}

function itemMatchesQuery(book, queryTokens, queryDigits) {
    const textTokens = [
        ...tokenize(book.title),
        ...tokenize(book.author),
    ];

    const textMatch = queryTokens.length > 0
        ? queryTokens.every(qt => tokenMatches(qt, textTokens))
        : false;

    const isbnMatch = queryDigits.length >= 3
        ? onlyDigits(String(book.isbn ?? '')).includes(queryDigits)
        : false;

    return textMatch || isbnMatch;
}

function httpsImg(url) {
    return (url || '').replace('http://', 'https://');
}

export async function onRequest(ctx) {
    const catalog = await fetchCatalog(ctx);
    const items   = (catalog && Array.isArray(catalog.items)) ? catalog.items : [];

    // Solo items activos. Paused se muestran en la home como "por encargo" pero
    // aquí se omiten para no inflar el índice con páginas de stock incierto.
    const activeItems = items.filter(b => b.status === 'active');

    const url  = new URL(ctx.request.url);
    const rawQ = url.searchParams.get('q')?.trim() ?? '';
    const safeQ = escapeHtml(rawQ);

    // ── Sin query: índice SEO completo (comportamiento original) ─────────────
    if (!rawQ) {
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

    // ── Con query: resultados visuales filtrados ──────────────────────────────
    const queryTokens = tokenize(rawQ);
    const queryDigits = onlyDigits(rawQ);

    const filtered  = activeItems.filter(b => itemMatchesQuery(b, queryTokens, queryDigits));
    const limited   = filtered.slice(0, MAX_RESULTS);
    const truncated = filtered.length > MAX_RESULTS;

    const cards = limited.map(b => {
        const slug  = slugify(b.title);
        const href  = escapeHtml(`${BASE}/libro/${b.id}/${slug}`);
        const img   = escapeHtml(httpsImg(b.pictures?.[0] || b.thumbnail || ''));
        const title = escapeHtml(b.title);
        const author = b.author
            ? `<p class="rc-author">${escapeHtml(b.author)}</p>`
            : '';
        const price      = Number(b.price) || 0;
        const transfer   = Math.round(price * 0.88).toLocaleString('es-UY');
        const priceStr   = price.toLocaleString('es-UY');
        const installment = Math.ceil(price / 12).toLocaleString('es-UY');
        const imgTag = img
            ? `<img src="${img}" alt="${title}" loading="lazy" decoding="async">`
            : `<div class="rc-no-img">📚</div>`;

        return `<a href="${href}" class="rc-card">
  <div class="rc-img">${imgTag}</div>
  <div class="rc-body">
    <p class="rc-title">${title}</p>
    ${author}
    <div class="rc-prices">
      <span class="rc-transfer"><span class="rc-lbl">Transferencia -12%:</span> $${escapeHtml(transfer)}</span>
      <span class="rc-base">Precio: $${escapeHtml(priceStr)}</span>
      <span class="rc-cuotas">12 cuotas de $${escapeHtml(installment)}</span>
    </div>
  </div>
</a>`;
    }).join('\n');

    const subText = filtered.length === 0
        ? `No encontramos resultados para &ldquo;${safeQ}&rdquo;.`
        : truncated
            ? `Mostrando los primeros ${MAX_RESULTS} de ${filtered.length} resultados.`
            : `${filtered.length} resultado${filtered.length === 1 ? '' : 's'}.`;

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Resultados para &ldquo;${safeQ}&rdquo; — Amado Libros</title>
  <meta name="description" content="Resultados de búsqueda para &ldquo;${safeQ}&rdquo; en Amado Libros.">
  <link rel="canonical" href="${BASE}/catalogo">
  <meta name="robots" content="noindex">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         background:#faf7f2;color:#1e293b;line-height:1.5}
    .wrap{max-width:1100px;margin:0 auto;padding:1.25rem 1rem 3rem}
    nav{font-size:.875rem;margin-bottom:1.25rem}
    nav a{color:#3b82f6;text-decoration:none}
    nav a:hover{text-decoration:underline}
    h1{font-size:1.35rem;font-weight:800;margin-bottom:.3rem}
    .sub{color:#64748b;font-size:.875rem;margin-bottom:1.5rem}
    .grid{display:grid;gap:1rem;
          grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
    @media(min-width:500px){.grid{grid-template-columns:repeat(auto-fill,minmax(180px,1fr))}}
    @media(min-width:900px){.grid{grid-template-columns:repeat(4,1fr)}}
    .rc-card{display:flex;flex-direction:column;background:#fff;
             border:1px solid #e2dbd0;border-radius:.75rem;overflow:hidden;
             text-decoration:none;color:inherit;
             transition:box-shadow .15s}
    .rc-card:hover{box-shadow:0 4px 16px rgba(24,18,14,.1)}
    .rc-img{aspect-ratio:3/4;background:#ede9e1;overflow:hidden}
    .rc-img img{width:100%;height:100%;object-fit:cover;display:block;
                transition:transform .25s}
    .rc-card:hover .rc-img img{transform:scale(1.04)}
    .rc-no-img{width:100%;height:100%;display:flex;align-items:center;
               justify-content:center;font-size:2.5rem;color:#c4b9ad}
    .rc-body{padding:.875rem 1rem;display:flex;flex-direction:column;gap:.45rem;flex:1}
    .rc-title{font-size:.95rem;font-weight:700;color:#18120e;line-height:1.25;
              display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
    .rc-author{font-size:.82rem;color:#6b6157;
               white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .rc-prices{display:flex;flex-direction:column;gap:.2rem;margin-top:.35rem}
    .rc-transfer,.rc-base,.rc-cuotas{font-size:.875rem;line-height:1.3}
    .rc-transfer{color:#18120e;font-weight:500}
    .rc-lbl{font-style:italic;font-weight:700}
    .rc-base,.rc-cuotas{color:#6b6157}
    .empty{padding:2rem 0;color:#64748b;font-size:.95rem}
    footer{margin-top:2.5rem;padding-top:1rem;border-top:1px solid #e2e8f0;
           font-size:.78rem;color:#94a3b8}
    footer a{color:#cbd5e1;text-decoration:none}
    footer a:hover{text-decoration:underline}
  </style>
</head>
<body>
<div class="wrap">
  <nav><a href="/">← Amado Libros</a></nav>
  <h1>Resultados para &ldquo;${safeQ}&rdquo;</h1>
  <p class="sub">${subText}</p>
  ${filtered.length > 0
    ? `<div class="grid">\n${cards}\n</div>`
    : `<p class="empty">Intentá con otras palabras o <a href="/">volvé al catálogo</a>.</p>`
  }
  <footer>
    <a href="/">Volver al catálogo</a> · <a href="/politicas">Políticas</a> ·
    &copy; 2026 Amado Libros
  </footer>
</div>
</body>
</html>`;

    return new Response(html, {
        headers: {
            'content-type':  'text/html;charset=UTF-8',
            'cache-control': 'public, max-age=300',
        },
    });
}
