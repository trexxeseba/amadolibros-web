/**
 * /regalos — Regalos que se recuerdan (Navidad 2026).
 *
 * Vitrina curada (functions/_shared/regalos.js + data/regalos.json): libros en
 * stock desde $2.500 con alma de regalo, agrupados por para quién son. Precios
 * del catálogo vigente, iguales a la ficha y el carrito. Acción principal:
 * Agregar al carrito; WhatsApp queda como ayuda para elegir o coordinar.
 *
 * Hasta Navidad muestra las fechas límite de pedido (Montevideo 23/12,
 * interior 18/12); después sigue como vitrina sin fechas.
 */
import { BASE, fetchCatalog } from './_shared/catalog.js';
import { slugify } from './_shared/slug.js';
import { faviconHeadHtml, footerHtml, FOOTER_STYLES, waFloatHtml, WA_FLOAT_STYLES } from './_shared/brand.js';
import { siteHeaderHtml, SITE_HEADER_STYLES, SITE_HEADER_SCRIPT, SITE_FONTS_HEAD } from './_shared/site-header.js';
import { bookCoverUrl, CARD_IMAGE_SIZES, responsiveImage } from './_shared/cloudflare-images.js';
import { deriveBookDisplayTitle } from './_shared/book-display-title.js';
import { promoAwareCacheControl, promoWasHtml } from './_shared/web-promo.js';
import { transferDisplayPrice } from './_shared/descuentos.js';
import { buildWhatsAppMessage, whatsappHref } from '../shared/whatsapp-messages.js';
import { googleReviewsHtml } from '../shared/google-reviews.js';
import { REGALOS, selectRegalos, groupRegalos, navidadEstado, diasHasta, fechaLarga } from './_shared/regalos.js';

const FREE_SHIPPING_THRESHOLD_UYU = 1500;

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function httpsImg(url) {
    return (url || '').replace('http://', 'https://').replace(/-I\.(jpg|jpeg|png|webp)(?=($|\?))/i, '-O.$1');
}

async function fetchCategories(ctx) {
    try {
        const url = new URL('/data/active-categories.json', ctx.request.url).toString();
        const cache = caches.default;
        const key = new Request(url);
        let response = await cache.match(key);
        if (!response) {
            const fetched = await fetch(url);
            if (!fetched.ok) return null;
            response = new Response(fetched.body, {
                status: fetched.status,
                headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
            });
            if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(cache.put(key, response.clone()));
        }
        const data = await response.json();
        return data && typeof data.items === 'object' ? data : null;
    } catch {
        return null;
    }
}

export function firstCategory(categoryData, id) {
    const raw = categoryData?.items?.[id];
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const first = Array.isArray(raw[0]) ? raw[0] : raw;
    return typeof first[0] === 'string' ? first[0] : null;
}

export function regaloWhatsAppMessage(book, href) {
    return buildWhatsAppMessage({
        greeting: 'Hola, vi este libro en Regalos de Amado Libros y lo quiero para regalar, con envoltorio y tarjeta.',
        motive: 'Regalo',
        book: book.title,
        author: book.author,
        price: Number(book.price) > 0 ? `$${Number(book.price).toLocaleString('es-UY')} UYU` : '',
        page: href,
        closing: 'Quisiera coordinar la compra y la entrega. Gracias.',
    });
}

/** Texto de las fechas de entrega según el momento. Vacío pasada Navidad. */
export function navidadHtml(now = Date.now()) {
    const estado = navidadEstado(now);
    if (estado === 'ninguna') return '';
    const cfg = REGALOS.navidad;
    const mvd = diasHasta(cfg.montevideoHasta, now);
    const lines = [
        `<li><strong>Montevideo:</strong> pedilo hasta el ${escapeHtml(fechaLarga(cfg.montevideoHasta))} y llega antes de Nochebuena${mvd > 1 ? ` (faltan ${mvd} días)` : mvd === 1 ? ' (es mañana)' : ' (es hoy)'}.</li>`,
    ];
    if (estado === 'ambas') {
        lines.push(`<li><strong>Resto del país:</strong> pedilo hasta el ${escapeHtml(fechaLarga(cfg.interiorHasta))} y viaja con tiempo por DAC, sin cargo.</li>`);
    } else {
        lines.push('<li><strong>Resto del país:</strong> escribinos por WhatsApp y vemos juntos la mejor forma de que llegue.</li>');
    }
    return `<section class="rg-dates" aria-label="Fechas de entrega para Navidad">
    <h2>Para que llegue antes de Navidad</h2>
    <ul>${lines.join('')}</ul>
    <p>También podés retirarlo en Ciudad Vieja, coordinando por WhatsApp.</p>
  </section>`;
}

/** Envoltorio y tarjeta sin cargo: se piden al confirmar el pedido por WhatsApp. */
export function envoltorioHtml() {
    return `<section class="rg-wrap" aria-label="Envoltorio de regalo">
    <h2>Lo envolvemos para regalar, sin cargo</h2>
    <p>Papel de regalo y tarjeta con tu dedicatoria, escrita a mano. Después de comprar, mandanos por WhatsApp el número de pedido y la dedicatoria, y llega listo para entregar.</p>
  </section>`;
}

export function cardHtml(book, idx, env, group) {
    const href = `/libro/${book.id}/${slugify(book.title)}`;
    const source = env?.APP_ENV === 'production'
        ? bookCoverUrl(book.id)
        : httpsImg(book.pictures?.[0] || book.thumbnail || '');
    const image = responsiveImage(source, { widths: [240, 360, 480], defaultWidth: 360, sizes: CARD_IMAGE_SIZES });
    const display = deriveBookDisplayTitle(book);
    const title = escapeHtml(display.removedParts.length ? display.title : book.title);
    const price = Math.round(Number(book.price) || 0);
    const currency = String(book.currency_id || book.currency || 'UYU').toUpperCase();
    const maxQty = Math.floor(Number(book.available_quantity));
    const canAddToCart = /^MLU\d+$/.test(String(book.id)) && book.status === 'active' && Number.isFinite(maxQty) && maxQty >= 1 && Number.isFinite(price) && price > 0 && currency === 'UYU';
    const priceStr = price.toLocaleString('es-UY');
    const transferValue = transferDisplayPrice(book);
    const transfer = transferValue === null ? '' : transferValue.toLocaleString('es-UY');
    const responsive = image.srcset ? ` srcset="${escapeHtml(image.srcset)}" sizes="${escapeHtml(image.sizes)}"` : '';
    const img = image.src
        ? `<img src="${escapeHtml(image.src)}"${responsive} alt="${title}" loading="${idx < 8 ? 'eager' : 'lazy'}" decoding="async" width="280" height="373">`
        : '<div class="rc-no-img" aria-hidden="true"></div>';
    const wa = whatsappHref(regaloWhatsAppMessage(book, href));
    const qty = Number(book.available_quantity) || 0;
    return `<article class="rc-card">
  <a href="${escapeHtml(href)}" class="rc-img">${img}</a>
  <div class="rc-body">
    ${qty === 1 ? '<span class="rg-badge">Último ejemplar</span>' : ''}
    <a href="${escapeHtml(href)}" class="rc-title-link"><p class="rc-title">${title}</p></a>
    ${book.author ? `<p class="rc-author">${escapeHtml(book.author)}</p>` : ''}
    <div class="rc-prices">
      <span class="rc-base">$${escapeHtml(priceStr)} UYU</span>
      ${promoWasHtml(book)}
      ${transfer ? `<span class="rc-transfer">12% menos por transferencia: $${escapeHtml(transfer)} UYU</span>` : ''}
      ${price >= FREE_SHIPPING_THRESHOLD_UYU ? '<span class="rc-free-shipping">Envío gratis</span>' : ''}
    </div>
    <div class="rc-actions">
      ${canAddToCart ? `<button type="button" class="rc-cta rc-cart" data-action="add-to-cart"
        data-id="${escapeHtml(book.id)}" data-title="${escapeHtml(book.title)}"
        data-price="${price}" data-thumbnail="${escapeHtml(image.src)}" data-max-qty="${maxQty}">
        <span data-cart-label>Agregar al carrito</span>
      </button>` : ''}
      <a href="${escapeHtml(wa)}" class="rc-cta rc-wa" target="_blank" rel="noopener noreferrer" data-cta-location="regalos_card" data-mlu="${escapeHtml(book.id)}" data-topic="${escapeHtml(group)}">Consultar</a>
      <a href="${escapeHtml(href)}" class="rc-cta">Ver ficha</a>
    </div>
  </div>
</article>`;
}

function groupsNavHtml(groups) {
    if (groups.length < 2) return '';
    return `<nav class="topic-chips" aria-label="Para quién">${groups.map(g => `<a class="topic-chip" href="#${escapeHtml(g.id)}">${escapeHtml(g.name)} (${g.items.length})</a>`).join('')}</nav>`;
}

function unavailable() {
    return new Response('<!doctype html><html lang="es"><head><meta charset="UTF-8"><meta name="robots" content="noindex"><title>Regalos | Amado Libros</title></head><body style="font-family:system-ui,sans-serif;max-width:640px;margin:4rem auto;padding:1rem"><h1>Estamos actualizando la vitrina de regalos</h1><p>Volvé en unos minutos. Mientras tanto podés ver <a href="/catalogo">todo el catálogo</a>.</p></body></html>', {
        status: 503,
        headers: { 'content-type': 'text/html;charset=UTF-8', 'cache-control': 'no-store', 'retry-after': '120' },
    });
}

export async function onRequest(ctx) {
    let catalog;
    try { catalog = await fetchCatalog(ctx); } catch { catalog = null; }
    if (!catalog || !Array.isArray(catalog.items)) return unavailable();

    const now = Date.now();
    const categoryData = await fetchCategories(ctx);
    const selected = selectRegalos(catalog.items);
    const groups = groupRegalos(selected, id => firstCategory(categoryData, id));
    const estado = navidadEstado(now);
    const navideno = estado !== 'ninguna';

    const title = navideno
        ? 'Regalos de Navidad: libros en stock con entrega antes del 24 | Amado Libros'
        : 'Regalos que se recuerdan: libros en stock para regalar | Amado Libros';
    const description = `${selected.length} libros para regalar, en stock, con envoltorio y tarjeta sin cargo y envío gratis a todo Uruguay: ediciones ilustradas, estuches, clásicos en tapa dura, cómics y mazos de tarot, elegidos por Amado Libros.`;
    const canonical = `${BASE}${REGALOS.path}`;
    const generalWa = whatsappHref(buildWhatsAppMessage({
        greeting: 'Hola, estoy buscando un libro para regalar y vi la vitrina de Regalos de Amado Libros.',
        motive: 'Regalo',
        page: REGALOS.path,
        closing: 'Les cuento para quién es y me ayudan a elegir. Gracias.',
    }));
    const lead = navideno
        ? 'Libros que ya están en nuestros estantes, elegidos uno por uno para regalar: ediciones ilustradas, estuches, clásicos en tapa dura, cómics y mazos. Envoltorio y tarjeta sin cargo, envío gratis a todo el país y, pagando por transferencia, 12% menos.'
        : 'Libros que ya están en nuestros estantes, elegidos uno por uno para regalar. Envoltorio y tarjeta sin cargo, envío gratis a todo el país y, pagando por transferencia, 12% menos.';

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <script src="/cart.js" defer></script>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${escapeHtml(canonical)}">
  <meta name="robots" content="index, follow">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="es_UY">
  <meta property="og:site_name" content="Amado Libros">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(canonical)}">
  <meta property="og:image" content="${BASE}/images/logo-amado.webp">
  ${faviconHeadHtml()}
  ${SITE_FONTS_HEAD}
  <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: REGALOS.name,
        url: canonical,
        description,
        isPartOf: { '@type': 'WebSite', name: 'Amado Libros', url: BASE },
    }).replace(/</g, '\\u003c')}</script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#faf7f2;color:#1e293b;line-height:1.5}
    ${SITE_HEADER_STYLES}
    ${FOOTER_STYLES}
    ${WA_FLOAT_STYLES}
    .wrap{max-width:1100px;margin:0 auto;padding:1.25rem 1rem 3rem}
    .rg-hero{margin:0 0 1rem;padding:1.5rem 1.25rem;border-radius:1rem;background:#1f2a1f;color:#fff8f0}
    .rg-eyebrow{color:#e6b36a;font-size:.72rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
    .rg-hero h1{font-family:"Playfair Display",Georgia,serif;font-size:1.75rem;line-height:1.2;margin:.3rem 0 .5rem}
    .rg-hero p{color:rgba(255,248,240,.85);font-size:.95rem;max-width:720px}
    .rg-hero a{display:inline-flex;margin-top:.9rem;min-height:44px;align-items:center;padding:.6rem 1rem;border-radius:.6rem;background:#25d366;color:#0b2b17;font-weight:800;text-decoration:none}
    .rg-dates{margin:0 0 1.25rem;padding:1rem 1.25rem;border:1px solid #e0d2b4;border-radius:.9rem;background:#fff9ec}
    .rg-dates h2{font-family:"Playfair Display",Georgia,serif;font-size:1.15rem;color:#1f2a1f;margin-bottom:.4rem}
    .rg-dates ul{list-style:none;display:flex;flex-direction:column;gap:.3rem;font-size:.92rem}
    .rg-dates p{margin-top:.5rem;font-size:.85rem;color:#6b6157}
    .rg-wrap{margin:0 0 1.25rem;padding:1rem 1.25rem;border-radius:.9rem;background:#fff;border:1px solid #e2dbd0;display:flex;flex-direction:column;gap:.3rem}
    .rg-wrap h2{font-family:"Playfair Display",Georgia,serif;font-size:1.15rem;color:#1f2a1f}
    .rg-wrap p{font-size:.92rem;color:#3f3a35;max-width:720px}
    .topic-chips{display:flex;gap:.45rem;overflow-x:auto;padding-bottom:.4rem;margin-bottom:.75rem;-webkit-overflow-scrolling:touch}
    @media(min-width:900px){.topic-chips{flex-wrap:wrap;overflow:visible}}
    .topic-chip{flex:0 0 auto;display:inline-flex;align-items:center;min-height:40px;padding:.45rem .85rem;border:1px solid #d1c8be;border-radius:999px;background:#fff;color:#18120e;font-size:.84rem;font-weight:700;text-decoration:none;white-space:nowrap}
    .rg-group{margin:1.75rem 0 0;scroll-margin-top:5rem}
    .rg-group h2{font-family:"Playfair Display",Georgia,serif;font-size:1.35rem;color:#1f2a1f;margin-bottom:.75rem}
    .grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
    @media(min-width:500px){.grid{grid-template-columns:repeat(auto-fill,minmax(180px,1fr))}}
    @media(min-width:900px){.grid{grid-template-columns:repeat(4,1fr)}}
    .rc-card{display:flex;flex-direction:column;background:#fff;border:1px solid #e2dbd0;border-radius:.75rem;overflow:hidden}
    .rc-img{display:block;aspect-ratio:3/4;background:#ede9e1;overflow:hidden;padding:.35rem}
    .rc-img img{width:100%;height:100%;object-fit:contain;display:block}
    .rc-no-img{width:100%;height:100%}
    .rc-body{padding:.875rem 1rem;display:flex;flex-direction:column;gap:.4rem;flex:1}
    .rg-badge{align-self:flex-start;padding:.18rem .55rem;border-radius:999px;background:#fff3dc;color:#8a5a0a;font-size:.68rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase}
    .rc-title{font-size:.95rem;font-weight:700;color:#18120e;line-height:1.25;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
    .rc-title-link{text-decoration:none;color:inherit}
    .rc-author{font-size:.82rem;color:#6b6157;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .rc-prices{display:flex;flex-direction:column;gap:.2rem;margin-top:.2rem}
    .rc-base{font-size:1.05rem;color:#18120e;font-weight:800}
    .rc-transfer{font-size:.78rem;color:#a94e3d;font-weight:600}
    .rc-free-shipping{font-size:.78rem;color:#267a42;font-weight:700}
    .rc-actions{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:auto;padding-top:.4rem}
    .rc-cta{display:inline-flex;align-items:center;min-height:40px;padding:.35rem .85rem;border:1px solid #e2dbd0;border-radius:2rem;font-size:.82rem;font-weight:700;color:#18120e;background:#f5f0ea;text-decoration:none}
    .rc-cta.rc-cart{width:100%;min-height:44px;border-color:#b4442a;border-radius:.6rem;background:#b4442a;color:#fff;font-family:inherit;cursor:pointer}
    .rc-cta.rc-cart:focus-visible{outline:3px solid #1e293b;outline-offset:3px}
    .rc-cta.rc-wa{color:#fff;border-color:#1a9e4b;background:#1a9e4b}
    .rg-help{margin:2rem 0 0;padding:1.25rem;border-radius:1rem;background:#fff;border:1px solid #e2dbd0}
    .rg-help h2{font-family:"Playfair Display",Georgia,serif;font-size:1.2rem;margin-bottom:.4rem}
    .rg-help p{font-size:.95rem;color:#3f3a35;max-width:720px}
    .rg-help a{display:inline-flex;margin-top:.75rem;min-height:44px;align-items:center;padding:.6rem 1rem;border-radius:.6rem;background:#1a9e4b;color:#fff;font-weight:800;text-decoration:none}
    .rg-reviews{margin-top:2rem}
    .empty{padding:2rem 0;color:#64748b}
  </style>
</head>
<body>
${siteHeaderHtml({ current: 'regalos' })}
<main class="wrap">
  <section class="rg-hero">
    <p class="rg-eyebrow">${navideno ? 'Navidad 2026 · En stock · Envoltorio sin cargo' : 'En stock · Envoltorio sin cargo'}</p>
    <h1>${escapeHtml(REGALOS.name)}</h1>
    <p>${lead}</p>
    <a href="${escapeHtml(generalWa)}" target="_blank" rel="noopener noreferrer" data-cta-location="regalos_hero">Contanos para quién es y te ayudamos a elegir</a>
  </section>
  ${navidadHtml(now)}
  ${envoltorioHtml()}
  ${groupsNavHtml(groups)}
  ${groups.length
        ? groups.map(g => `<section class="rg-group" id="${escapeHtml(g.id)}"><h2>${escapeHtml(g.name)}</h2><div class="grid">${g.items.map((b, i) => cardHtml(b, i, ctx.env, g.id)).join('\n')}</div></section>`).join('\n')
        : '<p class="empty">Estamos preparando la próxima tanda de regalos. Mientras tanto, te esperan <a href="/catalogo">todos los libros del catálogo</a>.</p>'}
  <section class="rg-help">
    <h2>¿Buscás algo que no está acá?</h2>
    <p>Tenemos miles de libros en stock y buscamos ediciones difíciles en España, Argentina y Estados Unidos. Contanos qué le gusta a esa persona y te proponemos dos o tres opciones con foto y precio.</p>
    <a href="${escapeHtml(generalWa)}" target="_blank" rel="noopener noreferrer" data-cta-location="regalos_help">Pedir una recomendación por WhatsApp</a>
  </section>
  <div class="rg-reviews">${googleReviewsHtml({ limit: 3, seed: 'regalos', columns: 3, title: 'Lo que cuentan quienes ya regalaron' })}</div>
</main>
${footerHtml(new Date(now).getFullYear(), REGALOS.path)}
${waFloatHtml(null, REGALOS.path)}
${SITE_HEADER_SCRIPT}
</body>
</html>`;

    return new Response(html, {
        headers: {
            'content-type': 'text/html;charset=UTF-8',
            'cache-control': promoAwareCacheControl(900, new Date(now), ctx.env),
            'x-regalos-total': String(selected.length),
        },
    });
}
