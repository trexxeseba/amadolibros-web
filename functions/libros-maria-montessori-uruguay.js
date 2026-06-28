/**
 * functions/libros-maria-montessori-uruguay.js
 *
 * Landing SSR para búsquedas de libros de María Montessori en Uruguay.
 * Filtra catalog.json por "montessori" en título o autor (case-insensitive).
 * Todo el contenido se renderiza en HTML inicial — sin JS requerido para Googlebot.
 */

import { slugify } from './_shared/slug.js';

const CATALOG_URL = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json';
const BASE        = 'https://www.amadolibros.com';
const WA          = '59899841325';


function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#39;');
}

function httpsImg(url) {
    return (url || '').replace('http://', 'https://');
}

function isMontessori(item) {
    const haystack = [item.title, item.author, item.description]
        .filter(Boolean)
        .join(' ')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase();
    return haystack.includes('montessori');
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
    const catalog = await fetchCatalog(ctx);
    const allItems = (catalog && Array.isArray(catalog.items)) ? catalog.items : [];

    const items = allItems.filter(isMontessori);

    // ItemList schema — máximo 20 items para mantener el JSON manejable
    const itemListElements = items.slice(0, 20).map((item, i) => ({
        '@type':    'ListItem',
        'position': i + 1,
        'url':      `${BASE}/libro/${item.id}/${slugify(item.title)}`,
        'name':     item.title,
    }));

    const schemaCollectionPage = {
        '@context':    'https://schema.org',
        '@type':       'CollectionPage',
        'name':        'Libros de María Montessori en Uruguay',
        'url':         `${BASE}/libros-maria-montessori-uruguay`,
        'description': 'Selección de libros de María Montessori disponibles en Uruguay. Pedagogía Montessori, educación, infancia y crianza. Envíos a Montevideo y al interior.',
        'isPartOf':    { '@type': 'WebSite', 'name': 'Amado Libros', 'url': BASE },
        'publisher':   { '@type': 'BookStore', 'name': 'Amado Libros', 'url': BASE },
    };

    const schemaItemList = {
        '@context':         'https://schema.org',
        '@type':            'ItemList',
        'name':             'Libros de María Montessori — Amado Libros Uruguay',
        'numberOfItems':    items.length,
        'itemListElement':  itemListElements,
    };

    const schemaBreadcrumb = {
        '@context': 'https://schema.org',
        '@type':    'BreadcrumbList',
        'itemListElement': [
            { '@type': 'ListItem', 'position': 1, 'name': 'Inicio',   'item': `${BASE}/` },
            { '@type': 'ListItem', 'position': 2, 'name': 'Catálogo', 'item': `${BASE}/catalogo` },
            { '@type': 'ListItem', 'position': 3, 'name': 'Libros de María Montessori' },
        ],
    };

    const cards = items.map(item => {
        const slug    = slugify(item.title);
        const href    = `${BASE}/libro/${item.id}/${slug}`;
        const img     = httpsImg((item.pictures && item.pictures[0]) ? item.pictures[0] : (item.thumbnail || ''));
        const price   = Number(item.price) || 0;
        const priceUY = price.toLocaleString('es-UY');
        const inStock = (item.available_quantity || 0) > 0;
        const waMsg   = encodeURIComponent(`Hola! Me interesa: ${item.title}`);

        return `
        <article style="background:white;border-radius:.75rem;box-shadow:0 2px 8px rgba(0,0,0,.08);overflow:hidden;display:flex;flex-direction:column;">
            <a href="${escapeHtml(href)}" style="display:block;aspect-ratio:2/3;overflow:hidden;background:#f1f5f9;">
                ${img ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(item.title)}" loading="lazy" style="width:100%;height:100%;object-fit:cover;">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:2rem;">📚</div>'}
            </a>
            <div style="padding:1rem;flex:1;display:flex;flex-direction:column;gap:.5rem;">
                <h2 style="font-size:.875rem;font-weight:700;color:#1e293b;line-height:1.35;margin:0;">
                    <a href="${escapeHtml(href)}" style="color:inherit;text-decoration:none;">${escapeHtml(item.title)}</a>
                </h2>
                ${item.author ? `<p style="font-size:.75rem;color:#64748b;margin:0;">${escapeHtml(item.author)}</p>` : ''}
                <p style="font-size:.75rem;font-weight:600;margin:0;">
                    <span style="color:${inStock ? '#16a34a' : '#92400e'};">${inStock ? '✓ En stock' : '⏳ Por encargo'}</span>
                </p>
                ${price > 0 ? `<p style="font-size:1rem;font-weight:800;color:#7c3aed;margin:0;">$${escapeHtml(priceUY)} <span style="font-size:.75rem;font-weight:400;color:#94a3b8;">UYU</span></p>` : ''}
                <div style="display:flex;flex-direction:column;gap:.4rem;margin-top:auto;">
                    <a href="${escapeHtml(href)}" style="display:block;text-align:center;background:#1e293b;color:white;font-size:.8rem;font-weight:700;padding:.5rem;border-radius:.4rem;text-decoration:none;">Ver ficha</a>
                    <a href="https://wa.me/${WA}?text=${waMsg}" target="_blank" rel="noopener noreferrer" style="display:block;text-align:center;background:#25d366;color:white;font-size:.8rem;font-weight:700;padding:.5rem;border-radius:.4rem;text-decoration:none;">💬 WhatsApp</a>
                </div>
            </div>
        </article>`;
    }).join('');

    const emptyMsg = items.length === 0
        ? `<p style="color:#64748b;font-size:1rem;">No encontramos títulos de Montessori en el catálogo en este momento. Podés consultarnos por <a href="https://wa.me/${WA}?text=Hola!%20Busco%20libros%20de%20Montessori" target="_blank" style="color:#1d4ed8;">WhatsApp</a> — conseguimos libros por encargo.</p>`
        : '';

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Libros de María Montessori en Uruguay | Amado Libros</title>
  <meta name="description" content="Libros de María Montessori disponibles en Uruguay. Consultá stock por WhatsApp, comprá online o pedí libros difíciles de ubicar. Envíos a Montevideo e interior.">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${BASE}/libros-maria-montessori-uruguay">
  <link rel="icon" type="image/png" href="/images/logo-amado.png">

  <meta property="og:type"        content="website">
  <meta property="og:url"         content="${BASE}/libros-maria-montessori-uruguay">
  <meta property="og:title"       content="Libros de María Montessori en Uruguay | Amado Libros">
  <meta property="og:description" content="Libros de María Montessori disponibles en Uruguay. Consultá stock por WhatsApp, comprá online o pedí libros difíciles de ubicar.">
  <meta property="og:image"       content="${BASE}/images/logo-amado.png">
  <meta property="og:locale"      content="es_UY">

  <script type="application/ld+json">${JSON.stringify(schemaCollectionPage)}</script>
  <script type="application/ld+json">${JSON.stringify(schemaItemList)}</script>
  <script type="application/ld+json">${JSON.stringify(schemaBreadcrumb)}</script>

  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#faf7f2;color:#1e293b;line-height:1.6}
    a{color:#3b82f6}
    header{background:#1e293b;color:white;padding:.75rem 1.25rem;display:flex;align-items:center;gap:.75rem;position:sticky;top:0;z-index:40;}
    header a{color:white;text-decoration:none;font-weight:700;font-size:1.05rem}
    header span{color:#94a3b8;font-size:.8rem}
    nav{background:white;padding:.5rem 1.25rem;font-size:.85rem;border-bottom:1px solid #e2e8f0;color:#64748b}
    nav a{color:#3b82f6;text-decoration:none}
    nav a:hover{text-decoration:underline}
    main{max-width:1100px;margin:0 auto;padding:2rem 1rem}
    .intro{background:white;border-radius:.75rem;padding:1.5rem;margin-bottom:2rem;border:1px solid #e2e8f0}
    .intro h1{font-size:1.6rem;font-weight:800;color:#1e293b;margin-bottom:.75rem}
    .intro p{color:#475569;font-size:.95rem;line-height:1.7;margin-bottom:.75rem}
    .intro p:last-child{margin-bottom:0}
    .count{font-size:.875rem;color:#64748b;margin-bottom:1.25rem}
    .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:1rem}
    @media(min-width:480px){.grid{grid-template-columns:repeat(3,1fr)}}
    @media(min-width:768px){.grid{grid-template-columns:repeat(4,1fr)}}
    @media(min-width:1024px){.grid{grid-template-columns:repeat(5,1fr)}}
    .wa-cta{background:#25d366;color:white;padding:1rem 1.5rem;border-radius:.75rem;margin-top:2rem;display:flex;align-items:center;gap:.75rem;text-decoration:none;font-weight:700;width:fit-content}
    .wa-cta:hover{background:#1ebe5d}
    footer{background:#1e293b;color:#94a3b8;text-align:center;font-size:.8rem;padding:1.5rem;margin-top:3rem}
    footer a{color:#cbd5e1;text-decoration:none}
    footer a:hover{text-decoration:underline}
  </style>
</head>
<body>

<header>
  <a href="/">📚 Amado Libros</a>
  <span>Tu librería para libros difíciles de ubicar</span>
</header>

<nav>
  <a href="/">Inicio</a> ›
  <a href="/catalogo">Catálogo</a> ›
  <span>Libros de María Montessori</span>
</nav>

<main>
  <div class="intro">
    <h1>Libros de María Montessori en Uruguay</h1>
    <p>En Amado Libros reunimos una selección destacada de libros de María Montessori disponibles para comprar en Uruguay. Trabajamos títulos de pedagogía Montessori, educación, infancia, crianza y formación docente. Podés consultar stock por WhatsApp, comprar online o pedir libros difíciles de ubicar. Enviamos a Montevideo y al interior.</p>
    <p>¿No encontrás el título que buscás? <a href="https://wa.me/${WA}?text=Hola!%20Busco%20un%20libro%20de%20Montessori" target="_blank" rel="noopener noreferrer">Consultanos por WhatsApp</a> — lo conseguimos por encargo.</p>
  </div>

  ${items.length > 0 ? `<p class="count">${items.length} título${items.length !== 1 ? 's' : ''} disponible${items.length !== 1 ? 's' : ''}</p>` : ''}

  ${emptyMsg}

  <div class="grid">
    ${cards}
  </div>

  <a href="https://wa.me/${WA}?text=Hola!%20Busco%20libros%20de%20Maria%20Montessori" target="_blank" rel="noopener noreferrer" class="wa-cta">
    💬 Consultá por WhatsApp
  </a>
</main>

<footer>
  &copy; 2026 Amado Libros. Todos los derechos reservados. ·
  <a href="/">Catálogo</a> ·
  <a href="/catalogo">Índice de libros</a> ·
  <a href="/politicas">Políticas y contacto</a>
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
