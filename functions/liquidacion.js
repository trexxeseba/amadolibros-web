/**
 * /liquidacion — Promo Liquidación Amado.
 *
 * Vitrina de la liquidación (selección en _shared/liquidacion.js): la lista de
 * Seba en data/liquidacion.json, menos las exclusiones automáticas. Mientras la
 * lista esté vacía sigue la regla anterior (1 año sin ventas), con falla
 * cerrada: si D1 no responde, la vitrina queda vacía, nunca todo el stock.
 *
 * Precios: los del catálogo vigente, iguales a los de la ficha y el carrito
 * (con la promo web aplicada cuando hay una activa). Esta página no inventa
 * descuentos propios.
 *
 * Acción principal: "Lo quiero" a WhatsApp con el título precargado, porque el
 * cliente de Amado escribe antes de comprar; la ficha queda como segundo paso.
 */
import { BASE, fetchCatalog } from './_shared/catalog.js';
import { slugify } from './_shared/slug.js';
import { faviconHeadHtml, footerHtml, FOOTER_STYLES, waFloatHtml, WA_FLOAT_STYLES } from './_shared/brand.js';
import { siteHeaderHtml, SITE_HEADER_STYLES, SITE_HEADER_SCRIPT, SITE_FONTS_HEAD } from './_shared/site-header.js';
import { bookCoverUrl, CARD_IMAGE_SIZES, responsiveImage } from './_shared/cloudflare-images.js';
import { deriveBookDisplayTitle } from './_shared/book-display-title.js';
import { promoAwareCacheControl, promoWasHtml, webPromoActive, WEB_PROMO } from './_shared/web-promo.js';
import { LIQUIDACION, resolveLiquidation, sortLiquidation } from './_shared/liquidacion.js';
import { liquidationPricingActive, transferDisplayPrice, LIQUIDACION_PRECIO, TRANSFER_DISCOUNT } from './_shared/descuentos.js';
import { buildWhatsAppMessage, whatsappHref } from '../shared/whatsapp-messages.js';
import { RUEDA_SCRIPT, RUEDA_STYLES, ruedaHtml } from './_shared/rueda-ui.js';
import { ACERTIJO_SCRIPT, ACERTIJO_STYLES, acertijoHtml } from './_shared/acertijo-ui.js';
import { PREMIO_LIB_SCRIPT, PREMIO_LIQ_SCRIPT, PREMIO_STYLES, premioBannerHtml } from './_shared/premio-ui.js';

export const PAGE_SIZE = 48;
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

function firstCategory(categoryData, id) {
    const raw = categoryData?.items?.[id];
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const first = Array.isArray(raw[0]) ? raw[0] : raw;
    return typeof first[0] === 'string' ? first[0] : null;
}

/** Temas presentes en la liquidación, de mayor a menor cantidad. */
export function liquidationTopics(items, categoryData) {
    const names = new Map((categoryData?.categories || []).map(c => [c.id, c.name]));
    const counts = new Map();
    for (const item of items) {
        const cat = firstCategory(categoryData, item.id);
        if (!cat || !names.has(cat)) continue;
        counts.set(cat, (counts.get(cat) || 0) + 1);
    }
    return [...counts.entries()]
        .map(([id, count]) => ({ id, name: names.get(id), count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es'));
}

function pagePath({ tema = '', page = 1 }) {
    const params = new URLSearchParams();
    if (tema) params.set('tema', tema);
    if (page > 1) params.set('page', String(page));
    const qs = params.toString();
    return `${LIQUIDACION.path}${qs ? `?${qs}` : ''}`;
}

export function liquidationWhatsAppMessage(book, href) {
    return buildWhatsAppMessage({
        greeting: 'Hola, vi este libro en la Promo Liquidación de Amado Libros y lo quiero.',
        motive: LIQUIDACION.name,
        book: book.title,
        author: book.author,
        price: Number(book.price) > 0 ? `$${Number(book.price).toLocaleString('es-UY')} UYU` : '',
        page: href,
        closing: 'Quisiera coordinar la compra y la entrega. Gracias.',
    });
}

function cardHtml(book, idx, env, topic = '') {
    const href = `/libro/${book.id}/${slugify(book.title)}`;
    const source = env?.APP_ENV === 'production'
        ? bookCoverUrl(book.id)
        : httpsImg(book.pictures?.[0] || book.thumbnail || '');
    const image = responsiveImage(source, { widths: [240, 360, 480], defaultWidth: 360, sizes: CARD_IMAGE_SIZES });
    const display = deriveBookDisplayTitle(book);
    const title = escapeHtml(display.removedParts.length ? display.title : book.title);
    const price = Number(book.price) || 0;
    const priceStr = price.toLocaleString('es-UY');
    const transferValue = transferDisplayPrice(book);
    const transfer = transferValue === null ? '' : transferValue.toLocaleString('es-UY');
    const responsive = image.srcset ? ` srcset="${escapeHtml(image.srcset)}" sizes="${escapeHtml(image.sizes)}"` : '';
    const img = image.src
        ? `<img src="${escapeHtml(image.src)}"${responsive} alt="${title}" loading="${idx < 8 ? 'eager' : 'lazy'}" decoding="async" width="280" height="373">`
        : '<div class="rc-no-img" aria-hidden="true"></div>';
    const wa = whatsappHref(liquidationWhatsAppMessage(book, href));
    const habitual = Number(book.original_price) > price ? Math.round(Number(book.original_price)) : price;
    return `<article class="rc-card" data-precio="${price}" data-habitual="${habitual}">
  <a href="${escapeHtml(href)}" class="rc-img">${img}</a>
  <div class="rc-body">
    <span class="liq-badge">Liquidación</span>
    <a href="${escapeHtml(href)}" class="rc-title-link"><p class="rc-title">${title}</p></a>
    ${book.author ? `<p class="rc-author">${escapeHtml(book.author)}</p>` : ''}
    <div class="rc-prices">
      <span class="rc-base">$${escapeHtml(priceStr)} UYU</span>
      ${promoWasHtml(book)}
      ${transfer ? `<span class="rc-transfer">12% menos por transferencia: $${escapeHtml(transfer)} UYU</span>` : ''}
      ${price >= FREE_SHIPPING_THRESHOLD_UYU ? '<span class="rc-free-shipping">Envío gratis</span>' : ''}
    </div>
    <div class="rc-actions">
      <a href="${escapeHtml(wa)}" class="rc-cta rc-wa" target="_blank" rel="noopener noreferrer" data-cta-location="liquidacion_card" data-mlu="${escapeHtml(book.id)}"${topic ? ` data-topic="${escapeHtml(topic)}"` : ''}>Lo quiero</a>
      <a href="${escapeHtml(href)}" class="rc-cta">Ver ficha</a>
    </div>
  </div>
</article>`;
}

function topicsHtml(topics, tema, total) {
    if (topics.length === 0) return '';
    const all = `<a class="topic-chip${tema ? '' : ' is-current'}" href="${LIQUIDACION.path}"${tema ? '' : ' aria-current="page"'}>Todos (${total})</a>`;
    const chips = topics.map(t => {
        const current = t.id === tema;
        return `<a class="topic-chip${current ? ' is-current' : ''}" href="${escapeHtml(pagePath({ tema: t.id }))}"${current ? ' aria-current="page"' : ''}>${escapeHtml(t.name)} (${t.count})</a>`;
    }).join('');
    return `<nav class="topic-chips" aria-label="Temas en liquidación">${all}${chips}</nav>`;
}

function pagerHtml(page, totalPages, tema) {
    if (totalPages <= 1) return '';
    const prev = page > 1
        ? `<a class="pager-link" rel="prev" href="${escapeHtml(pagePath({ tema, page: page - 1 }))}">← Anterior</a>`
        : '<span class="pager-link is-disabled">← Anterior</span>';
    const next = page < totalPages
        ? `<a class="pager-link" rel="next" href="${escapeHtml(pagePath({ tema, page: page + 1 }))}">Siguiente →</a>`
        : '<span class="pager-link is-disabled">Siguiente →</span>';
    return `<nav class="pager" aria-label="Páginas de la liquidación">${prev}<span>Página ${page} de ${totalPages}</span>${next}</nav>`;
}

function unavailable() {
    return new Response('<!doctype html><html lang="es"><head><meta charset="UTF-8"><meta name="robots" content="noindex"><title>Promo Liquidación Amado</title></head><body style="font-family:system-ui,sans-serif;max-width:640px;margin:4rem auto;padding:1rem"><h1>Estamos actualizando la liquidación</h1><p>Volvé en unos minutos. Mientras tanto podés ver <a href="/catalogo">todo el catálogo</a>.</p></body></html>', {
        status: 503,
        headers: { 'content-type': 'text/html;charset=UTF-8', 'cache-control': 'no-store', 'retry-after': '120' },
    });
}

export async function onRequest(ctx) {
    const url = new URL(ctx.request.url);
    const rawPage = url.searchParams.get('page');
    const page = rawPage === null ? 1 : Number(rawPage);
    if (rawPage !== null && (!Number.isInteger(page) || page < 2)) {
        const clean = new URL(url);
        clean.searchParams.delete('page');
        return new Response(null, { status: 301, headers: { Location: `${clean.pathname}${clean.search}` } });
    }

    let catalog;
    try { catalog = await fetchCatalog(ctx); } catch { catalog = null; }
    if (!catalog || !Array.isArray(catalog.items)) return unavailable();

    const now = Date.now();
    const categoryData = await fetchCategories(ctx);
    const liquidation = await resolveLiquidation(ctx, catalog.items, { now });
    const selected = sortLiquidation(liquidation.selected, now);
    const topics = liquidationTopics(selected, categoryData);
    const rawTema = url.searchParams.get('tema')?.trim() || '';
    const tema = topics.some(t => t.id === rawTema) ? rawTema : '';
    if (rawTema && !tema) return new Response(null, { status: 301, headers: { Location: pagePath({ page: 1 }) } });

    const filtered = tema ? selected.filter(item => firstCategory(categoryData, item.id) === tema) : selected;
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (page > totalPages) return new Response('Página inexistente', { status: 404, headers: { 'x-robots-tag': 'noindex' } });
    const slice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

    const temaName = tema ? topics.find(t => t.id === tema).name : '';
    const promoOn = webPromoActive(new Date(now), ctx.env);
    const liquidationPriced = liquidation.mode === 'lista' && liquidationPricingActive(new Date(now), ctx.env);
    const lead = liquidationPriced
        ? `Libros que te esperan en nuestros estantes, en stock y listos para salir hoy, con ${Math.round(LIQUIDACION_PRECIO.discount * 100)}% menos sobre su precio habitual, y ${Math.round(TRANSFER_DISCOUNT * 100)}% más pagando por transferencia.`
        : promoOn
        ? `Libros que te esperan en nuestros estantes, listos para salir hoy. Con la ${escapeHtml(WEB_PROMO.name)}, ${WEB_PROMO.percent}% menos hasta el ${escapeHtml(WEB_PROMO.endLabel)}, y 12% más pagando por transferencia.`
        : 'Libros que te esperan en nuestros estantes, en stock y listos para salir hoy. Pagando por transferencia tenés 12% menos.';
    const heading = temaName ? `${LIQUIDACION.name}: ${escapeHtml(temaName)}` : LIQUIDACION.name;
    const title = `${temaName ? `${temaName} en liquidación` : 'Promo Liquidación Amado: libros en stock'}${page > 1 ? ` — Página ${page}` : ''} | Amado Libros`;
    const description = `${filtered.length} libros en stock con entrega inmediata en Uruguay: la liquidación de Amado Libros${temaName ? ` en ${temaName}` : ''}.`;
    const canonical = `${BASE}${pagePath({ tema, page })}`;
    const generalWa = whatsappHref(buildWhatsAppMessage({
        greeting: 'Hola, estoy mirando la Promo Liquidación de Amado Libros.',
        motive: LIQUIDACION.name,
        page: pagePath({ tema, page }),
        closing: 'Quisiera que me recomienden algo de la liquidación. Gracias.',
    }));

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
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
        name: LIQUIDACION.name,
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
    .liq-hero{margin:0 0 1rem;padding:1.25rem;border-radius:1rem;background:#18120e;color:#fff8f0}
    .liq-eyebrow{color:#e49982;font-size:.72rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
    .liq-hero h1{font-family:"Playfair Display",Georgia,serif;font-size:1.6rem;line-height:1.2;margin:.3rem 0 .5rem}
    .liq-hero p{color:rgba(255,248,240,.82);font-size:.95rem;max-width:720px}
    .liq-hero a{display:inline-flex;margin-top:.9rem;min-height:44px;align-items:center;padding:.6rem 1rem;border-radius:.6rem;background:#25d366;color:#0b2b17;font-weight:800;text-decoration:none}
    .topic-chips{display:flex;gap:.45rem;overflow-x:auto;padding-bottom:.4rem;margin-bottom:.75rem;-webkit-overflow-scrolling:touch}
    @media(min-width:900px){.topic-chips{flex-wrap:wrap;overflow:visible}}
    .topic-chip{flex:0 0 auto;display:inline-flex;align-items:center;min-height:40px;padding:.45rem .85rem;border:1px solid #d1c8be;border-radius:999px;background:#fff;color:#18120e;font-size:.84rem;font-weight:700;text-decoration:none;white-space:nowrap}
    .topic-chip.is-current{border-color:#18120e;background:#18120e;color:#fff}
    .sub{color:#64748b;font-size:.875rem;margin-bottom:.75rem}
    .grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
    @media(min-width:500px){.grid{grid-template-columns:repeat(auto-fill,minmax(180px,1fr))}}
    @media(min-width:900px){.grid{grid-template-columns:repeat(4,1fr)}}
    .rc-card{display:flex;flex-direction:column;background:#fff;border:1px solid #e2dbd0;border-radius:.75rem;overflow:hidden}
    .rc-img{display:block;aspect-ratio:3/4;background:#ede9e1;overflow:hidden;padding:.35rem}
    .rc-img img{width:100%;height:100%;object-fit:contain;display:block}
    .rc-no-img{width:100%;height:100%}
    .rc-body{padding:.875rem 1rem;display:flex;flex-direction:column;gap:.4rem;flex:1}
    .liq-badge{align-self:flex-start;padding:.18rem .55rem;border-radius:999px;background:#fdeee8;color:#a94e3d;font-size:.68rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase}
    .rc-title{font-size:.95rem;font-weight:700;color:#18120e;line-height:1.25;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
    .rc-title-link{text-decoration:none;color:inherit}
    .rc-author{font-size:.82rem;color:#6b6157;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .rc-prices{display:flex;flex-direction:column;gap:.2rem;margin-top:.2rem}
    .rc-base{font-size:1.05rem;color:#18120e;font-weight:800}
    .rc-transfer{font-size:.78rem;color:#a94e3d;font-weight:600}
    .rc-free-shipping{font-size:.78rem;color:#267a42;font-weight:700}
    .rc-actions{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:auto;padding-top:.4rem}
    .rc-cta{display:inline-flex;align-items:center;min-height:40px;padding:.35rem .85rem;border:1px solid #e2dbd0;border-radius:2rem;font-size:.82rem;font-weight:700;color:#18120e;background:#f5f0ea;text-decoration:none}
    .rc-cta.rc-wa{color:#fff;border-color:#1a9e4b;background:#1a9e4b}
    .pager{display:flex;justify-content:space-between;align-items:center;gap:.75rem;margin:1.5rem 0 0;font-size:.9rem}
    .pager-link{display:inline-flex;min-height:44px;align-items:center;padding:.5rem .9rem;border:1px solid #d1c8be;border-radius:.6rem;background:#fff;color:#18120e;font-weight:700;text-decoration:none}
    .pager-link.is-disabled{opacity:.4}
    .empty{padding:2rem 0;color:#64748b}
    ${RUEDA_STYLES}
    ${ACERTIJO_STYLES}
    ${PREMIO_STYLES}
  </style>
</head>
<body>
${siteHeaderHtml({ current: 'liquidacion' })}
<main class="wrap">
  <section class="liq-hero">
    <p class="liq-eyebrow">En stock · Entrega inmediata</p>
    <h1>${heading}</h1>
    <p>${lead}</p>
    <a href="${escapeHtml(generalWa)}" target="_blank" rel="noopener noreferrer" data-cta-location="liquidacion_hero">Pedinos una recomendación por WhatsApp</a>
  </section>
  ${premioBannerHtml()}
  ${ruedaHtml()}
  ${acertijoHtml()}
  ${topicsHtml(topics, tema, selected.length)}
  <p class="sub">${filtered.length} libros${totalPages > 1 ? ` · página ${page} de ${totalPages}` : ''}</p>
  ${slice.length
        ? `<div class="grid">${slice.map((b, i) => cardHtml(b, i, ctx.env, firstCategory(categoryData, b.id) || tema)).join('\n')}</div>${pagerHtml(page, totalPages, tema)}`
        : '<p class="empty">Estamos preparando la próxima tanda de la liquidación. Mientras tanto, te esperan <a href="/catalogo">todos los libros del catálogo</a>.</p>'}
</main>
${footerHtml(new Date(now).getFullYear(), pagePath({ tema, page }))}
${waFloatHtml(null, pagePath({ tema, page }))}
${SITE_HEADER_SCRIPT}
${PREMIO_LIB_SCRIPT}
${RUEDA_SCRIPT}
${ACERTIJO_SCRIPT}
${PREMIO_LIQ_SCRIPT}
</body>
</html>`;

    return new Response(html, {
        headers: {
            'content-type': 'text/html;charset=UTF-8',
            // Vitrina vacía por falta de datos: no se cachea, para que vuelva sola.
            'cache-control': liquidation.sales === 'sin-datos'
                ? 'no-store'
                : promoAwareCacheControl(900, new Date(now), ctx.env),
            'x-liquidacion-total': String(selected.length),
            'x-liquidacion-fuente': liquidation.mode,
            'x-liquidacion-ventas': liquidation.sales,
            ...(liquidation.excluded ? { 'x-liquidacion-excluidos': Object.entries(liquidation.excluded).map(([k, v]) => `${k}=${v}`).join(';') } : {}),
        },
    });
}
