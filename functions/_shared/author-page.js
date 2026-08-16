import { BASE, fetchCatalog } from './catalog.js';
import {
  faviconHeadHtml,
  footerHtml,
  FOOTER_STYLES,
  waFloatHtml,
  WA_FLOAT_STYLES,
} from './brand.js';
import { slugify } from './slug.js';
import { authorPageById, matchesAuthor } from './seo-authors.js';
import {
  bookCoverUrl,
  CARD_IMAGE_SIZES,
  responsiveImage,
} from './cloudflare-images.js';

const WA = '59899841325';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function coverUrl(item) {
  const source = Array.isArray(item?.pictures) && item.pictures[0]
    ? item.pictures[0]
    : item?.thumbnail || '';
  return String(source)
    .replace('http://', 'https://')
    .replace(/-I\.(jpg|jpeg|png|webp)(?=($|\?))/i, '-O.$1');
}

function unavailable(message, status = 503) {
  return new Response(message, {
    status,
    headers: {
      'content-type': 'text/plain;charset=UTF-8',
      'cache-control': 'no-store',
    },
  });
}

export function selectAuthorBooks(items, author) {
  if (!Array.isArray(items) || !author) return [];
  const seen = new Set();
  return items.filter(item => {
    if (!item?.id || !item?.title || item.status !== 'active') return false;
    if ((Number(item.available_quantity) || 0) <= 0) return false;
    if (!matchesAuthor(item, author) || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function renderAuthorPage(author, items, useCloudflareImages = true) {
  const canonicalUrl = `${BASE}${author.path}`;
  const pageTitle = `Libros de ${author.name} en Uruguay`;
  const metaDescription = `Libros de ${author.name} disponibles en Uruguay: ${author.focus}. Comprá online o consultá por encargos en Amado Libros.`;
  const waMessage = `Hola, busco un libro de ${author.name}`;

  const itemListElements = items.slice(0, 50).map((item, index) => ({
    '@type': 'ListItem',
    'position': index + 1,
    'url': `${BASE}/libro/${item.id}/${slugify(item.title)}`,
    'name': item.title,
  }));
  const schemas = [
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      '@id': `${canonicalUrl}#page`,
      'name': pageTitle,
      'url': canonicalUrl,
      'description': metaDescription,
      'isPartOf': { '@id': `${BASE}/#website` },
      'publisher': { '@id': `${BASE}/#bookstore` },
      'about': { '@type': 'Person', 'name': author.name },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      'name': `${pageTitle} — Amado Libros`,
      'numberOfItems': items.length,
      'itemListElement': itemListElements,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      'itemListElement': [
        { '@type': 'ListItem', 'position': 1, 'name': 'Inicio', 'item': `${BASE}/` },
        { '@type': 'ListItem', 'position': 2, 'name': 'Catálogo', 'item': `${BASE}/catalogo` },
        { '@type': 'ListItem', 'position': 3, 'name': `Libros de ${author.name}` },
      ],
    },
  ];

  const cards = items.map(item => {
    const href = `/libro/${encodeURIComponent(item.id)}/${slugify(item.title)}`;
    const source = useCloudflareImages ? bookCoverUrl(item.id) : coverUrl(item);
    const image = responsiveImage(source, {
      widths: [240, 360, 480],
      defaultWidth: 360,
      sizes: CARD_IMAGE_SIZES,
    });
    const price = Number(item.price) || 0;
    const responsiveAttrs = image.srcset
      ? ` srcset="${escapeHtml(image.srcset)}" sizes="${escapeHtml(image.sizes)}"`
      : '';
    return `<article class="book-card">
      <a class="cover-link" href="${escapeHtml(href)}">
        ${image.src ? `<img src="${escapeHtml(image.src)}"${responsiveAttrs} alt="Portada de ${escapeHtml(item.title)}" loading="lazy" decoding="async" width="180" height="270">` : '<span class="cover-fallback" aria-hidden="true">📚</span>'}
      </a>
      <div class="book-info">
        <h2><a href="${escapeHtml(href)}">${escapeHtml(item.title)}</a></h2>
        <p class="book-author">${escapeHtml(item.author)}</p>
        ${price > 0 ? `<p class="book-price">$${escapeHtml(price.toLocaleString('es-UY'))} UYU</p>` : ''}
        <a class="book-cta" href="${escapeHtml(href)}">Ver ficha</a>
      </div>
    </article>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(pageTitle)} | Amado Libros</title>
  <meta name="description" content="${escapeHtml(metaDescription)}">
  <meta name="robots" content="index,follow">
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  ${faviconHeadHtml()}
  <meta property="og:type" content="website">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  <meta property="og:title" content="${escapeHtml(pageTitle)} | Amado Libros">
  <meta property="og:description" content="${escapeHtml(metaDescription)}">
  <meta property="og:image" content="${BASE}/images/logo-amado.png">
  <meta property="og:locale" content="es_UY">
  ${schemas.map(schema => `<script type="application/ld+json">${safeJson(schema)}</script>`).join('\n  ')}
  <style>
    *{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#faf7f2;color:#1e293b;line-height:1.6}a{color:#1d4ed8}header{background:#18120e;color:#fff;padding:1rem}header a{color:#fff;text-decoration:none;font-weight:800}.breadcrumbs{max-width:1100px;margin:0 auto;padding:.75rem 1rem;color:#64748b;font-size:.85rem}.breadcrumbs a{text-decoration:none}main{max-width:1100px;margin:0 auto;padding:1rem}.intro{background:#fff;border:1px solid #e2e8f0;border-radius:.75rem;padding:1.5rem;margin-bottom:1.5rem}.intro h1{font-size:clamp(1.55rem,4vw,2.2rem);line-height:1.2;margin:0 0 .75rem}.intro p{margin:.55rem 0;color:#475569}.count{color:#64748b;font-size:.9rem}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.book-card{background:#fff;border:1px solid #e2e8f0;border-radius:.75rem;overflow:hidden;display:flex;flex-direction:column}.cover-link{display:flex;align-items:center;justify-content:center;aspect-ratio:2/3;background:#f8fafc}.cover-link img{width:100%;height:100%;object-fit:contain}.cover-fallback{font-size:2rem}.book-info{padding:.85rem;display:flex;flex:1;flex-direction:column;gap:.45rem}.book-info h2{font-size:.9rem;line-height:1.35;margin:0}.book-info h2 a{color:#1e293b;text-decoration:none}.book-author{font-size:.78rem;color:#64748b;margin:0}.book-price{font-weight:800;margin:.2rem 0;color:#6d28d9}.book-cta{margin-top:auto;background:#18120e;color:#fff;text-decoration:none;text-align:center;padding:.55rem;border-radius:.4rem;font-weight:700;font-size:.82rem}.wa-cta{display:inline-flex;margin-top:1.5rem;background:#25d366;color:#fff;text-decoration:none;padding:.8rem 1rem;border-radius:.55rem;font-weight:800}@media(min-width:640px){.grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(min-width:900px){.grid{grid-template-columns:repeat(5,minmax(0,1fr))}}
    ${FOOTER_STYLES}
    ${WA_FLOAT_STYLES}
  </style>
</head>
<body>
<header><a href="/">📚 Amado Libros</a></header>
<nav class="breadcrumbs"><a href="/">Inicio</a> › <a href="/catalogo">Catálogo</a> › Libros de ${escapeHtml(author.name)}</nav>
<main>
  <section class="intro">
    <h1>${escapeHtml(pageTitle)}</h1>
    <p>${escapeHtml(author.intro)}</p>
    <p>Podés comprar online, consultar stock o pedirnos una edición difícil de ubicar. Enviamos a Montevideo y al interior de Uruguay.</p>
  </section>
  <p class="count">${items.length} título${items.length === 1 ? '' : 's'} disponible${items.length === 1 ? '' : 's'} ahora</p>
  <section class="grid" aria-label="Libros disponibles de ${escapeHtml(author.name)}">${cards}</section>
  <a class="wa-cta" href="https://wa.me/${WA}?text=${encodeURIComponent(waMessage)}" target="_blank" rel="noopener noreferrer">Consultar otro título por WhatsApp</a>
</main>
${footerHtml()}
${waFloatHtml(waMessage)}
</body>
</html>`;
}

export async function renderAuthorRoute(ctx, authorId) {
  const author = authorPageById(authorId);
  if (!author) return unavailable('Página de autor no encontrada.', 404);

  const catalog = await fetchCatalog(ctx);
  if (!catalog || !Array.isArray(catalog.items)) {
    return unavailable('No pudimos cargar el catálogo. Intentá nuevamente en unos minutos.');
  }
  const items = selectAuthorBooks(catalog.items, author);
  return new Response(renderAuthorPage(author, items, ctx.env?.APP_ENV === 'production'), {
    headers: {
      'content-type': 'text/html;charset=UTF-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}
