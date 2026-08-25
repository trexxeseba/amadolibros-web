/**
 * Landings SEO SSR para categorías y verticales autorizados.
 *
 * URLs autorizadas: /libros/:categoria y subverticales aprobados. La allowlist vive en
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
import {
    bookCoverUrl,
    CARD_IMAGE_SIZES,
    responsiveImage,
} from '../_shared/cloudflare-images.js';
import { buildWhatsAppMessage, whatsappHref } from '../../shared/whatsapp-messages.js';
// TAROT-HUB-MERCH-1: sólo se usa cuando category.id === 'esoterismo-tarot'.
// Ninguna otra categoría de SEO_CATEGORIES se ve afectada por este import.
import { TAROT_MERCH_TAGS } from '../_shared/tarot-merch-tags.js';
import { buildTagLookup, buildTarotHubModules } from '../_shared/tarot-hub-modules.js';
// TAROT-FINDER-1: mismo alcance — sólo esoterismo-tarot.
import { buildTarotFinderDataset } from '../_shared/tarot-finder-dataset.js';

const TAROT_CATEGORY_ID = 'esoterismo-tarot';
const BIBLE_CATEGORY_IDS = new Set(['biblias', 'biblias/reina-valera']);
const tarotTagLookup = buildTagLookup(TAROT_MERCH_TAGS);
// DEMAND-LEDGER-1 (PR #206) todavía no está mergeado a main: no hay
// functions/_shared/demand-ledger.js en esta rama. "Lo más buscado" queda
// implementado y probado (ver tarot-hub-modules.test.js) pero sin datos
// reales hasta que ese lote se integre — devolver null es honesto, no un
// placeholder. Reemplazar este no-op por un import real de
// opportunityForProductId() cuando #206 esté en main — esa fila trae
// impressions/clicks (lo que "Lo más buscado" realmente usa) además de
// opportunity_score, que buildTarotHubModules() ignora a propósito: mide
// oportunidad SEO/CTR, no volumen de búsqueda.
const tarotDemandLedgerLookup = () => null;

const MAX_RESULTS = 48;
const PAGE_PARAM_RE = /^[1-9][0-9]{0,6}$/;

function parsePageParam(raw) {
    if (raw === null || raw === undefined) return { present: false, valid: true, page: 1 };
    const trimmed = String(raw).trim();
    if (!PAGE_PARAM_RE.test(trimmed)) return { present: true, valid: false, page: 1 };
    return { present: true, valid: true, page: Number(trimmed) };
}

function categoryPath(categoryId, page = 1) {
    return page > 1 ? `/libros/${categoryId}?page=${page}` : `/libros/${categoryId}`;
}

function paginationWindow(page, totalPages) {
    const wanted = new Set([1, totalPages, page, page - 1, page + 1]);
    const sorted = [...wanted]
        .filter(p => Number.isInteger(p) && p >= 1 && p <= totalPages)
        .sort((a, b) => a - b);
    const cells = [];
    let previous = 0;
    for (const p of sorted) {
        if (previous && p - previous > 1) cells.push('gap');
        cells.push(p);
        previous = p;
    }
    return cells;
}

function paginationHtml({ categoryId, page, totalPages }) {
    if (totalPages <= 1) return '';
    const hrefFor = target => categoryPath(categoryId, target);
    const prev = page > 1
        ? `<a class="pg-ctl" rel="prev" href="${escapeHtml(hrefFor(page - 1))}">‹ Anterior</a>`
        : '<span class="pg-ctl is-off" aria-disabled="true">‹ Anterior</span>';
    const next = page < totalPages
        ? `<a class="pg-ctl" rel="next" href="${escapeHtml(hrefFor(page + 1))}">Siguiente ›</a>`
        : '<span class="pg-ctl is-off" aria-disabled="true">Siguiente ›</span>';
    const numbers = paginationWindow(page, totalPages).map(cell => {
        if (cell === 'gap') return '<span class="pg-gap" aria-hidden="true">…</span>';
        if (cell === page) return `<span class="pg-num is-current" aria-current="page">${cell}</span>`;
        return `<a class="pg-num" href="${escapeHtml(hrefFor(cell))}" aria-label="Ir a la página ${cell}">${cell}</a>`;
    }).join('');
    return `<nav class="pg" aria-label="Paginación de ${escapeHtml(categoryId)}">
  <div class="pg-row pg-main">${prev}<span class="pg-status">Página ${page} de ${totalPages}</span>${next}</div>
  <div class="pg-row pg-nums">${numbers}</div>
</nav>`;
}

const PAGINATION_STYLES = `.pg{margin:1.5rem 0 0;display:flex;flex-direction:column;gap:.5rem}.pg-row{display:flex;align-items:center;gap:.3rem}.pg-main{justify-content:space-between}.pg-nums{justify-content:center;flex-wrap:wrap}.pg-ctl,.pg-num,.pg-gap{min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;padding:0 .55rem;border-radius:.5rem;font-size:.85rem;text-decoration:none}.pg-ctl,.pg-num{border:1px solid #e2dbd0;background:#fff}.pg-ctl{font-weight:700;white-space:nowrap}.pg-ctl.is-off{color:#aaa;background:#f5f2ee}.pg-num.is-current{background:#18120e;color:#fff;border-color:#18120e;font-weight:800}.pg-gap{min-width:24px}.pg-status{flex:1;text-align:center;font-size:.8rem;color:#6b6157}`;

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
    return String(url || '')
        .replace('http://', 'https://')
        .replace(/-I\.(jpg|jpeg|png|webp)(?=($|\?))/i, '-O.$1');
}

function normalizeIdentity(value = '') {
    return String(value).toLowerCase().normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function dedupeCategoryResults(items) {
    const seen = new Set();
    return items.filter(item => {
        const digits = String(item.isbn || '').replace(/\D/g, '');
        const isbn = digits.length === 10 || digits.length === 13 ? digits : '';
        const condition = normalizeIdentity(item.condition || 'unknown');
        const title = normalizeIdentity(item.title);
        const author = normalizeIdentity(item.author);
        const key = isbn
            ? `isbn:${isbn}|${condition}`
            : title && author ? `title-author:${title}|${author}|${condition}` : '';
        if (!key) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export async function fetchCategoryData(ctx) {
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

function categoryBreadcrumbs(category, canonical) {
    const entries = [{ name: 'Inicio', item: `${BASE}/` }];
    if (category.parentId) {
        entries.push({
            name: category.parentName,
            item: `${BASE}/libros/${category.parentId}`,
        });
    } else {
        entries.push({ name: 'Libros', item: `${BASE}/catalogo` });
    }
    entries.push({ name: category.name, item: canonical });
    return entries;
}

function categoryBreadcrumbHtml(category) {
    const parent = category.parentId
        ? `<a href="/libros/${escapeHtml(category.parentId)}">${escapeHtml(category.parentName)}</a> › `
        : '<a href="/catalogo">Libros</a> › ';
    return `<nav class="breadcrumbs" aria-label="Migas de pan"><a href="/">Inicio</a> › ${parent}<span>${escapeHtml(category.name)}</span></nav>`;
}

function bibleCommercialPromiseHtml() {
    return `<aside class="bible-delivery" aria-label="Entrega y envío de Biblias">
    <h2>¿La necesitás hoy?</h2>
    <p>Algunas Biblias con stock pueden entregarse en 2 horas en Montevideo, según zona y horario. El envío es gratis en compras desde $1.500.</p>
    <p class="bible-delivery-note">Confirmamos disponibilidad, dirección y plazo antes de coordinar. No todas las ediciones califican para entrega rápida.</p>
  </aside>`;
}

function biblePathwaysHtml(category) {
    if (category.id === 'religion-espiritualidad') {
        return `<section class="bible-pathways" aria-labelledby="bible-pathways-title">
    <h2 id="bible-pathways-title">¿Buscás una Biblia?</h2>
    <p>Entrá a la colección completa o andá directo a las ediciones Reina-Valera. Son selecciones separadas de los demás libros de religión y espiritualidad.</p>
    <div class="bible-pathway-grid">
      <a href="/libros/biblias"><strong>Biblias en Uruguay</strong><span>Católicas, Reina-Valera, de estudio, letra grande, infantiles y para regalo.</span></a>
      <a href="/libros/biblias/reina-valera"><strong>Biblias Reina-Valera</strong><span>Revisiones y formatos identificados dentro del catálogo disponible.</span></a>
    </div>
  </section>`;
    }
    if (!BIBLE_CATEGORY_IDS.has(category.id)) return '';

    const isRvr = category.id === 'biblias/reina-valera';
    const heading = isRvr ? 'Cómo elegir una Biblia Reina-Valera' : 'Cómo elegir una Biblia';
    const intro = isRvr
        ? 'Antes de decidir, compará la revisión exacta, el tamaño de letra, las ayudas de estudio y el formato de esta edición.'
        : 'La mejor opción depende de la traducción, la legibilidad, el uso y el formato. Estos son los datos que conviene comprobar en cada ficha.';
    const firstTitle = isRvr ? 'Revisión exacta' : 'Traducción o tradición';
    const firstText = isRvr
        ? 'RVR 1960 y otras revisiones no son intercambiables. Confirmá la que necesitás en el título y los datos de edición.'
        : 'Reina-Valera, ediciones católicas y traducciones contemporáneas responden a preferencias y usos diferentes.';
    const crossLink = isRvr
        ? '<a class="bible-cross-link" href="/libros/biblias">Ver todas las Biblias disponibles</a>'
        : '<a class="bible-cross-link" href="/libros/biblias/reina-valera">Ver Biblias Reina-Valera</a>';

    return `<section class="bible-guide" aria-labelledby="bible-guide-title">
    <div class="bible-guide-head">
      <div><p class="bible-eyebrow">Guía de compra</p><h2 id="bible-guide-title">${escapeHtml(heading)}</h2><p>${escapeHtml(intro)}</p></div>
      ${crossLink}
    </div>
    <div class="bible-guide-grid">
      <article><h3>${escapeHtml(firstTitle)}</h3><p>${escapeHtml(firstText)}</p></article>
      <article><h3>Lectura cómoda</h3><p>“Letra grande” cambia según la editorial. Revisá tipografía, tamaño físico, peso y si la edición tiene dos columnas.</p></article>
      <article><h3>Estudio o lectura</h3><p>Notas, referencias, mapas, concordancia y espacio para escribir deben estar declarados por la edición; no los inferimos por la portada.</p></article>
      <article><h3>Formato y uso</h3><p>Tapa dura, flexible, cierre, índice y tamaño portátil cambian la experiencia. Para regalo, verificá también estuche y terminación.</p></article>
    </div>
  </section>
  ${bibleCommercialPromiseHtml()}`;
}

function classificationCount(categoryData, classificationId) {
    for (const root of categoryData.categories || []) {
        if (root.id === classificationId) return Number(root.count);
        const child = (root.subcategories || []).find(entry => entry.id === classificationId);
        if (child) return Number(child.count);
    }
    return 0;
}

// TAROT-HUB-MERCH-1: etiquetas cortas de merchandising para las tarjetas de
// los módulos "Clásicos" y "Lenormand y Kipper". Sólo texto/estilo — no
// afectan precio, stock, carrito ni checkout. deck_family/bundle/
// edition_style vienen ya resueltos por TAROT-MERCH-TAGS-1; nunca se infiere
// nada acá.
const TAROT_DECK_FAMILY_LABEL = {
    rider_waite_smith: 'Rider-Waite-Smith',
    marsella: 'Marsella',
    thoth: 'Thoth',
};
const TAROT_PRIMARY_TYPE_LABEL = {
    lenormand: 'Lenormand',
    kipper: 'Kipper',
};

function tarotBadgesFor(tag) {
    if (!tag) return [];
    const badges = [];
    if (TAROT_PRIMARY_TYPE_LABEL[tag.primary_type]) badges.push(TAROT_PRIMARY_TYPE_LABEL[tag.primary_type]);
    if (TAROT_DECK_FAMILY_LABEL[tag.deck_family]) badges.push(TAROT_DECK_FAMILY_LABEL[tag.deck_family]);
    if (tag.bundle === 'mazo_mas_guia') badges.push('+ Guía');
    if (tag.edition_style === 'ilustrada_especial') badges.push('Edición especial');
    return badges;
}

function cardHtml(item, index, navigationBase, { badges = [], forceLazy = false } = {}) {
    const href = `${navigationBase}/libro/${item.id}/${slugify(item.title)}`;
    const source = navigationBase === BASE
        ? bookCoverUrl(item.id)
        : httpsImg(item.pictures?.[0] || item.thumbnail || '');
    const image = responsiveImage(source, {
        widths: [240, 360, 480],
        defaultWidth: 360,
        sizes: CARD_IMAGE_SIZES,
    });
    const title = escapeHtml(item.title);
    const author = item.author ? `<p class="book-author">${escapeHtml(item.author)}</p>` : '';
    const price = Number(item.price) || 0;
    const priceText = price.toLocaleString('es-UY');
    const transferText = Math.round(price * 0.88).toLocaleString('es-UY');
    const installmentText = Math.round(price / 12).toLocaleString('es-UY');
    const responsiveAttrs = image.srcset
        ? ` srcset="${escapeHtml(image.srcset)}" sizes="${escapeHtml(image.sizes)}"`
        : '';
    // "fuera del primer viewport" (TAROT-HUB-MERCH-1): la grilla "Ver todo"
    // de esoterismo-tarot ya no es lo primero de la página cuando hay
    // módulos merchandising arriba — forceLazy la saca del criterio index<6.
    const eager = !forceLazy && index < 6;
    const imageHtml = image.src
        ? `<img src="${escapeHtml(image.src)}"${responsiveAttrs} alt="Portada de ${title}" loading="${eager ? 'eager' : 'lazy'}" decoding="async" width="280" height="420">`
        : '<span class="book-placeholder" aria-hidden="true">📚</span>';
    const badgesHtml = badges.length
        ? `<div class="tarot-badges">${badges.map(b => `<span class="tarot-badge">${escapeHtml(b)}</span>`).join('')}</div>`
        : '';

    return `<article class="book-card">
  <a class="book-image" href="${escapeHtml(href)}">${imageHtml}</a>
  <div class="book-body">
    <span class="stock-badge">Disponible</span>
    ${badgesHtml}
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

// TAROT-HUB-MERCH-1 ---------------------------------------------------------

const TAROT_MODULE_INTRO = {
    'para-empezar': '¿Es tu primer tarot? Estos mazos tienen guía o instructivo pensado para quien recién empieza.',
    oraculos: 'Mazos de oráculo disponibles ahora — un sistema distinto del tarot, con su propia lógica de lectura.',
    clasicos: 'Las barajas clásicas del tarot: Rider-Waite-Smith, Marsella y Thoth, cuando el mazo lo indica.',
    'lenormand-kipper': 'Lenormand y Kipper son sistemas de cartomancia propios, distintos entre sí y del tarot — se muestran juntos por temática, nunca mezclados en la clasificación.',
    'para-profundizar': 'Libros para estudiar tarot y oráculos en profundidad — teoría, historia e interpretación, no mazos.',
    novedades: 'Altas recientes en esta categoría.',
    'mas-buscado': 'Fichas con más demanda real de búsqueda en esta categoría.',
    'volvio-disponible': 'Títulos que volvieron a tener stock.',
};

function tarotModuleSectionHtml(module_, navigationBase, cardIndexRef) {
    if (module_.entries.length === 0) return '';
    const cards = module_.entries.map(({ item, tag }) => {
        const badges = module_.kind === 'grid-badged' ? tarotBadgesFor(tag) : [];
        const html = cardHtml(item, cardIndexRef.value, navigationBase, { badges });
        cardIndexRef.value += 1;
        return html;
    }).join('\n');
    const moreNote = module_.totalCount > module_.entries.length
        ? `<p class="tarot-module-more">Mostrando ${module_.entries.length} de ${module_.totalCount} — el resto está en “Ver todo” más abajo.</p>`
        : '';
    return `<section class="tarot-module" id="tarot-${escapeHtml(module_.id)}" aria-labelledby="tarot-${escapeHtml(module_.id)}-title">
    <h2 id="tarot-${escapeHtml(module_.id)}-title">${escapeHtml(module_.title)}</h2>
    <p class="tarot-module-intro">${escapeHtml(TAROT_MODULE_INTRO[module_.id] || '')}</p>
    <div class="tarot-module-grid">${cards}</div>
    ${moreNote}
  </section>`;
}

function tarotParaEmpezarHtml(module_, navigationBase, canonical, cardIndexRef, hasFinder) {
    // TAROT-FINDER-1: esta copia decía "muy pronto vamos a tener un
    // selector" — con el Finder ya en la misma página, esa promesa queda
    // obsoleta apenas se publique. La reemplazamos según haya o no dataset.
    const waMessage = buildWhatsAppMessage({
        greeting: 'Hola, estoy buscando mi primer tarot y quisiera que me ayudaran 😊',
        motive: 'Elegir un primer mazo de tarot',
        situation: 'Todavía no sé bien qué mazo conviene para empezar',
        page: canonical,
        closing: hasFinder
            ? 'Arriba tenés "Encontrá tu mazo" para filtrar por lo que buscás — si preferís, contanos directamente y te ayudamos por acá. Gracias.'
            : 'Contanos qué buscás y te ayudamos a elegir por acá. Gracias.',
    });
    const cards = module_.entries.map(({ item, tag }) => {
        const html = cardHtml(item, cardIndexRef.value, navigationBase, { badges: tarotBadgesFor(tag) });
        cardIndexRef.value += 1;
        return html;
    }).join('\n');
    return `<section class="tarot-module tarot-module-editorial" id="tarot-para-empezar" aria-labelledby="tarot-para-empezar-title">
    <h2 id="tarot-para-empezar-title">Para empezar</h2>
    <p class="tarot-module-intro">${escapeHtml(TAROT_MODULE_INTRO['para-empezar'])}</p>
    ${module_.hasProducts ? `<div class="tarot-module-grid">${cards}</div>` : ''}
    <a class="tarot-wa-cta" href="${escapeHtml(whatsappHref(waMessage))}" target="_blank" rel="noopener noreferrer">Contanos qué buscás por WhatsApp</a>
  </section>`;
}

function tarotModulesHtml(modules, navigationBase, canonical, hasFinder) {
    if (!modules || modules.length === 0) return '';
    const cardIndexRef = { value: 0 };
    const sections = modules.map(module_ => module_.id === 'para-empezar'
        ? tarotParaEmpezarHtml(module_, navigationBase, canonical, cardIndexRef, hasFinder)
        : tarotModuleSectionHtml(module_, navigationBase, cardIndexRef)).filter(Boolean);
    return `<div class="tarot-modules">${sections.join('\n')}</div>`;
}

// TAROT-FINDER-1 -------------------------------------------------------------

/**
 * CTA "Encontrá tu mazo" + dataset compacto inline (JSON embebido, sin
 * request nueva). Interacción inline la maneja astro-front/public/
 * tarot-finder.js (defer) — sin ese script, el <noscript> ofrece un CTA de
 * WhatsApp real, y el resto de la categoría (módulos, Ver todo) sigue
 * funcionando igual. Ningún dato del dataset queda indexado: va dentro de
 * un <script type="application/json">, invisible para el HTML renderizado
 * y sin URL propia.
 */
function tarotFinderHtml(dataset, canonical) {
    if (!dataset || dataset.length === 0) return '';
    const fallbackWaMessage = buildWhatsAppMessage({
        greeting: 'Hola, estoy buscando un mazo en Amado Libros 😊',
        motive: 'Elegir un mazo de tarot u oráculo',
        situation: 'Preferiría que me ayudaran a elegir por acá (sin JavaScript no pude usar el selector del sitio)',
        page: canonical,
        closing: 'Contame qué tipo de mazo buscás y te ayudo a elegir. Gracias.',
    });
    // data-wa-base: única fuente del número de WhatsApp para el script
    // cliente — nunca se hardcodea +59899841325 en tarot-finder.js. Mismo
    // helper (whatsappHref) que usa el resto del archivo, con texto vacío
    // para quedarse sólo con la base "https://wa.me/<numero>?text=".
    const waBase = whatsappHref('');
    // TAROT-FINDER-UX-2 (gate de performance): el pool "por encargo" ya NO
    // viaja embebido acá — se pide bajo demanda a
    // /api/tarot-finder-alternatives sólo cuando hace falta (ver ese
    // archivo). El HTML inicial vuelve a transportar únicamente el dataset
    // activo, igual que TAROT-FINDER-1.
    return `<section class="tarot-finder-cta" id="tarot-finder-cta" aria-labelledby="tarot-finder-cta-title" data-wa-base="${escapeHtml(waBase)}">
    <h2 id="tarot-finder-cta-title">Encontrá tu mazo</h2>
    <p>Contanos qué buscás y te mostramos opciones disponibles ahora mismo.</p>
    <button type="button" id="tarot-finder-start">Empezar</button>
    <noscript>
      <p class="tarot-finder-noscript">Este selector necesita JavaScript.
        <a href="${escapeHtml(whatsappHref(fallbackWaMessage))}" target="_blank" rel="noopener noreferrer">Contanos qué buscás por WhatsApp</a> y te ayudamos a elegir.</p>
    </noscript>
    <div id="tarot-finder-app" hidden></div>
  </section>
  <script type="application/json" id="tarot-finder-dataset">${safeJson(dataset)}</script>`;
}

const TAROT_FINDER_STYLES = `.tarot-finder-cta{background:#18120e;color:#fff;border-radius:1rem;padding:1.25rem clamp(1rem,3vw,1.75rem);margin-top:1.75rem}
.tarot-finder-cta h2{font-family:Georgia,serif;font-size:1.35rem;margin-bottom:.4rem}
.tarot-finder-cta p{color:rgba(255,255,255,.75);font-size:.88rem;max-width:60ch;margin-bottom:1rem}
.tarot-finder-cta .tarot-finder-noscript{color:rgba(255,255,255,.75);font-size:.85rem}
.tarot-finder-cta .tarot-finder-noscript a{color:#e49982;font-weight:700}
#tarot-finder-start{min-height:48px;padding:.75rem 1.5rem;border:0;border-radius:999px;background:#e49982;color:#18120e;font-weight:800;font-size:.92rem;cursor:pointer;transition:transform .2s ease,opacity .2s ease}
#tarot-finder-start:hover{background:#d98972}
#tarot-finder-start:active{transform:scale(.97)}
#tarot-finder-start:focus-visible{outline:3px solid #fff;outline-offset:2px}
#tarot-finder-app:not([hidden]){margin-top:1.25rem;background:#fff;color:#18120e;border-radius:.85rem;padding:1.1rem clamp(1rem,3vw,1.5rem);overflow:hidden}
/* Primera pantalla (apertura, TAROT-FINDER-UX-2): editorial, fondo oscuro
   igual al resto del universo Tarot — se "escapa" del padding claro del
   contenedor con márgenes negativos y reaplica su propio padding. */
.tf-opening{margin:-1.1rem calc(-1 * clamp(1rem,3vw,1.5rem));padding:1.6rem clamp(1.15rem,4vw,2.1rem);background:#18120e;color:#fff;border-radius:.85rem}
.tf-opening h3{font-family:Georgia,serif;font-size:clamp(1.3rem,4vw,1.7rem);line-height:1.2;margin-bottom:.6rem}
.tf-opening-sub{color:rgba(255,255,255,.75);font-size:.86rem;max-width:60ch;margin-bottom:1.3rem}
.tf-opening-grid{display:grid;grid-template-columns:1fr;gap:.6rem}
.tf-opening-card{min-height:56px;text-align:left;padding:.9rem 1.1rem;border:1.5px solid rgba(255,255,255,.16);border-radius:.75rem;background:rgba(255,255,255,.05);color:#fff;font:inherit;font-size:.92rem;font-weight:600;cursor:pointer;
  opacity:0;transform:translateY(6px);animation:tf-card-in .3s ease forwards;animation-delay:calc(var(--tf-i,0) * 55ms);
  transition:transform .2s ease,opacity .2s ease,border-color .2s ease,background .2s ease}
.tf-opening-card:hover{border-color:#e49982;background:rgba(228,153,130,.12)}
.tf-opening-card:active{transform:scale(.98)}
.tf-opening-card:focus-visible{outline:3px solid #e49982;outline-offset:2px}
.tf-opening .tf-nav{margin-top:1.4rem}
.tf-opening .tf-nav button{background:transparent;border-color:rgba(255,255,255,.25);color:rgba(255,255,255,.8)}
.tf-opening .tf-nav button:hover{border-color:#e49982;color:#fff}
.tf-progress{font-size:.76rem;color:#6b6157;margin-bottom:.6rem}
.tf-question h3{font-size:1.05rem;margin-bottom:.9rem;line-height:1.35}
.tf-options{display:flex;flex-direction:column;gap:.55rem}
.tf-option{min-height:48px;text-align:left;padding:.7rem 1rem;border:1.5px solid #e2dbd0;border-radius:.65rem;background:#fff;font:inherit;font-size:.88rem;cursor:pointer;color:#18120e;transition:transform .2s ease,border-color .2s ease}
.tf-option:hover{border-color:#e49982}
.tf-option:active{transform:scale(.98)}
.tf-option:focus-visible{outline:3px solid #a94e3d;outline-offset:1px}
.tf-option[aria-pressed="true"]{border-color:#18120e;background:#f8f5ef;font-weight:700;transform:scale(1.01)}
.tf-nav{display:flex;justify-content:space-between;gap:.6rem;margin-top:1.1rem}
.tf-nav button{min-height:44px;padding:0 1rem;border-radius:.6rem;border:1px solid #e2dbd0;background:#fff;font:inherit;font-size:.82rem;cursor:pointer;transition:opacity .2s ease}
.tf-nav button:disabled{opacity:.4;cursor:default}
.tf-nav .tf-restart{margin-left:auto;color:#8a8074}
.tf-explainer{background:#f8f5ef;border-radius:.6rem;padding:.8rem;margin-bottom:.9rem;font-size:.82rem;color:#50463e;display:flex;flex-direction:column;gap:.35rem}
.tf-results h3{font-size:1.05rem;margin-bottom:.85rem}
.tf-refine-cta{display:block;margin:0 0 .3rem;min-height:44px;padding:0 1.1rem;border:1px dashed #c9beae;border-radius:.6rem;background:transparent;color:#6b4b2f;font:inherit;font-size:.82rem;font-weight:700;cursor:pointer}
.tf-refine-cta:hover{border-color:#e49982;color:#a94e3d}
.tf-results-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.7rem;margin-bottom:1rem}
/* Entrada en cascada: cada tarjeta de resultado aparece con un pequeño
   retraso proporcional a su posición (--tf-i, inyectado inline). */
.tf-result-slot{opacity:0;transform:translateY(8px);animation:tf-card-in .3s ease forwards;animation-delay:calc(var(--tf-i,0) * 60ms)}
.tf-result-card{border:1px solid #e2dbd0;border-radius:.7rem;overflow:hidden;display:flex;flex-direction:column;height:100%}
.tf-result-card img{width:100%;aspect-ratio:3/4;object-fit:contain;background:#f8f5ef}
.tf-result-body{padding:.6rem;display:flex;flex-direction:column;gap:.35rem}
.tf-result-badges{display:flex;flex-wrap:wrap;gap:.25rem}
.tf-result-badges span{padding:.1rem .4rem;border-radius:999px;background:#f0e6da;color:#6b4b2f;font-size:.6rem;font-weight:800;text-transform:uppercase}
.tf-result-card h4{font-size:.82rem;line-height:1.3}
.tf-result-why{font-size:.72rem;color:#6b6157}
.tf-near-miss-reason{font-size:.72rem;color:#a94e3d;font-weight:600}
.tf-result-price{font-weight:800;font-size:.88rem}
.tf-result-encargo{font-weight:700;font-size:.78rem;color:#a94e3d}
.tf-result-card-paused{border-color:#efd2a6}
.tf-result-cta{margin-top:auto;text-align:center;padding:.5rem;border-radius:.5rem;background:#18120e;color:#fff;text-decoration:none;font-size:.78rem;font-weight:700}
.tf-empty{background:#fff7e8;border:1px solid #efd2a6;border-radius:.65rem;padding:1rem;color:#6b4218}
.tf-empty .tf-wa-cta{display:inline-flex;margin-top:.75rem;padding:.65rem 1rem;border-radius:999px;background:#25d366;color:#fff;text-decoration:none;font-weight:800;font-size:.82rem}
.tf-near-miss-sub{font-size:.85rem;color:#6b6157;margin-bottom:.9rem}
.tf-loading{font-size:.85rem;color:#6b6157}
.tf-near-miss-choice{display:flex;flex-wrap:wrap;gap:.6rem;align-items:center}
.tf-reveal-alternatives{min-height:48px;padding:0 1.2rem;border:0;border-radius:999px;background:#18120e;color:#fff;font:inherit;font-size:.86rem;font-weight:800;cursor:pointer}
.tf-reveal-alternatives:hover{background:#2b211a}
.tf-wa-cta{display:inline-flex;padding:.65rem 1rem;border-radius:999px;background:#25d366;color:#fff;text-decoration:none;font-weight:800;font-size:.82rem}
.tf-wa-cta-secondary{margin-top:.9rem}
@media(min-width:640px){.tf-opening-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.tf-results-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(min-width:900px){.tf-results-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
@keyframes tf-card-in{to{opacity:1;transform:translateY(0)}}
@media(prefers-reduced-motion:reduce){.tf-opening-card,.tf-result-slot{animation:none;opacity:1;transform:none}#tarot-finder-start,.tf-option,.tf-opening-card,.tf-nav button{transition:none}#tarot-finder-start:active,.tf-option:active,.tf-opening-card:active{transform:none}.tf-option[aria-pressed="true"]{transform:none}}`;

// ---------------------------------------------------------------------------

const TAROT_MODULE_STYLES = `.tarot-modules{display:flex;flex-direction:column;gap:1.75rem;margin-top:1.75rem}
.tarot-module{background:#fff;border:1px solid #e2dbd0;border-radius:1rem;padding:1.1rem clamp(1rem,3vw,1.5rem)}
.tarot-module h2{font-family:Georgia,serif;font-size:1.25rem;margin-bottom:.35rem}
.tarot-module-intro{color:#6b6157;font-size:.85rem;max-width:70ch;margin-bottom:.9rem}
.tarot-module-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.7rem}
.tarot-module-more{margin-top:.75rem;font-size:.78rem;color:#8a8074}
.tarot-badges{display:flex;flex-wrap:wrap;gap:.3rem}
.tarot-badge{padding:.14rem .5rem;border-radius:999px;background:#f0e6da;color:#6b4b2f;font-size:.62rem;font-weight:800;text-transform:uppercase;letter-spacing:.02em}
.tarot-module-editorial .tarot-wa-cta{display:inline-flex;margin-top:.9rem;padding:.65rem 1rem;border-radius:999px;background:#25d366;color:#fff;text-decoration:none;font-weight:800;font-size:.82rem}
@media(min-width:640px){.tarot-module-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(min-width:900px){.tarot-module-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}`;

// ---------------------------------------------------------------------------

// TAROT-SEARCH-GROWTH-1: guía editorial de compra, dirigida por datos de la
// propia categoría (category.buyerGuide). Sin buyerGuide no renderiza nada,
// así que ninguna categoría que no lo declare cambia.
export function editorialGuideHtml(category) {
    const guide = category?.buyerGuide;
    if (!guide || !Array.isArray(guide.points) || guide.points.length === 0) return '';

    const sectionId = `buyer-guide-${String(category.id || 'category').replace(/[^a-z0-9_-]/gi, '')}`;
    const points = guide.points.map(point => `<article class="buyer-guide-card">
      <h3>${escapeHtml(point.title)}</h3>
      <p>${escapeHtml(point.text)}</p>
    </article>`).join('\n');

    return `<section class="buyer-guide" aria-labelledby="${escapeHtml(sectionId)}-title">
    <div class="buyer-guide-head">
      <h2 id="${escapeHtml(sectionId)}-title">${escapeHtml(guide.title)}</h2>
      <p>${escapeHtml(guide.intro)}</p>
    </div>
    <div class="buyer-guide-grid">${points}</div>
    ${guide.serviceNote ? `<p class="buyer-guide-service"><strong>Servicio de Amado Libros:</strong> ${escapeHtml(guide.serviceNote)}</p>` : ''}
  </section>`;
}

function renderPage({ category, categoryUniverseCount, items, isPreview, hasUnexpectedParameters, navigationBase, page, pageSize, totalPages, tarotModules, tarotFinderDataset }) {
    const canonical = `${BASE}${categoryPath(category.id, page)}`;
    const offset = (page - 1) * pageSize;
    const visibleItems = items.slice(offset, offset + pageSize);
    const itemList = visibleItems.slice(0, 20).map((item, index) => ({
        '@type': 'ListItem',
        'position': offset + index + 1,
        'url': `${BASE}/libro/${item.id}/${slugify(item.title)}`,
        'name': item.title,
    }));
    const collectionSchema = {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        'name': category.h1,
        'url': canonical,
        'description': category.description,
        'isPartOf': category.parentId
            ? { '@type': 'CollectionPage', 'name': category.parentName, 'url': `${BASE}/libros/${category.parentId}` }
            : { '@type': 'WebSite', 'name': BRAND.name, 'url': BASE },
        'publisher': { '@type': 'OnlineStore', '@id': `${BASE}/#bookstore`, 'name': BRAND.name, 'url': `${BASE}/` },
        'mainEntity': {
            '@type': 'ItemList',
            'numberOfItems': items.length,
            'itemListElement': itemList,
        },
    };
    if (category.kind === 'bibles') {
        collectionSchema.about = [
            { '@type': 'Thing', 'name': 'Biblia' },
            { '@type': 'Thing', 'name': 'Reina-Valera' },
            { '@type': 'Thing', 'name': 'Biblia de estudio' },
        ];
    } else if (category.kind === 'reina-valera') {
        collectionSchema.about = [
            { '@type': 'Thing', 'name': 'Reina-Valera' },
            { '@type': 'Thing', 'name': 'Biblia en español' },
        ];
    } else if (Array.isArray(category.about) && category.about.length > 0) {
        // TAROT-SEARCH-GROWTH-1: entidades declaradas por la propia categoría.
        // Va como última rama a propósito: las landings de Biblias (#243)
        // resuelven su `about` por `kind` y no deben verse afectadas.
        collectionSchema.about = category.about.map(name => ({
            '@type': 'Thing',
            'name': name,
        }));
    }
    const breadcrumbSchema = {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        'itemListElement': categoryBreadcrumbs(category, canonical).map((entry, index) => ({
            '@type': 'ListItem',
            'position': index + 1,
            'name': entry.name,
            'item': entry.item,
        })),
    };
    const rangeFrom = items.length === 0 ? 0 : offset + 1;
    const rangeTo = offset + visibleItems.length;
    const resultText = items.length === 0
        ? 'Sin títulos disponibles'
        : totalPages > 1
            ? `Mostrando ${rangeFrom}–${rangeTo} de ${items.length} libros disponibles`
            : `${items.length} libro${items.length === 1 ? '' : 's'} disponible${items.length === 1 ? '' : 's'}`;
    // TAROT-HUB-MERCH-1: cuando hay módulos merchandising arriba, esta
    // grilla ya no es lo primero de la página — forceLazy evita eager-load
    // de imágenes fuera del primer viewport.
    const cards = visibleItems
        .map((item, index) => cardHtml(item, index, navigationBase, { forceLazy: Boolean(tarotModules?.length) }))
        .join('\n');
    const robots = isPreview || hasUnexpectedParameters || items.length === 0
        ? 'noindex, follow'
        : 'index, follow';
    const pageTitle = page > 1 ? `${category.title} — Página ${page}` : category.title;
    const pageDescription = page > 1 ? `${category.description} Página ${page} de ${totalPages}.` : category.description;
    const pagination = paginationHtml({ categoryId: category.id, page, totalPages });
    // TAROT-HUB-MERCH-1: copy inequívoco para esoterismo-tarot — "314 título(s)
    // informados en la portada" se podía leer como stock inmediato, que no es
    // lo que dice. El número visible es siempre el de items.length (dinámico,
    // nunca hardcodeado); el universo por-encargo mayor se nombra sin cifra
    // propia, sólo cuando existe realmente. El resto de las categorías
    // conserva el texto original, sin cambios.
    const scopeText = category.id === TAROT_CATEGORY_ID
        ? (Number.isFinite(categoryUniverseCount) && categoryUniverseCount > items.length
            ? `<strong>${items.length} disponible${items.length === 1 ? '' : 's'} ahora</strong> · más títulos disponibles por encargo`
            : `<strong>${items.length} disponible${items.length === 1 ? '' : 's'} ahora</strong>`)
        : (Number.isFinite(categoryUniverseCount) && categoryUniverseCount > items.length
            ? `<strong>${items.length} título${items.length === 1 ? '' : 's'} disponible${items.length === 1 ? '' : 's'} ahora.</strong> Los ${categoryUniverseCount} títulos informados en la portada incluyen disponibles y libros que podemos buscar por encargo.`
            : `<strong>${items.length} título${items.length === 1 ? '' : 's'} disponible${items.length === 1 ? '' : 's'} ahora.</strong> También buscamos ediciones agotadas o difíciles de conseguir por encargo.`);
    const waMessage = buildWhatsAppMessage({
        greeting: 'Hola, estoy buscando un libro en Amado Libros y quisiera que me ayudaran 😊',
        motive: 'Consultar por un libro de esta categoría',
        book: `Libro de ${category.name}`,
        situation: 'Todavía no identifiqué el título exacto',
        page: canonical,
        closing: 'Quisiera contarles qué libro necesito y saber si pueden conseguirlo. Gracias.',
    });

    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(pageDescription)}">
  <meta name="robots" content="${robots}">
  <link rel="canonical" href="${canonical}">
  ${faviconHeadHtml()}
  <meta property="og:type" content="website">
  <meta property="og:locale" content="es_UY">
  <meta property="og:url" content="${canonical}">
  <meta property="og:title" content="${escapeHtml(pageTitle)}">
  <meta property="og:description" content="${escapeHtml(pageDescription)}">
  <meta property="og:image" content="${BASE}${BRAND.logo}">
  <script type="application/ld+json">${safeJson(collectionSchema)}</script>
  <script type="application/ld+json">${safeJson(breadcrumbSchema)}</script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}body{font-family:Inter,system-ui,-apple-system,sans-serif;background:#f8f5ef;color:#18120e;line-height:1.55}a{color:inherit}.category-header{position:sticky;top:0;z-index:40;background:rgba(18,14,11,.97);color:#fff;border-bottom:1px solid rgba(255,255,255,.08)}.header-inner{max-width:1200px;height:72px;margin:auto;padding:0 1rem;display:grid;grid-template-columns:auto minmax(220px,1fr) auto;align-items:center;gap:1rem}.brand-link{display:flex;align-items:center;gap:.55rem;text-decoration:none}.brand-link img{width:44px;height:44px}.brand-link span{display:flex;flex-direction:column}.brand-link strong{font-size:.92rem}.brand-link small{color:rgba(255,255,255,.55);font-size:.7rem}.header-search{height:42px;display:flex;max-width:620px;width:100%;justify-self:center}.header-search input{min-width:0;flex:1;border:0;border-radius:999px 0 0 999px;padding:0 1rem;font:inherit}.header-search button{border:0;border-radius:0 999px 999px 0;padding:0 1rem;background:#e49982;color:#18120e;font-weight:800;cursor:pointer}.cart-link{min-height:42px;display:inline-flex;align-items:center;padding:0 .9rem;border:1px solid rgba(255,255,255,.2);border-radius:999px;text-decoration:none;font-size:.82rem}.breadcrumbs{max-width:1120px;margin:0 auto;padding:1rem;font-size:.82rem;color:#6b6157}.breadcrumbs a{color:#8f493b}.category-main{max-width:1120px;margin:0 auto;padding:0 1rem 3rem}.intro{padding:clamp(1.25rem,3vw,2rem);background:#fff;border:1px solid #e2dbd0;border-radius:1rem}.intro h1{font-family:Georgia,serif;font-size:clamp(1.75rem,5vw,2.6rem);line-height:1.12;margin-bottom:.8rem}.intro p{max-width:78ch;color:#5f554c}.category-scope{margin-top:1rem;padding:.75rem .9rem;border-left:4px solid #e49982;background:#f8f5ef;border-radius:.35rem;color:#50463e;font-size:.88rem}.benefits{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1rem}.benefits span{padding:.35rem .65rem;border-radius:999px;background:#f5f0ea;color:#50463e;font-size:.75rem;font-weight:700}.bible-pathways,.bible-guide,.bible-delivery{margin-top:1.25rem;border:1px solid #e2dbd0;border-radius:1rem;background:#fff;padding:clamp(1rem,3vw,1.5rem)}.bible-pathways h2,.bible-guide h2,.bible-delivery h2{font-family:Georgia,serif;font-size:1.35rem}.bible-pathways>p,.bible-guide-head p,.bible-delivery p{max-width:75ch;margin-top:.4rem;color:#5f554c}.bible-pathway-grid,.bible-guide-grid{display:grid;gap:.75rem;margin-top:1rem}.bible-pathway-grid a,.bible-guide-grid article{display:flex;flex-direction:column;gap:.25rem;border:1px solid #e2dbd0;border-radius:.75rem;background:#f8f5ef;padding:1rem;text-decoration:none}.bible-pathway-grid a:hover{border-color:#e49982}.bible-pathway-grid span,.bible-guide-grid p{color:#6b6157;font-size:.84rem}.bible-guide-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}.bible-eyebrow{color:#a94e3d!important;font-size:.72rem;font-weight:850;letter-spacing:.07em;text-transform:uppercase}.bible-cross-link{flex:none;display:inline-flex;min-height:44px;align-items:center;border-radius:999px;background:#18120e;color:#fff;padding:.6rem .9rem;text-decoration:none;font-size:.8rem;font-weight:800}.bible-delivery{background:#18120e;color:#fff;border-color:#18120e}.bible-delivery p{color:rgba(255,255,255,.78)}.bible-delivery .bible-delivery-note{font-size:.78rem;color:rgba(255,255,255,.6)}.buyer-guide{margin:1.5rem 0;padding:clamp(1rem,2.5vw,1.5rem);background:#fff;border:1px solid #e2dbd0;border-radius:1rem}.buyer-guide-head{max-width:78ch}.buyer-guide-head h2{font-family:Georgia,serif;font-size:clamp(1.3rem,3vw,1.75rem);line-height:1.2;margin-bottom:.45rem}.buyer-guide-head p{color:#5f554c}.buyer-guide-grid{display:grid;grid-template-columns:1fr;gap:.7rem;margin-top:1rem}.buyer-guide-card{padding:.85rem;background:#f8f5ef;border:1px solid #eee5da;border-radius:.65rem}.buyer-guide-card h3{font-size:.92rem;margin-bottom:.25rem}.buyer-guide-card p{font-size:.82rem;color:#5f554c}.buyer-guide-service{margin-top:1rem;padding:.75rem .85rem;border-left:4px solid #e49982;background:#fff8f4;color:#50463e;font-size:.84rem}.results-head{display:flex;align-items:end;justify-content:space-between;gap:1rem;margin:2rem 0 1rem}.results-head h2{font-size:1.15rem}.results-head p{color:#6b6157;font-size:.84rem}.books-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.8rem}.book-card{display:flex;flex-direction:column;min-width:0;background:#fff;border:1px solid #e2dbd0;border-radius:.8rem;overflow:hidden}.book-image{display:grid;place-items:center;aspect-ratio:3/4;background:#eee7de;overflow:hidden}.book-image img{width:100%;height:100%;object-fit:cover;transition:transform .2s}.book-card:hover .book-image img{transform:scale(1.025)}.book-placeholder{font-size:2.5rem}.book-body{display:flex;flex:1;flex-direction:column;align-items:flex-start;gap:.4rem;padding:.8rem}.stock-badge{padding:.16rem .48rem;border-radius:999px;background:#eaf7ee;color:#267a42;font-size:.64rem;font-weight:800;text-transform:uppercase}.book-body h2{font-size:.86rem;line-height:1.3}.book-body h2 a{text-decoration:none}.book-author{width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#6b6157;font-size:.75rem}.book-prices{display:flex;flex-direction:column;gap:.15rem;margin-top:.2rem;font-size:.72rem}.book-prices strong{font-size:.9rem}.book-prices .transfer{color:#a94e3d;font-weight:700}.book-cta{margin-top:auto;padding:.38rem .7rem;border-radius:999px;background:#18120e;color:#fff;text-decoration:none;font-size:.73rem;font-weight:700}.category-nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.55rem;margin-top:2.5rem;padding:1rem;background:#fff;border:1px solid #e2dbd0;border-radius:1rem}.category-nav a{padding:.55rem .7rem;border-radius:.55rem;background:#f8f5ef;text-decoration:none;font-size:.78rem}.category-nav a[aria-current="page"]{background:#18120e;color:#fff}.empty{margin-top:1.5rem;padding:1.5rem;background:#fff;border:1px solid #e2dbd0;border-radius:.8rem}${PAGINATION_STYLES}${FOOTER_STYLES}${WA_FLOAT_STYLES}${TAROT_MODULE_STYLES}${TAROT_FINDER_STYLES}@media(min-width:640px){.books-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.category-nav{grid-template-columns:repeat(4,minmax(0,1fr))}.buyer-guide-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.bible-pathway-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.bible-guide-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(min-width:900px){.books-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.bible-guide-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}@media(max-width:620px){.header-inner{height:auto;min-height:68px;grid-template-columns:1fr auto;padding:.55rem .8rem}.brand-link small,.cart-link{display:none}.header-search{grid-column:1/-1;grid-row:2;margin-bottom:.2rem}.category-header{position:relative}.bible-guide-head{flex-direction:column}.bible-cross-link{width:100%;justify-content:center}}
    .book-image{padding:.35rem}.book-image img{object-fit:contain}
  </style>
</head>
<body>
${headerHtml()}
${categoryBreadcrumbHtml(category)}
<main class="category-main">
  <section class="intro">
    <h1>${escapeHtml(category.h1)}</h1>
    <p>${escapeHtml(category.intro)}</p>
    <p class="category-scope">${scopeText}</p>
    <div class="benefits"><span>12% menos por transferencia</span><span>Hasta 12 cuotas</span><span>Envíos a todo Uruguay</span><span>Encargos del exterior</span></div>
  </section>
  ${biblePathwaysHtml(category)}
  ${tarotFinderHtml(tarotFinderDataset, canonical)}
  ${editorialGuideHtml(category)}
  ${tarotModulesHtml(tarotModules, navigationBase, canonical, Boolean(tarotFinderDataset?.length))}
  <div class="results-head"><h2>${tarotModules?.length ? 'Ver todo' : 'Libros disponibles'}</h2><p>${resultText}</p></div>
  ${items.length > 0 ? `<section class="books-grid" aria-label="${escapeHtml(category.h1)}">${cards}</section>${pagination}` : '<p class="empty">No hay títulos disponibles en esta categoría en este momento. Consultanos por WhatsApp y lo buscamos por encargo.</p>'}
  ${categoryNavHtml(category.id)}
</main>
${footerHtml(undefined, canonical)}
${waFloatHtml(waMessage, canonical)}
<script src="/search-autocomplete.js" defer></script>
${tarotFinderDataset?.length ? '<script src="/tarot-finder.js" defer></script>' : ''}
</body>
</html>`;
}

export async function onRequest(ctx) {
    const pathParts = Array.isArray(ctx.params.path)
        ? ctx.params.path
        : [ctx.params.path].filter(Boolean);
    if (pathParts.length < 1 || pathParts.length > 2) {
        return errorPage(404, 'Categoría no encontrada', 'La categoría que buscás no existe.');
    }

    const category = findSeoCategory(pathParts.map(part => String(part).toLowerCase()).join('/'));
    if (!category) {
        return errorPage(404, 'Categoría no encontrada', 'La categoría que buscás no existe.');
    }

    const requestUrl = new URL(ctx.request.url);
    const pageParam = parsePageParam(requestUrl.searchParams.get('page'));
    if (pageParam.present && (!pageParam.valid || pageParam.page === 1)) {
        const clean = new URL(requestUrl);
        clean.searchParams.delete('page');
        return new Response(null, {
            status: 301,
            headers: { Location: `${clean.pathname}${clean.search}` },
        });
    }
    const hasUnexpectedParameters = [...requestUrl.searchParams.keys()].some(key => key !== 'page')
        || requestUrl.searchParams.getAll('page').length > 1;

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

    const classificationIds = category.classificationIds || [category.classificationId || category.id];
    const excludedClassificationIds = category.excludedClassificationIds || [];
    const categoryItems = activeItems
        .filter(item => {
            const tags = categoryData.items[item.id] || [];
            return classificationIds.some(id => tags.includes(id))
                && !excludedClassificationIds.some(id => tags.includes(id));
        })
        .sort((a, b) => {
            const stock = Number(b.available_quantity || 0) - Number(a.available_quantity || 0);
            if (stock) return stock;
            const price = Number(a.price || Infinity) - Number(b.price || Infinity);
            return price || String(a.id).localeCompare(String(b.id));
        });
    const items = dedupeCategoryResults(categoryItems);
    const categoryUniverseCount = classificationIds.reduce((total, id) => total + classificationCount(categoryData, id), 0)
        - excludedClassificationIds.reduce((total, id) => total + classificationCount(categoryData, id), 0);
    const pageSize = BIBLE_CATEGORY_IDS.has(category.id) ? 24 : MAX_RESULTS;
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    if (pageParam.page > totalPages) {
        return errorPage(404, 'Página no encontrada', 'La página de esta categoría que buscás no existe.');
    }
    const isPreview = ctx.env?.APP_ENV === 'preview';
    const navigationBase = isPreview ? requestUrl.origin : BASE;
    // TAROT-HUB-MERCH-1: módulos merchandising sólo en la vista limpia
    // (página 1, sin parámetros inesperados) de esoterismo-tarot, y sólo si
    // hay algo que mostrar. Reutiliza `items` — ya calculado arriba, cero
    // fetch adicional. Ninguna otra categoría pasa por este branch.
    const tarotModules = category.id === TAROT_CATEGORY_ID && pageParam.page === 1 && !hasUnexpectedParameters && items.length > 0
        ? buildTarotHubModules({ items, tagLookup: tarotTagLookup, demandLedgerLookup: tarotDemandLedgerLookup })
        : null;
    // TAROT-FINDER-1: mismo gate que tarotModules, mismo `items` — el
    // dataset del Finder y la grilla "Ver todo" describen exactamente el
    // mismo universo, nunca datos separados que puedan desalinearse.
    const tarotFinderDataset = tarotModules
        ? buildTarotFinderDataset({
            items,
            tagLookup: tarotTagLookup,
            imageForId: id => bookCoverUrl(id),
            hrefForItem: it => `${navigationBase}/libro/${it.id}/${slugify(it.title)}`,
        })
        : [];
    // TAROT-FINDER-UX-2 (fix post-Preview, gate de performance): el pool
    // "por encargo" YA NO viaja embebido acá — medido, 409 candidatos
    // agregaban ~186KB JSON crudo (+70% del HTML comprimido) a CADA visita
    // normal del hub, para una función que la mayoría no usa. Ahora se
    // carga bajo demanda desde functions/api/tarot-finder-alternatives.js,
    // sólo cuando la persona refina, obtiene 0 exactos y toca "Ver estas
    // alternativas". Cero fetchPausedIndex() en la visita normal.
    const html = renderPage({
        category,
        categoryUniverseCount,
        items,
        isPreview,
        hasUnexpectedParameters,
        navigationBase,
        page: pageParam.page,
        pageSize,
        totalPages,
        tarotModules,
        tarotFinderDataset,
    });

    return new Response(html, {
        headers: {
            'content-type': 'text/html;charset=UTF-8',
            'cache-control': 'public, max-age=3600',
        },
    });
}
