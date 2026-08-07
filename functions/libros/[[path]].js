/**
 * Landings SEO SSR para las ocho categorías principales.
 *
 * URLs autorizadas: /libros/:categoria. La allowlist vive en
 * _shared/seo-categories.js; cualquier otra ruta responde 404 real.
 */
import { slugify } from '../_shared/slug.js';
import { BASE, fetchActiveIndex, fetchCatalog } from '../_shared/catalog.js';
import {
    BRAND,
    faviconHeadHtml,
    footerHtml,
    FOOTER_STYLES,
    waFloatHtml,
    WA_FLOAT_STYLES,
} from '../_shared/brand.js';
import { findSeoCategory, SEO_CATEGORIES } from '../_shared/seo-categories.js';

const MAX_RESULTS = 48;

function escapeHtml(value) {
    if (value == null) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function safeJson(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

function httpsImg(url) {
    return String(url || '').replace('http://', 'https://');
}

async function fetchCategoryData(ctx) {
    try {
        const url = new URL('/data/active-categories.json', ctx.request.url).toString();
        const cache = caches.default;
        const cacheKey = new Request(url);
        let response = await cache.match(cacheKey);
        if (!response) {
            const fetched = await fetch(url);
            if (!fetched.ok) return null;
            response = new Response(fetched.body, {
                status: fetched.status,
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'public, max-age=300',
                },
            });
            if (typeof ctx?.waitUntil === 'function') {
                ctx.waitUntil(cache.put(cacheKey, response.clone()));
            }
        }
        const data = await response.json();
        return data && typeof data.items === 'object' ? data : null;
    } catch {
        return null;
    }
}

function headerHtml() {
    return `<header class="category-header">
  <div class="header-inner">
    <a href="/" class="brand-link" aria-label="Amado Libros — inicio">
      <img src="${BRAND.logo}" alt="${BRAND.logoAlt}" width="44" height="44" fetchpriority="high">
      <span><strong>AMADO LIBROS</strong><small>Librería uruguaya</small></span>
    </a>
    <form class="header-search" action="/catalogo" method="get" role="search">
      <input type="search" name="q" placeholder="Título, autor, temática o ISBN" aria-label="Buscar libros">
      <button type="submit">Buscar</button>
    </form>
    <a class="cart-link" href="/carrito" aria-label="Ver carrito">Carrito</a>
  </div>
</header>`;
}

function categoryNavHtml(currentId) {
    return `<nav class="category-nav" aria-label="Otras categorías de libros">
  ${SEO_CATEGORIES.map(category => {
        const current = category.id === currentId ? ' aria-current="page"' : '';
        return `<a href="/libros/${category.id}"${current}>${escapeHtml(category.name)}</a>`;
    }).join('\n  ')}
</nav>`;
}

function cardHtml(item, index, navigationBase) {
    const href = `${navigationBase}/libro/${item.id}/${slugify(item.title)}`;
    const image = httpsImg(item.pictures?.[0] || item.thumbnail || '');
    const title = escapeHtml(item.title);
    const author = item.author ? `<p class="book-author">${escapeHtml(item.author)}</p>` : '';
    const price = Number(item.price) || 0;
    const priceText = price.toLocaleString('es-UY');
    const transferText = Math.round(price * 0.88).toLocaleString('es-UY');
    const installmentText = Math.round(price / 12).toLocaleString('es-UY');
    const imageHtml = image
        ? `<img src="${escapeHtml(image)}" alt="Portada de ${title}" loading="${index < 6 ? 'eager' : 'lazy'}" decoding="async">`
        : '<span class="book-placeholder" aria-hidden="true">📚</span>';

    return `<article class="book-card">
  <a class="book-image" href="${escapeHtml(href)}">${imageHtml}</a>
  <div class="book-body">
    <span class="stock-badge">Disponible</span>
    <h2><a href="${escapeHtml(href)}">${title}</a></h2>
    ${author}
    ${price > 0 ? `<div class="book-prices">
      <strong>$${escapeHtml(priceText)} UYU</strong>
      <span>Hasta 12 cuotas de aprox. $${escapeHtml(installmentText)}</span>
      <span class="transfer">Transferencia: $${escapeHtml(transferText)}</span>
    </div>` : ''}
    <a class="book-cta" href="${escapeHtml(href)}">Ver ficha</a>
  </div>
</article>`;
}

function errorPage(status, title, message) {
    const html = `<!doctype html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — Amado Libros</title>
<meta name="robots" content="noindex, nofollow">
${faviconHeadHtml()}
<style>*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:#f8f5ef;color:#18120e}.error{min-height:70vh;display:grid;place-items:center;padding:2rem}.error-card{max-width:640px;background:#fff;border:1px solid #e2dbd0;border-radius:1rem;padding:2rem;text-align:center}.error-card h1{margin:.25rem 0 1rem}.error-actions{display:flex;flex-wrap:wrap;gap:.75rem;justify-content:center;margin-top:1.5rem}.error-actions a{padding:.75rem 1rem;border-radius:.6rem;background:#18120e;color:#fff;text-decoration:none}</style>
</head><body>${headerHtml()}<main class="error"><section class="error-card"><p>${status}</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><div class="error-actions"><a href="/catalogo">Buscar en el catálogo</a><a href="/">Volver al inicio</a></div></section></main>${footerHtml()}</body></html>`;
    return new Response(html, {
        status,
        headers: {
            'content-type': 'text/html;charset=UTF-8',
            'cache-control': status === 404 ? 'public, max-age=300' : 'no-store',
        },
    });
}

function renderPage({ category, items, isPreview, hasParameters, navigationBase }) {
    const canonical = `${BASE}/libros/${category.id}`;
    const visibleItems = items.slice(0, MAX_RESULTS);
    const itemList = visibleItems.slice(0, 20).map((item, index) => ({
        '@type': 'ListItem',
        'position': index + 1,
        'url': `${BASE}/libro/${item.id}/${slugify(item.title)}`,
        'name': item.title,
    }));
    const collectionSchema = {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        'name': category.h1,
        'url': canonical,
        'description': category.description,
        'isPartOf': { '@type': 'WebSite', 'name': BRAND.name, 'url': BASE },
        'publisher': { '@type': 'BookStore', 'name': BRAND.name, 'url': BASE },
        'mainEntity': {
            '@type': 'ItemList',
            'numberOfItems': items.length,
            'itemListElement': itemList,
        },
    };
    const breadcrumbSchema = {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        'itemListElement': [
            { '@type': 'ListItem', 'position': 1, 'name': 'Inicio', 'item': `${BASE}/` },
            { '@type': 'ListItem', 'position': 2, 'name': 'Libros', 'item': `${BASE}/catalogo` },
            { '@type': 'ListItem', 'position': 3, 'name': category.name, 'item': canonical },
        ],
    };
    const resultText = `${items.length} libro${items.length === 1 ? '' : 's'} disponible${items.length === 1 ? '' : 's'}`;
    const cards = visibleItems.map((item, index) => cardHtml(item, index, navigationBase)).join('\n');
    // Parámetros arbitrarios no crean variantes indexables de la landing.
    // La URL limpia es la única que puede entrar al índice.
    const robots = isPreview || hasParameters || items.length === 0
        ? 'noindex, follow'
        : 'index, follow';

    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(category.title)}</title>
  <meta name="description" content="${escapeHtml(category.description)}">
  <meta name="robots" content="${robots}">
  <link rel="canonical" href="${canonical}">
  ${faviconHeadHtml()}
  <meta property="og:type" content="website">
  <meta property="og:locale" content="es_UY">
  <meta property="og:url" content="${canonical}">
  <meta property="og:title" content="${escapeHtml(category.title)}">
  <meta property="og:description" content="${escapeHtml(category.description)}">
  <meta property="og:image" content="${BASE}${BRAND.logo}">
  <script type="application/ld+json">${safeJson(collectionSchema)}</script>
  <script type="application/ld+json">${safeJson(breadcrumbSchema)}</script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}body{font-family:Inter,system-ui,-apple-system,sans-serif;background:#f8f5ef;color:#18120e;line-height:1.55}a{color:inherit}.category-header{position:sticky;top:0;z-index:40;background:rgba(18,14,11,.97);color:#fff;border-bottom:1px solid rgba(255,255,255,.08)}.header-inner{max-width:1200px;height:72px;margin:auto;padding:0 1rem;display:grid;grid-template-columns:auto minmax(220px,1fr) auto;align-items:center;gap:1rem}.brand-link{display:flex;align-items:center;gap:.55rem;text-decoration:none}.brand-link img{width:44px;height:44px}.brand-link span{display:flex;flex-direction:column}.brand-link strong{font-size:.92rem}.brand-link small{color:rgba(255,255,255,.55);font-size:.7rem}.header-search{height:42px;display:flex;max-width:620px;width:100%;justify-self:center}.header-search input{min-width:0;flex:1;border:0;border-radius:999px 0 0 999px;padding:0 1rem;font:inherit}.header-search button{border:0;border-radius:0 999px 999px 0;padding:0 1rem;background:#e49982;color:#18120e;font-weight:800;cursor:pointer}.cart-link{min-height:42px;display:inline-flex;align-items:center;padding:0 .9rem;border:1px solid rgba(255,255,255,.2);border-radius:999px;text-decoration:none;font-size:.82rem}.breadcrumbs{max-width:1120px;margin:0 auto;padding:1rem;font-size:.82rem;color:#6b6157}.breadcrumbs a{color:#8f493b}.category-main{max-width:1120px;margin:0 auto;padding:0 1rem 3rem}.intro{padding:clamp(1.25rem,3vw,2rem);background:#fff;border:1px solid #e2dbd0;border-radius:1rem}.intro h1{font-family:Georgia,serif;font-size:clamp(1.75rem,5vw,2.6rem);line-height:1.12;margin-bottom:.8rem}.intro p{max-width:78ch;color:#5f554c}.benefits{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1rem}.benefits span{padding:.35rem .65rem;border-radius:999px;background:#f5f0ea;color:#50463e;font-size:.75rem;font-weight:700}.results-head{display:flex;align-items:end;justify-content:space-between;gap:1rem;margin:2rem 0 1rem}.results-head h2{font-size:1.15rem}.results-head p{color:#6b6157;font-size:.84rem}.books-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.8rem}.book-card{display:flex;flex-direction:column;min-width:0;background:#fff;border:1px solid #e2dbd0;border-radius:.8rem;overflow:hidden}.book-image{display:grid;place-items:center;aspect-ratio:3/4;background:#eee7de;overflow:hidden}.book-image img{width:100%;height:100%;object-fit:cover;transition:transform .2s}.book-card:hover .book-image img{transform:scale(1.025)}.book-placeholder{font-size:2.5rem}.book-body{display:flex;flex:1;flex-direction:column;align-items:flex-start;gap:.4rem;padding:.8rem}.stock-badge{padding:.16rem .48rem;border-radius:999px;background:#eaf7ee;color:#267a42;font-size:.64rem;font-weight:800;text-transform:uppercase}.book-body h2{font-size:.86rem;line-height:1.3}.book-body h2 a{text-decoration:none}.book-author{width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#6b6157;font-size:.75rem}.book-prices{display:flex;flex-direction:column;gap:.15rem;margin-top:.2rem;font-size:.72rem}.book-prices strong{font-size:.9rem}.book-prices .transfer{color:#a94e3d;font-weight:700}.book-cta{margin-top:auto;padding:.38rem .7rem;border-radius:999px;background:#18120e;color:#fff;text-decoration:none;font-size:.73rem;font-weight:700}.category-nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.55rem;margin-top:2.5rem;padding:1rem;background:#fff;border:1px solid #e2dbd0;border-radius:1rem}.category-nav a{padding:.55rem .7rem;border-radius:.55rem;background:#f8f5ef;text-decoration:none;font-size:.78rem}.category-nav a[aria-current="page"]{background:#18120e;color:#fff}.empty{margin-top:1.5rem;padding:1.5rem;background:#fff;border:1px solid #e2dbd0;border-radius:.8rem}${FOOTER_STYLES}${WA_FLOAT_STYLES}@media(min-width:640px){.books-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.category-nav{grid-template-columns:repeat(4,minmax(0,1fr))}}@media(min-width:900px){.books-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}@media(max-width:620px){.header-inner{height:auto;min-height:68px;grid-template-columns:1fr auto;padding:.55rem .8rem}.brand-link small,.cart-link{display:none}.header-search{grid-column:1/-1;grid-row:2;margin-bottom:.2rem}.category-header{position:relative}}
  </style>
</head>
<body>
${headerHtml()}
<nav class="breadcrumbs" aria-label="Migas de pan"><a href="/">Inicio</a> › <a href="/catalogo">Libros</a> › <span>${escapeHtml(category.name)}</span></nav>
<main class="category-main">
  <section class="intro">
    <h1>${escapeHtml(category.h1)}</h1>
    <p>${escapeHtml(category.intro)}</p>
    <div class="benefits"><span>12% menos por transferencia</span><span>Hasta 12 cuotas</span><span>Envíos a todo Uruguay</span><span>Encargos del exterior</span></div>
  </section>
  <div class="results-head"><h2>Libros disponibles</h2><p>${resultText}${items.length > MAX_RESULTS ? ` · mostrando ${MAX_RESULTS}` : ''}</p></div>
  ${items.length > 0 ? `<section class="books-grid" aria-label="${escapeHtml(category.h1)}">${cards}</section>` : '<p class="empty">No hay títulos disponibles en esta categoría en este momento. Consultanos por WhatsApp y lo buscamos por encargo.</p>'}
  ${categoryNavHtml(category.id)}
</main>
${footerHtml()}
${waFloatHtml(`Hola, busco un libro de ${category.name}.`)}
</body>
</html>`;
}

export async function onRequest(ctx) {
    const pathParts = Array.isArray(ctx.params.path)
        ? ctx.params.path
        : [ctx.params.path].filter(Boolean);
    if (pathParts.length !== 1) {
        return errorPage(404, 'Categoría no encontrada', 'La categoría que buscás no existe.');
    }

    const category = findSeoCategory(String(pathParts[0] || '').toLowerCase());
    if (!category) {
        return errorPage(404, 'Categoría no encontrada', 'La categoría que buscás no existe.');
    }

    const [categoryData, activeIndex] = await Promise.all([
        fetchCategoryData(ctx),
        ['preview', 'production'].includes(ctx.env?.APP_ENV)
            ? fetchActiveIndex(ctx)
            : Promise.resolve(null),
    ]);
    if (!categoryData) {
        return errorPage(503, 'Catálogo temporalmente no disponible', 'Intentá nuevamente en unos minutos.');
    }

    let activeItems = Array.isArray(activeIndex?.items) ? activeIndex.items : null;
    if (!activeItems) {
        const catalog = await fetchCatalog(ctx);
        if (!catalog || !Array.isArray(catalog.items)) {
            return errorPage(503, 'Catálogo temporalmente no disponible', 'Intentá nuevamente en unos minutos.');
        }
        activeItems = catalog.items.filter(item =>
            item.status === 'active' && Number(item.available_quantity) > 0
        );
    }

    const items = activeItems.filter(item =>
        (categoryData.items[item.id] || [])[0] === category.id
    );
    const isPreview = ctx.env?.APP_ENV === 'preview';
    const navigationBase = isPreview ? new URL(ctx.request.url).origin : BASE;
    const hasParameters = new URL(ctx.request.url).searchParams.size > 0;
    const html = renderPage({
        category,
        items,
        isPreview,
        hasParameters,
        navigationBase,
    });

    return new Response(html, {
        headers: {
            'content-type': 'text/html;charset=UTF-8',
            'cache-control': 'public, max-age=3600',
        },
    });
}
