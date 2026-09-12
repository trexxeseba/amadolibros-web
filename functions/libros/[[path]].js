/**
 * Landings SEO SSR para categorías y verticales autorizados.
 *
 * URLs autorizadas: /libros/:categoria y subverticales aprobados. La allowlist vive en
 * _shared/seo-categories.js; cualquier otra ruta responde 404 real.
 */
import { slugify } from '../_shared/slug.js';
import { BASE, fetchActiveIndex, fetchPausedIndex, fetchCatalog } from '../_shared/catalog.js';
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
import { VERIFIED_TAROT_MERCH_CORRECTIONS } from '../_shared/tarot-merch-corrections.js';
import { TAROT_MERCH_TAGS } from '../_shared/tarot-merch-tags.js';
import { buildTagLookup } from '../_shared/tarot-hub-modules.js';
import { hasClassificationId } from '../_shared/category-paths.js';
import { deliveryBadgeHtml, DELIVERY_BADGE_STYLES } from '../../shared/delivery-badge.js';
import { CARD_COVER_FRAMING_STYLES, cardCoverImageOptions } from '../../shared/card-cover-framing.js';
import { parseCategoryOrder, orderCategoryItems, categoryOrderHtml, CATEGORY_ORDER_STYLES, categoryProductTabsHtml, CATEGORY_PRODUCT_STYLES } from '../_shared/category-order.js';
import { fetchCategoryDates } from '../_shared/category-dates.js';

const TAROT_CATEGORY_ID = 'esoterismo-tarot';
const TAROT_DECKS_CATEGORY_ID = 'esoterismo-tarot/mazos';
const BIBLE_CATEGORY_IDS = new Set(['biblias', 'biblias/reina-valera']);
const PRIORITY_LOCAL_INTENT_IDS = new Set(['biblias/reina-valera', TAROT_DECKS_CATEGORY_ID]);
const baseTarotTagLookup = buildTagLookup(TAROT_MERCH_TAGS);
const reviewedFormats = new Map(VERIFIED_TAROT_MERCH_CORRECTIONS.map(row => [row.id, row]));
const reviewedIsbns = new Map(VERIFIED_TAROT_MERCH_CORRECTIONS.filter(row => row.isbn).map(row => [row.isbn, row]));
const tarotTagLookup = item => reviewedFormats.get(item.id) || reviewedIsbns.get(item.isbn) || baseTarotTagLookup(item.id);
const isSimpleCategory = category => category.id === TAROT_CATEGORY_ID || category.id === TAROT_DECKS_CATEGORY_ID || category.tarotFilter === 'study-books' || category.id === 'esoterismo-tarot/libros-esoterismo';

const MAX_RESULTS = 48;
const PAGE_PARAM_RE = /^[1-9][0-9]{0,6}$/;

function parsePageParam(raw) {
    if (raw === null || raw === undefined) return { present: false, valid: true, page: 1 };
    const trimmed = String(raw).trim();
    if (!PAGE_PARAM_RE.test(trimmed)) return { present: true, valid: false, page: 1 };
    return { present: true, valid: true, page: Number(trimmed) };
}

function categoryPath(categoryId, page = 1, order = '') {
    const query = new URLSearchParams();
    if (page > 1) query.set('page', String(page));
    if (order) query.set('orden', order);
    return `/libros/${categoryId}${query.size ? '?' + query : ''}`;
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

function paginationHtml({ categoryId, page, totalPages, order }) {
    if (totalPages <= 1) return '';
    const hrefFor = target => categoryPath(categoryId, target, order);
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
    <p>Las Biblias con stock pueden coordinarse para entrega en el día en Montevideo, según zona, horario y confirmación. El envío cuesta $250 y es gratis en compras desde $1.500.</p>
    <p class="bible-delivery-note">Te confirmamos personalmente la edición, la disponibilidad, la dirección y el plazo antes de coordinar. La entrega rápida no se promete hasta verificar esos datos.</p>
  </aside>`;
}

function commerceBenefitsHtml(category) {
    if (PRIORITY_LOCAL_INTENT_IDS.has(category.id)) {
        return '<div class="benefits"><span>Entrega hoy en Montevideo*</span><span>Envío $250</span><span>Gratis desde $1.500</span><span>Atención personalizada</span></div>';
    }
    return '<div class="benefits"><span>12% menos por transferencia</span><span>Hasta 12 cuotas</span><span>Envíos a todo Uruguay</span><span>Encargos del exterior</span></div>';
}

function psychologyPathwaysHtml(category) {
    if (category.id !== 'psicologia') return '';
    return `<section class="bible-pathways" aria-labelledby="psychology-pathways-title">
    <h2 id="psychology-pathways-title">Explorá por especialidad</h2>
    <p>Estas colecciones separan materias profesionales que antes quedaban mezcladas dentro de Psicología.</p>
    <div class="bible-pathway-grid">
      <a href="/libros/psicologia/psicoanalisis"><strong>Psicoanálisis</strong><span>Teoría, clínica, autores y escuelas psicoanalíticas.</span></a>
      <a href="/libros/psicologia/psicomotricidad"><strong>Psicomotricidad</strong><span>Desarrollo, evaluación, formación e intervención.</span></a>
      <a href="/libros/psicologia/autismo"><strong>Autismo y neurodesarrollo</strong><span>Bibliografía profesional, educativa y para familias.</span></a>
    </div>
  </section>`;
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

function subcategoryLinksHtml(category, categoryData) {
    if (!['esoterismo-tarot', 'esoterismo-tarot/libros-esoterismo', 'infantil-juvenil', 'desarrollo-personal', 'religion-espiritualidad', 'juegos-actividades'].includes(category.id)) return '';
    const rootId = category.id === 'esoterismo-tarot/libros-esoterismo' ? 'esoterismo-tarot' : category.id;
    const root = categoryData.categories?.find(entry => entry.id === rootId);
    const children = (root?.subcategories || []).filter(entry => Number(entry.count) > 0 && (rootId !== TAROT_CATEGORY_ID || entry.id !== 'tarot-oraculos'));
    if (!children.length) return '';
    const links = children.map(child => {
        const landing = SEO_CATEGORIES.find(entry => entry.parentId === rootId && entry.classificationId === child.id && !entry.tarotFilter);
        if (landing) return `<a href="/libros/${escapeHtml(landing.id)}">${escapeHtml(child.name)}</a>`;
        const query = new URLSearchParams({ categoria: rootId, subcategoria: child.id });
        return `<a href="/catalogo?${escapeHtml(query.toString())}">${escapeHtml(child.name)}</a>`;
    }).join('');
    return `<nav class="category-nav" aria-label="Subcategorías de ${escapeHtml(root.name)}">${links}</nav>`;
}

function cardHtml(item, index, navigationBase) {
    const href = `${navigationBase}/libro/${item.id}/${slugify(item.title)}`;
    const source = navigationBase === BASE
        ? bookCoverUrl(item.id)
        : httpsImg(item.pictures?.[0] || item.thumbnail || '');
    const image = responsiveImage(source, {
        widths: [240, 360, 480],
        defaultWidth: 360,
        sizes: CARD_IMAGE_SIZES,
        ...cardCoverImageOptions(item.id),
    });
    const title = escapeHtml(item.title);
    const author = item.author ? `<p class="book-author">${escapeHtml(item.author)}</p>` : '';
    const byRequest = item.status === 'paused';
    const price = byRequest ? 0 : Number(item.price) || 0;
    const priceText = price.toLocaleString('es-UY');
    const transferText = Math.round(price * 0.88).toLocaleString('es-UY');
    const installmentText = Math.round(price / 12).toLocaleString('es-UY');
    const responsiveAttrs = image.srcset
        ? ` srcset="${escapeHtml(image.srcset)}" sizes="${escapeHtml(image.sizes)}"`
        : '';
    const eager = index < 6;
    const imageHtml = image.src
        ? `<img src="${escapeHtml(image.src)}"${responsiveAttrs} alt="Portada de ${title}" loading="${eager ? 'eager' : 'lazy'}" decoding="async" width="280" height="420">`
        : '<span class="book-placeholder" aria-hidden="true">📚</span>';
    return `<article class="book-card">
  <a class="book-image" href="${escapeHtml(href)}">${imageHtml}</a>
  <div class="book-body">
    ${byRequest ? '<span class="stock-badge by-request">Por encargo</span>' : deliveryBadgeHtml(item.status === 'active' && Number(item.available_quantity) > 0)}
    <h2><a href="${escapeHtml(href)}">${title}</a></h2>
    ${author}
    ${price > 0 ? `<div class="book-prices">
      <strong>$${escapeHtml(priceText)} UYU</strong>
      <span>Hasta 12 cuotas de aprox. $${escapeHtml(installmentText)}</span>
      <span class="transfer">Transferencia: $${escapeHtml(transferText)}</span>
    </div>` : ''}
    ${byRequest ? '<p class="book-order-note">Consultá precio y plazo de entrega.</p>' : ''}
    <a class="book-cta" href="${escapeHtml(href)}">${byRequest ? 'Consultar ficha' : 'Ver ficha'}</a>
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

function renderPage({ category, categoryData, items, isPreview, hasUnexpectedParameters, navigationBase, page, pageSize, totalPages, order }) {
    const simple = isSimpleCategory(category);
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
    const productNoun = simple ? 'producto' : 'libro';
    const resultText = items.length === 0
        ? 'Sin productos en esta selección'
        : totalPages > 1
            ? `Mostrando ${rangeFrom}–${rangeTo} de ${items.length} ${productNoun}s`
            : `${items.length} ${productNoun}${items.length === 1 ? '' : 's'}`;
    const cards = visibleItems.map((item, index) => cardHtml(item, index, navigationBase)).join('\n');
    const robots = isPreview || hasUnexpectedParameters || Boolean(order) || items.length === 0
        ? 'noindex, follow'
        : 'index, follow';
    const pageTitle = page > 1 ? `${category.title} — Página ${page}` : category.title;
    const pageDescription = page > 1 ? `${category.description} Página ${page} de ${totalPages}.` : category.description;
    const pagination = paginationHtml({ categoryId: category.id, page, totalPages, order });
    // Contar la colección visible después de deduplicar, con ambos estados.
    const availableCount = items.filter(item => item.status === 'active' && Number(item.available_quantity) > 0).length;
    const byRequestCount = items.filter(item => item.status === 'paused').length;
    const scopeText = `<strong>${items.length} ${productNoun}${items.length === 1 ? '' : 's'}</strong> · ${availableCount} disponible${availableCount === 1 ? '' : 's'} · ${byRequestCount} por encargo`;
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
    *{box-sizing:border-box;margin:0;padding:0}body{font-family:Inter,system-ui,-apple-system,sans-serif;background:#f8f5ef;color:#18120e;line-height:1.55}a{color:inherit}.category-header{position:sticky;top:0;z-index:40;background:rgba(18,14,11,.97);color:#fff;border-bottom:1px solid rgba(255,255,255,.08)}.header-inner{max-width:1200px;height:72px;margin:auto;padding:0 1rem;display:grid;grid-template-columns:auto minmax(220px,1fr) auto;align-items:center;gap:1rem}.brand-link{display:flex;align-items:center;gap:.55rem;text-decoration:none}.brand-link img{width:44px;height:44px}.brand-link span{display:flex;flex-direction:column}.brand-link strong{font-size:.92rem}.brand-link small{color:rgba(255,255,255,.55);font-size:.7rem}.header-search{height:42px;display:flex;max-width:620px;width:100%;justify-self:center}.header-search input{min-width:0;flex:1;border:0;border-radius:999px 0 0 999px;padding:0 1rem;font:inherit}.header-search button{border:0;border-radius:0 999px 999px 0;padding:0 1rem;background:#e49982;color:#18120e;font-weight:800;cursor:pointer}.cart-link{min-height:42px;display:inline-flex;align-items:center;padding:0 .9rem;border:1px solid rgba(255,255,255,.2);border-radius:999px;text-decoration:none;font-size:.82rem}.breadcrumbs{max-width:1120px;margin:0 auto;padding:1rem;font-size:.82rem;color:#6b6157}.breadcrumbs a{color:#8f493b}.category-main{max-width:1120px;margin:0 auto;padding:0 1rem 3rem}.intro{padding:clamp(1.25rem,3vw,2rem);background:#fff;border:1px solid #e2dbd0;border-radius:1rem}.intro h1{font-family:Georgia,serif;font-size:clamp(1.75rem,5vw,2.6rem);line-height:1.12;margin-bottom:.8rem}.intro p{max-width:78ch;color:#5f554c}.category-scope{margin-top:1rem;padding:.75rem .9rem;border-left:4px solid #e49982;background:#f8f5ef;border-radius:.35rem;color:#50463e;font-size:.88rem}.benefits{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1rem}.benefits span{padding:.35rem .65rem;border-radius:999px;background:#f5f0ea;color:#50463e;font-size:.75rem;font-weight:700}.bible-pathways,.bible-guide,.bible-delivery{margin-top:1.25rem;border:1px solid #e2dbd0;border-radius:1rem;background:#fff;padding:clamp(1rem,3vw,1.5rem)}.bible-pathways h2,.bible-guide h2,.bible-delivery h2{font-family:Georgia,serif;font-size:1.35rem}.bible-pathways>p,.bible-guide-head p,.bible-delivery p{max-width:75ch;margin-top:.4rem;color:#5f554c}.bible-pathway-grid,.bible-guide-grid{display:grid;gap:.75rem;margin-top:1rem}.bible-pathway-grid a,.bible-guide-grid article{display:flex;flex-direction:column;gap:.25rem;border:1px solid #e2dbd0;border-radius:.75rem;background:#f8f5ef;padding:1rem;text-decoration:none}.bible-pathway-grid a:hover{border-color:#e49982}.bible-pathway-grid span,.bible-guide-grid p{color:#6b6157;font-size:.84rem}.bible-guide-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}.bible-eyebrow{color:#a94e3d!important;font-size:.72rem;font-weight:850;letter-spacing:.07em;text-transform:uppercase}.bible-cross-link{flex:none;display:inline-flex;min-height:44px;align-items:center;border-radius:999px;background:#18120e;color:#fff;padding:.6rem .9rem;text-decoration:none;font-size:.8rem;font-weight:800}.bible-delivery{background:#18120e;color:#fff;border-color:#18120e}.bible-delivery p{color:rgba(255,255,255,.78)}.bible-delivery .bible-delivery-note{font-size:.78rem;color:rgba(255,255,255,.6)}.buyer-guide{margin:1.5rem 0;padding:clamp(1rem,2.5vw,1.5rem);background:#fff;border:1px solid #e2dbd0;border-radius:1rem}.buyer-guide-head{max-width:78ch}.buyer-guide-head h2{font-family:Georgia,serif;font-size:clamp(1.3rem,3vw,1.75rem);line-height:1.2;margin-bottom:.45rem}.buyer-guide-head p{color:#5f554c}.buyer-guide-grid{display:grid;grid-template-columns:1fr;gap:.7rem;margin-top:1rem}.buyer-guide-card{padding:.85rem;background:#f8f5ef;border:1px solid #eee5da;border-radius:.65rem}.buyer-guide-card h3{font-size:.92rem;margin-bottom:.25rem}.buyer-guide-card p{font-size:.82rem;color:#5f554c}.buyer-guide-service{margin-top:1rem;padding:.75rem .85rem;border-left:4px solid #e49982;background:#fff8f4;color:#50463e;font-size:.84rem}.results-head{display:flex;align-items:end;justify-content:space-between;gap:1rem;margin:2rem 0 1rem}.results-head h2{font-size:1.15rem}.results-head p{color:#6b6157;font-size:.84rem}.books-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.8rem}.book-card{display:flex;flex-direction:column;min-width:0;background:#fff;border:1px solid #e2dbd0;border-radius:.8rem;overflow:hidden}.book-image{display:grid;place-items:center;aspect-ratio:3/4;background:#eee7de;overflow:hidden}.book-image img{width:100%;height:100%;object-fit:cover;transition:transform .2s}.book-card:hover .book-image img{transform:scale(1.025)}.book-placeholder{font-size:2.5rem}.book-body{display:flex;flex:1;flex-direction:column;align-items:flex-start;gap:.4rem;padding:.8rem}.stock-badge{padding:.16rem .48rem;border-radius:999px;background:#eaf7ee;color:#267a42;font-size:.64rem;font-weight:800;text-transform:uppercase}.book-body h2{font-size:.86rem;line-height:1.3}.book-body h2 a{text-decoration:none}.book-author{width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#6b6157;font-size:.75rem}.book-prices{display:flex;flex-direction:column;gap:.15rem;margin-top:.2rem;font-size:.72rem}.book-prices strong{font-size:.9rem}.book-prices .transfer{color:#a94e3d;font-weight:700}.book-cta{margin-top:auto;padding:.38rem .7rem;border-radius:999px;background:#18120e;color:#fff;text-decoration:none;font-size:.73rem;font-weight:700}.category-nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.55rem;margin-top:2.5rem;padding:1rem;background:#fff;border:1px solid #e2dbd0;border-radius:1rem}.category-nav a{padding:.55rem .7rem;border-radius:.55rem;background:#f8f5ef;text-decoration:none;font-size:.78rem}.category-nav a[aria-current="page"]{background:#18120e;color:#fff}.empty{margin-top:1.5rem;padding:1.5rem;background:#fff;border:1px solid #e2dbd0;border-radius:.8rem}${CARD_COVER_FRAMING_STYLES}${DELIVERY_BADGE_STYLES}${PAGINATION_STYLES}${FOOTER_STYLES}${WA_FLOAT_STYLES}${CATEGORY_ORDER_STYLES}${CATEGORY_PRODUCT_STYLES}@media(min-width:640px){.books-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.category-nav{grid-template-columns:repeat(4,minmax(0,1fr))}.buyer-guide-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.bible-pathway-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.bible-guide-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(min-width:900px){.books-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.bible-guide-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}@media(max-width:620px){.header-inner{height:auto;min-height:68px;grid-template-columns:1fr auto;padding:.55rem .8rem}.brand-link small,.cart-link{display:none}.header-search{grid-column:1/-1;grid-row:2;margin-bottom:.2rem}.category-header{position:relative}.bible-guide-head{flex-direction:column}.bible-cross-link{width:100%;justify-content:center}}
    .book-image{padding:.35rem}.book-image img{object-fit:contain}
  </style>
</head>
<body>
${headerHtml()}
${categoryBreadcrumbHtml(category)}
<main class="category-main${simple ? ' is-simple' : ''}">
  <section class="intro">
    <h1>${escapeHtml(category.h1)}</h1>
    ${simple ? '' : `<p>${escapeHtml(category.intro)}</p>`}
    <p class="category-scope">${scopeText}</p>
    ${simple ? '' : commerceBenefitsHtml(category)}
  </section>
  ${biblePathwaysHtml(category)}
  ${psychologyPathwaysHtml(category)}
  ${simple ? '' : subcategoryLinksHtml(category, categoryData)}
  ${simple ? categoryProductTabsHtml(category) : editorialGuideHtml(category)}
  ${categoryOrderHtml(category.id, order || 'mezclados')}
  <div class="results-head"><h2>${simple ? 'Todos los productos' : 'Todos los libros'}</h2><p>${resultText}</p></div>
  ${items.length > 0 ? `<section class="books-grid" aria-label="${escapeHtml(category.h1)}">${cards}</section>${pagination}` : '<p class="empty">No hay títulos publicados en esta categoría en este momento. Consultanos por WhatsApp y lo buscamos por encargo.</p>'}
  ${categoryNavHtml(category.id)}
</main>
${footerHtml(undefined, canonical)}
${waFloatHtml(waMessage, canonical)}
<script src="/search-autocomplete.js" defer></script>
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

    const requestedId = pathParts.map(part => String(part).toLowerCase()).join('/');
    if (requestedId === 'esoterismo-tarot/oraculos') {
        const url = new URL(ctx.request.url);
        const order = url.searchParams.get('orden');
        return new Response(null, { status: 301, headers: { Location: categoryPath(TAROT_DECKS_CATEGORY_ID, 1, order ? parseCategoryOrder(order) : '') } });
    }
    const category = findSeoCategory(requestedId);
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
    const order = requestUrl.searchParams.has('orden') ? parseCategoryOrder(requestUrl.searchParams.get('orden')) : '';
    const hasUnexpectedParameters = [...requestUrl.searchParams.keys()].some(key => key !== 'page' && key !== 'orden')
        || requestUrl.searchParams.getAll('page').length > 1 || requestUrl.searchParams.getAll('orden').length > 1;

    const [categoryData, activeIndex, pausedIndex] = await Promise.all([
        fetchCategoryData(ctx),
        ['preview', 'production'].includes(ctx.env?.APP_ENV)
            ? fetchActiveIndex(ctx)
            : Promise.resolve(null),
        ['preview', 'production'].includes(ctx.env?.APP_ENV)
            ? fetchPausedIndex(ctx) : Promise.resolve(null),
    ]);
    if (!categoryData) {
        return errorPage(503, 'Catálogo temporalmente no disponible', 'Intentá nuevamente en unos minutos.');
    }

    let activeItems = Array.isArray(activeIndex?.items) ? activeIndex.items : null;
    let fallbackPaused = [];
    if (!activeItems) {
        const catalog = await fetchCatalog(ctx);
        if (!catalog || !Array.isArray(catalog.items)) {
            return errorPage(503, 'Catálogo temporalmente no disponible', 'Intentá nuevamente en unos minutos.');
        }
        fallbackPaused = catalog.items.filter(item => item.status === 'paused');
        activeItems = catalog.items.filter(item =>
            item.status === 'active' && Number(item.available_quantity) > 0
        );
    }

    const classificationIds = category.classificationIds || [category.classificationId || category.id];
    const excludedClassificationIds = category.excludedClassificationIds || [];
    const seenIds = new Set();
    const eligibleItems = [...activeItems, ...(Array.isArray(pausedIndex?.items) ? pausedIndex.items : fallbackPaused)]
        .filter(item => { if (seenIds.has(item.id)) return false; seenIds.add(item.id); return true; });
    const categoryItems = eligibleItems
        .filter(item => {
            const paths = categoryData.items[item.id] || [];
            const matchesClassification = classificationIds.some(id => hasClassificationId(paths, id))
                && !excludedClassificationIds.some(id => hasClassificationId(paths, id));
            if (!matchesClassification) return false;
            if (category.tarotFilter === 'verified-decks') {
                const tarotTag = tarotTagLookup(item);
                return ['tarot', 'oraculo', 'lenormand', 'kipper', 'otro_sistema'].includes(tarotTag?.primary_type)
                    && tarotTag?.format === 'mazo'
                    && tarotTag?.needs_review !== true;
            }
            if (category.tarotFilter === 'study-books') return tarotTagLookup(item)?.format === 'libro';
            if (category.tarotFilter === 'books') {
                const tag = tarotTagLookup(item);
                return tag ? tag.format === 'libro' : !/\b(?:mazo|baraja|\d+\s+cartas|libro\s*(?:\+|y)\s*cartas)\b/i.test(item.title || '');
            }
            return true;
        })
        .sort((a, b) => {
            const stock = Number(b.available_quantity || 0) - Number(a.available_quantity || 0);
            if (stock) return stock;
            const price = Number(a.price || Infinity) - Number(b.price || Infinity);
            return price || String(a.id).localeCompare(String(b.id));
        });
    let items = dedupeCategoryResults(categoryItems);
    const selectedOrder = order || 'mezclados';
    if (['recientes', 'antiguos'].includes(selectedOrder) && items.some(item => !item.start_time)) {
        // El índice ligero conserva stock/precio actuales, pero no fechas.
        // Sólo se toma start_time del catálogo; nunca se pisa disponibilidad.
        const dates = await fetchCategoryDates(ctx);
        items = items.map(item => ({ ...item, start_time: item.start_time || dates.get(item.id) || null }));
    }
    items = orderCategoryItems(items, selectedOrder);
    const pageSize = BIBLE_CATEGORY_IDS.has(category.id) ? 24 : MAX_RESULTS;
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    if (pageParam.page > totalPages) {
        return errorPage(404, 'Página no encontrada', 'La página de esta categoría que buscás no existe.');
    }
    const isPreview = ctx.env?.APP_ENV === 'preview';
    const navigationBase = isPreview ? requestUrl.origin : BASE;
    const html = renderPage({
        category,
        categoryData,
        items,
        isPreview,
        hasUnexpectedParameters,
        navigationBase,
        page: pageParam.page,
        pageSize,
        totalPages,
        order,
    });

    return new Response(html, {
        headers: {
            'content-type': 'text/html;charset=UTF-8',
            'cache-control': 'public, max-age=3600',
        },
    });
}
