/**
 * functions/catalogo.js
 *
 * Página de índice SSR — vector de descubrimiento para Googlebot y catálogo
 * navegable para compradores.
 *
 * PROPÓSITO SEO:
 *   La home (index.html) carga los libros vía JS client-side (fetch R2 → DOM).
 *   Googlebot puede ejecutar JS, pero lo hace en una segunda pasada con delay.
 *   Esta página sirve HTML estático con <a href="/libro/{id}/{slug}"> para
 *   cada libro, permitiendo descubrimiento en el primer crawl pass. El
 *   listado completo para crawlers vive en sitemap.xml (no tocado acá);
 *   esta página muestra sus primeros 48 resultados como grilla de cards,
 *   igual que cualquier vista filtrada — nunca una lista de texto plano
 *   (CF-CATEGORÍAS-2D punto 4.1: causa raíz del bug reportado).
 *
 *   Es una página visible y accesible para usuarios (no un div oculto).
 *   Linked desde el footer de index.html y listada en el sitemap.
 *
 * DATOS: R2 catalog.json — misma fuente que libro/[[path]].js y sitemap.xml.js.
 *
 * CF-CATEGORÍAS-2C (Preview y producción): filtro por categoría
 * (?categoria=) y subcategoría (?subcategoria=) sobre el catálogo público,
 * usando el artefacto compacto generado por
 * scripts/categorize/export-active-categories.js (mlu -> [categoryId,
 * subcategoryId?], activos + pausados — incluye "otros-productos" para lo
 * que no es un libro, visible, no oculto). Combinable con ?q=, con orden de
 * relevancia (ISBN exacto > título exacto > título empieza con > frase en
 * título > autor exacto > todas las palabras > coincidencia parcial), con
 * el estado comercial (activa antes que pausada) como desempate.
 *
 * CF-CATEGORÍAS-2D (Preview y producción, aprobado en PR #52): las
 * pausadas se muestran públicamente, mezcladas con las activas, con badge
 * "Disponible por encargo" y CTA "Pedir este libro" (WhatsApp) en vez de
 * compra directa — nunca entran al checkout, nunca muestran un precio no
 * garantizado.
 */

import { slugify } from './_shared/slug.js';
// GLOBAL-SHELL-1: mismo favicon que el resto del sitio.
import { faviconHeadHtml } from './_shared/brand.js';
import {
    BASE,
    fetchActiveIndex,
    fetchCatalog,
    fetchPausedIndex,
} from './_shared/catalog.js';
import {
    ensurePerf,
    perfNow,
    perfSummary,
    recordPerf,
    serverTimingValue,
} from './_shared/perf.js';
import { previewCoverUrl } from './_shared/preview-cover.js';

const MAX_RESULTS = 48;
const WA = 'https://wa.me/59899841325';
const FREE_SHIPPING_THRESHOLD_UYU = 1500;

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
        .replace(/[̀-ͯ]/g, '')
        .trim();
}

function tokenize(value = '') {
    return normalizeText(value).split(/[^a-z0-9]+/).filter(Boolean);
}

function onlyDigits(value = '') {
    return String(value).replace(/\D/g, '');
}

function validIsbnKey(value = '') {
    const digits = onlyDigits(value);
    return digits.length === 10 || digits.length === 13 ? digits : '';
}

/**
 * Evita repetir la misma obra/edición en la grilla pública sin confundir
 * variantes reales. ISBN identifica edición y formato; el estado comercial
 * mantiene separadas una oferta disponible y otra que solo puede encargarse.
 * Cuando falta ISBN, solo agrupamos coincidencias exactas de título+autor.
 * El array ya llega ordenado por relevancia/criterio comercial, por eso se
 * conserva siempre el primer representante.
 */
export function dedupeCatalogResults(items) {
    const seen = new Set();
    return items.filter(item => {
        const isbn = validIsbnKey(item.isbn);
        const status = item.status === 'paused' ? 'paused' : 'active';
        const condition = normalizeText(item.condition || 'unknown');
        let key = '';
        if (isbn) {
            key = `isbn:${isbn}|${status}|${condition}`;
        } else {
            const title = normalizeText(item.title).replace(/[^a-z0-9]+/g, ' ').trim();
            const author = normalizeText(item.author).replace(/[^a-z0-9]+/g, ' ').trim();
            if (title && author) key = `title-author:${title}|${author}|${status}|${condition}`;
        }
        if (!key) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
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

// ── Orden de relevancia (CF-CATEGORÍAS-2C punto 5) ─────────────────────────
// Rangos, de más a menos relevante. Todo lo que entra al resultado ya pasó
// itemMatchesQuery (o no hay q) — esto solo decide el ORDEN entre lo que ya
// matcheó, nunca agrega resultados nuevos.
const RANK = {
    ISBN_EXACT: 1,
    TITLE_EXACT: 2,
    TITLE_STARTS_WITH: 3,
    TITLE_PHRASE: 4,
    AUTHOR_EXACT: 5,
    ALL_WORDS_EXACT: 6,
    PARTIAL: 7,
    FUZZY: 8,
};

function relevanceRank(book, ctx) {
    const { normalizedQuery, queryTokens, queryDigits } = ctx;
    if (!normalizedQuery) return RANK.PARTIAL;
    const normTitle = normalizeText(book.title);
    const normAuthor = normalizeText(book.author);
    if (queryDigits.length >= 3 && onlyDigits(String(book.isbn ?? '')) === queryDigits) return RANK.ISBN_EXACT;
    if (normTitle === normalizedQuery) return RANK.TITLE_EXACT;
    if (normTitle.startsWith(normalizedQuery)) return RANK.TITLE_STARTS_WITH;
    if (normTitle.includes(normalizedQuery)) return RANK.TITLE_PHRASE;
    if (normAuthor === normalizedQuery) return RANK.AUTHOR_EXACT;
    const titleWords = tokenize(book.title);
    if (queryTokens.length > 0 && queryTokens.every(qt => titleWords.includes(qt))) return RANK.ALL_WORDS_EXACT;
    return RANK.PARTIAL;
}

// Tolerancia liviana a errores de tipeo — CF-CATEGORÍAS-2C punto 5: "si se
// implementa, debe ser liviana y estar acotada". Se usa SOLO como último
// recurso, cuando la búsqueda estricta (itemMatchesQuery) no encontró nada,
// y solo compara la palabra completa de la consulta contra palabras del
// título de longitud similar (distancia de edición <= 1) — nunca sobre
// fragmentos cortos (<4 letras), para no producir resultados absurdos.
function levenshteinAtMost1(a, b) {
    if (a === b) return true;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < la && j < lb) {
        if (a[i] === b[j]) { i++; j++; continue; }
        edits++;
        if (edits > 1) return false;
        if (la === lb) { i++; j++; } // sustitución
        else if (la > lb) i++; // borrado en a
        else j++; // inserción en a
    }
    if (i < la || j < lb) edits++;
    return edits <= 1;
}

function fuzzyMatches(book, queryTokens) {
    if (queryTokens.length !== 1 || queryTokens[0].length < 4) return false;
    const q = queryTokens[0];
    const titleWords = tokenize(book.title);
    return titleWords.some(w => w.length >= 4 && levenshteinAtMost1(q, w));
}

// CF-CATEGORÍAS-2D punto 3.4: el estado comercial solo desempata — a
// relevancia equivalente, activa antes que pausada. Dentro de "activa",
// con stock disponible antes que sin stock (comportamiento previo,
// CF-STOCK-1). Nunca gana contra una diferencia real de relevancia: el
// sort principal es por `rank`, esto solo decide entre empates.
function commercialTier(b) {
    if (b.status === 'active' && Number(b.available_quantity) > 0) return 0;
    if (b.status === 'active') return 1;
    if (b.status === 'paused') return 2;
    return 3;
}

function httpsImg(url) {
    return (url || '')
        .replace('http://', 'https://')
        .replace(/-I\.(jpg|jpeg|png|webp)(?=($|\?))/i, '-O.$1');
}

// CF-CATEGORÍAS-2 — artefacto compacto mlu->[categoryId,subcategoryId?],
// Preview y producción. Mismo patrón de cache de borde que fetchCatalog/
// fetchActiveIndex (functions/_shared/catalog.js), pero deliberadamente
// separado: este archivo es propio de este lote (no pertenece al catálogo
// de MELI) y no debe volverse una dependencia de _shared/catalog.js sin
// necesidad real.
async function fetchActiveCategories(ctx) {
    // Nunca debe romper /catalogo: si el artefacto no existe todavía (por
    // ejemplo en tests, o antes del primer deploy que lo incluya), el
    // selector de categoría simplemente no aparece — mismo criterio que
    // fetchActiveIndex/fetchPausedIndex en _shared/catalog.js.
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
        return await response.json();
    } catch {
        return null;
    }
}

function filtersBarHtml({ categories, categoria, subcategoria, disponibilidad, rawQ, safeQ, selectedCategory }) {
    const availabilityInput = disponibilidad
        ? `<input type="hidden" name="disponibilidad" value="${escapeHtml(disponibilidad)}">`
        : '';
    if (!categories || categories.length === 0) {
        return `<form class="filters-bar" action="/catalogo" method="get">
    ${availabilityInput}
    <input type="search" name="q" value="${safeQ}" placeholder="Buscar por título, autor o ISBN" aria-label="Buscar libros" autocomplete="off" data-search-autocomplete>
    <button type="submit">Buscar</button>
  </form>`;
    }
    const catOptions = [`<option value=""${categoria ? '' : ' selected'}>Todos</option>`]
        .concat(categories.map(c => {
            const sel = c.id === categoria ? ' selected' : '';
            return `<option value="${escapeHtml(c.id)}"${sel}>${escapeHtml(c.name)} (${c.count})</option>`;
        })).join('\n      ');

    // Compacto en mobile: la subcategoría solo se renderiza cuando ya hay
    // una categoría elegida con subcategorías reales — nunca se muestran
    // las 19 categorías y todas las subcategorías a la vez.
    const subOptionsHtml = (selectedCategory?.subcategories?.length)
        ? `<label class="cat-select-wrap">
      <span class="sr-only">Subcategoría</span>
      <select name="subcategoria" id="subcat-select" onchange="this.form.submit()">
      ${[`<option value=""${subcategoria ? '' : ' selected'}>Todas</option>`]
            .concat(selectedCategory.subcategories.map(s => {
                const sel = s.id === subcategoria ? ' selected' : '';
                return `<option value="${escapeHtml(s.id)}"${sel}>${escapeHtml(s.name)} (${s.count})</option>`;
            })).join('\n      ')}
      </select>
    </label>`
        : '';

    const hasAnyFilter = Boolean(rawQ) || Boolean(categoria) || Boolean(subcategoria);
    const clearHref = catalogPath({
        q: rawQ,
        categoria: '',
        subcategoria: '',
        disponibilidad,
        page: 1,
    });
    const clearLink = hasAnyFilter && (categoria || subcategoria)
        ? `<a class="clear-filters" href="${escapeHtml(clearHref)}">Limpiar filtros ✕</a>`
        : '';

    return `<form class="filters-bar" action="/catalogo" method="get">
    ${availabilityInput}
    <input type="search" name="q" value="${safeQ}" placeholder="Buscar por título, autor o ISBN" aria-label="Buscar libros" autocomplete="off" data-search-autocomplete>
    <label class="cat-select-wrap">
      <span class="sr-only">Categoría</span>
      <select name="categoria" id="cat-select" onchange="this.form.submit()">
      ${catOptions}
      </select>
    </label>
    ${subOptionsHtml}
    <button type="submit">Buscar</button>
  </form>
  ${clearLink}`;
}

function availabilityTabsHtml({ disponibilidad, rawQ, categoria, subcategoria, availableCount, orderCount }) {
    const options = [
        { value: '', label: 'Todos', count: availableCount + orderCount },
        { value: 'disponibles', label: 'Disponibles ahora', count: availableCount },
        { value: 'encargo', label: 'Por encargo', count: orderCount },
    ];
    const links = options.map(option => {
        const current = option.value === disponibilidad;
        const href = catalogPath({
            q: rawQ,
            categoria,
            subcategoria,
            disponibilidad: option.value,
            page: 1,
        });
        return `<a class="availability-tab${current ? ' is-current' : ''}" href="${escapeHtml(href)}"${current ? ' aria-current="page"' : ''}>${option.label} <span>${option.count}</span></a>`;
    }).join('');
    return `<nav class="availability-tabs" aria-label="Filtrar por disponibilidad">${links}</nav>`;
}

const CAT_SELECT_STYLES = `
    .filters-bar{display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:.6rem}
    .filters-bar input[type=search]{flex:1;min-width:180px}
    .cat-select-wrap{display:flex}
    .cat-select-wrap select{padding:.55rem .75rem;border:1px solid #d1c8be;border-radius:.5rem;
                      font-size:.85rem;color:#1e293b;background:#fff;outline:none;max-width:100%}
    .cat-select-wrap select:focus{border-color:#a8957e;box-shadow:0 0 0 3px rgba(168,149,126,.15)}
    .clear-filters{display:inline-block;margin-bottom:1.25rem;font-size:.82rem;
                    color:#a94e3d;text-decoration:none;font-weight:600}
    .clear-filters:hover{text-decoration:underline}
    .active-filters{display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:.75rem}
    .filter-chip{display:inline-flex;align-items:center;gap:.3rem;padding:.25rem .65rem;
                 background:#efe6db;border-radius:999px;font-size:.75rem;color:#4a3d30;font-weight:600}
    .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
             clip:rect(0,0,0,0);white-space:nowrap;border:0}
    .availability-tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.45rem;
                       margin:0 0 1rem}
    .availability-tab{display:flex;align-items:center;justify-content:center;gap:.35rem;
                      min-height:44px;padding:.55rem .65rem;border:1px solid #d1c8be;
                      border-radius:.65rem;background:#fff;color:#4a3d30;font-size:.78rem;
                      font-weight:700;text-align:center;text-decoration:none}
    .availability-tab span{color:#7c6b59;font-size:.7rem;font-weight:600}
    .availability-tab:hover{background:#f5efe6}
    .availability-tab.is-current{border-color:#18120e;background:#18120e;color:#fff}
    .availability-tab.is-current span{color:#e8ded3}
    .availability-tab:focus-visible{outline:2px solid #a94e3d;outline-offset:2px}
    @media (max-width: 480px){
      .filters-bar{flex-direction:column}
      .filters-bar input[type=search],.cat-select-wrap select{width:100%}
    }
`;

// CF-CATEGORÍAS-2D punto 3.1: mensaje de WhatsApp autocompletado para pedir
// una pausada por encargo — título, autor (si existe), MLU siempre, y la
// URL de la ficha cuando existe. Nunca se muestra "pausado"/"paused" en el
// texto visible.
function buildOrderWaMessage(book, href) {
    let msg = `Hola, quiero consultar por encargo el libro "${book.title}"`;
    if (book.author) msg += `, de ${book.author}`;
    msg += `. Referencia: ${book.id}.`;
    if (href) msg += ` ${href}`;
    return msg;
}

// ── CATALOGO-PAGINACION-1 ────────────────────────────────────────────────────
// Antes de este lote la página truncaba en MAX_RESULTS sin forma de continuar:
// `/catalogo` mostraba 48 de 17.142 y no existía ningún parámetro de página.
// Los títulos restantes seguían siendo alcanzables con una búsqueda ?q=
// suficientemente específica, pero no se podían *navegar*. Acá se agrega esa
// navegación server-side, con enlaces HTML reales y sin depender de JS.

// `page` se valida como cadena, no con parseInt: parseInt('2abc') daría 2 y
// parseInt('2.9') daría 2, aceptando URLs que no queremos tratar como válidas.
// Tope de 7 dígitos para que Number() nunca reciba algo desbordado.
const PAGE_PARAM_RE = /^[1-9][0-9]{0,6}$/;

function parsePageParam(raw) {
    if (raw === null || raw === undefined) return { present: false, valid: true, page: 1 };
    const trimmed = String(raw).trim();
    if (!PAGE_PARAM_RE.test(trimmed)) return { present: true, valid: false, page: 1 };
    return { present: true, valid: true, page: Number(trimmed) };
}

// Forma canónica de una URL del catálogo: siempre el mismo orden de
// parámetros y sin `page` cuando es la primera. Se usa para el canonical y
// para cada enlace de paginación, así una misma vista tiene una sola URL.
function catalogPath({ q, categoria, subcategoria, disponibilidad, page }) {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (categoria) params.set('categoria', categoria);
    if (subcategoria) params.set('subcategoria', subcategoria);
    if (disponibilidad) params.set('disponibilidad', disponibilidad);
    if (page && page > 1) params.set('page', String(page));
    const qs = params.toString();
    return qs ? `/catalogo?${qs}` : '/catalogo';
}

// Ventana de páginas: primera, última, actual y sus vecinas inmediatas.
// Como máximo 7 celdas (1 … n-1 [n] n+1 … M), que es lo que entra en una
// fila a 390 px sin desbordar.
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

// Dos filas, pensadas para mobile primero:
//   fila 1 → ‹ Anterior · Página N de M · Siguiente ›
//   fila 2 → 1 … n-1 [n] n+1 … M
// Todo son <a href> reales: la navegación funciona sin JavaScript. Los
// extremos deshabilitados se renderizan como <span>, nunca como enlaces a
// una página inexistente.
function paginationHtml({ page, totalPages, hrefFor }) {
    if (totalPages <= 1) return '';

    const prevControl = page > 1
        ? `<a class="pg-ctl" rel="prev" href="${escapeHtml(hrefFor(page - 1))}" aria-label="Ir a la página anterior">‹ Anterior</a>`
        : `<span class="pg-ctl is-off" aria-disabled="true">‹ Anterior</span>`;
    const nextControl = page < totalPages
        ? `<a class="pg-ctl" rel="next" href="${escapeHtml(hrefFor(page + 1))}" aria-label="Ir a la página siguiente">Siguiente ›</a>`
        : `<span class="pg-ctl is-off" aria-disabled="true">Siguiente ›</span>`;

    const numbers = paginationWindow(page, totalPages).map(cell => {
        if (cell === 'gap') return '<span class="pg-gap" aria-hidden="true">…</span>';
        if (cell === page) return `<span class="pg-num is-current" aria-current="page">${cell}</span>`;
        const label = cell === 1
            ? 'Ir a la primera página'
            : cell === totalPages
                ? `Ir a la última página, ${cell}`
                : `Ir a la página ${cell}`;
        return `<a class="pg-num" href="${escapeHtml(hrefFor(cell))}" aria-label="${label}">${cell}</a>`;
    }).join('');

    return `<nav class="pg" aria-label="Paginación de resultados">
  <div class="pg-row pg-main">
    ${prevControl}
    <span class="pg-status">Página ${page} de ${totalPages}</span>
    ${nextControl}
  </div>
  <div class="pg-row pg-nums">${numbers}</div>
</nav>`;
}

const PAGINATION_STYLES = `
    .pg{margin-top:1.75rem;display:flex;flex-direction:column;gap:.5rem}
    .pg-row{display:flex;align-items:center;gap:.3rem}
    .pg-main{justify-content:space-between}
    .pg-nums{justify-content:center;flex-wrap:wrap}
    .pg-ctl,.pg-num,.pg-gap{min-width:44px;min-height:44px;
        display:inline-flex;align-items:center;justify-content:center;
        padding:0 .55rem;border-radius:.5rem;font-size:.85rem;
        text-decoration:none;line-height:1}
    .pg-ctl,.pg-num{border:1px solid #e2dbd0;background:#fff;color:#18120e}
    .pg-ctl{font-weight:600;white-space:nowrap}
    .pg-ctl:hover,.pg-num:hover{background:#f5efe6}
    .pg-ctl.is-off{color:#b3aaa0;background:#f5f2ee;border-color:#eee7dd}
    .pg-num.is-current{background:#18120e;color:#fff;border-color:#18120e;
        font-weight:800}
    .pg-gap{border:0;background:none;color:#94a3b8;min-width:24px}
    .pg-status{flex:1;text-align:center;font-size:.8rem;color:#64748b}
    .pg-ctl:focus-visible,.pg-num:focus-visible{outline:2px solid #a94e3d;
        outline-offset:2px}
`;

export async function onRequest(ctx) {
    const requestStartedAt = perfNow();
    ensurePerf(ctx);
    const url  = new URL(ctx.request.url);
    const rawQ = url.searchParams.get('q')?.trim() ?? '';
    const rawDisponibilidad = url.searchParams.get('disponibilidad')?.trim() ?? '';
    const disponibilidad = ['disponibles', 'encargo'].includes(rawDisponibilidad)
        ? rawDisponibilidad
        : '';

    if (rawDisponibilidad && !disponibilidad) {
        const clean = new URL(url);
        clean.searchParams.delete('disponibilidad');
        return new Response(null, {
            status: 301,
            headers: { Location: `${clean.pathname}${clean.search}` },
        });
    }

    // Una sola URL por vista: `?page=1` y cualquier `page` inválido redirigen
    // a la forma limpia. Va antes de tocar R2 — no hace falta el catálogo
    // para saber que la URL no es canónica.
    const pageParam = parsePageParam(url.searchParams.get('page'));
    if (pageParam.present && (!pageParam.valid || pageParam.page === 1)) {
        const clean = new URL(url);
        clean.searchParams.delete('page');
        return new Response(null, {
            status: 301,
            headers: { Location: `${clean.pathname}${clean.search}` },
        });
    }
    const rawCategoria = url.searchParams.get('categoria')?.trim() ?? '';
    const rawSubcategoria = url.searchParams.get('subcategoria')?.trim() ?? '';

    // CF-CATEGORÍAS-2C/2D: el filtro de categoría/subcategoría y la
    // inclusión pública de pausadas están habilitados en Preview y en
    // producción (aprobado explícitamente para producción — ver PR #52).
    // Cualquier otro entorno (tests, dev local sin APP_ENV) los deja
    // deshabilitados, catálogo sin cambios.
    const categoryFeaturesEnabled = ['preview', 'production'].includes(ctx.env?.APP_ENV);
    const categoryData = categoryFeaturesEnabled ? await fetchActiveCategories(ctx) : null;
    const categories = categoryData?.categories || [];
    const categoryItems = categoryData?.items || {}; // mlu -> [categoryId, subcategoryId?]
    const validCategoryIds = new Set(categories.map(c => c.id));
    // Categoría inválida vuelve a "Todos" — nunca 404, nunca error.
    const categoria = rawCategoria && validCategoryIds.has(rawCategoria) ? rawCategoria : '';
    const selectedCategory = categoria ? categories.find(c => c.id === categoria) : null;
    const validSubcategoryIds = new Set((selectedCategory?.subcategories || []).map(s => s.id));
    // Subcategoría inválida (o sin categoría elegida) vuelve a "Todas".
    const subcategoria = categoria && rawSubcategoria && validSubcategoryIds.has(rawSubcategoria) ? rawSubcategoria : '';
    const selectedSubcategoryName = subcategoria
        ? (selectedCategory.subcategories.find(s => s.id === subcategoria)?.name || '')
        : '';

    // CF-R2-2-BRIDGE: habilitado explícitamente en Preview y producción — cada
    // uno con su propio manifest (ver manifestUrlFor en _shared/catalog.js).
    // Si el manifest del entorno falta o es inválido, fetchActiveIndex/
    // fetchPausedIndex devuelven null y el fallback de abajo usa
    // fetchCatalog() igual que antes — nunca 500 por esto.
    const useCompactSearch = Boolean(rawQ) &&
        ['preview', 'production'].includes(ctx.env?.APP_ENV);
    // CF-CATEGORÍAS-2D: las pausadas participan de "Todos" incluso sin
    // búsqueda, en Preview y en producción — se piden siempre que la
    // funcionalidad de categorías esté habilitada, no solo cuando hay ?q=.
    const needPausedIndex = categoryFeaturesEnabled || useCompactSearch;
    const [activeIndex, pausedIndex] = await Promise.all([
        useCompactSearch ? fetchActiveIndex(ctx) : Promise.resolve(null),
        needPausedIndex ? fetchPausedIndex(ctx) : Promise.resolve(null),
    ]);
    // El catálogo completo sólo se necesita para el índice sin compactar,
    // producción o fallback de una versión compacta ausente/corrupta.
    const catalog = !useCompactSearch || !Array.isArray(activeIndex?.items)
        ? await fetchCatalog(ctx)
        : null;
    const items = (catalog && Array.isArray(catalog.items)) ? catalog.items : [];
    const pausedItems = Array.isArray(pausedIndex?.items) ? pausedIndex.items : [];
    const previewBase = ctx.env?.APP_ENV === 'preview'
        ? new URL(ctx.request.url).origin
        : BASE;

    const activeItems = Array.isArray(activeIndex?.items)
        ? activeIndex.items
        : items.filter(b => b.status === 'active' && Number(b.available_quantity) > 0);
    // "Todos" (CF-CATEGORÍAS-2C/2D) = activas visibles + pausadas visibles,
    // exactamente — ninguna exclusión por confianza, ninguna cerrada o
    // eliminada (esas nunca llegan a activeIndex/pausedIndex).
    const eligibleItemsRaw = [...activeItems, ...pausedItems];
    // Nunca duplicar un MLU en la grilla — red de seguridad aunque
    // activos/pausados deberían ser conjuntos disjuntos por construcción.
    const seenIds = new Set();
    const eligibleItems = eligibleItemsRaw.filter(b => {
        if (seenIds.has(b.id)) return false;
        seenIds.add(b.id);
        return true;
    });
    const safeQ = escapeHtml(rawQ);
    const hasFilter = Boolean(rawQ) || Boolean(categoria) || Boolean(disponibilidad);

    // ── Pipeline único de filtrado + orden — usado tanto para "Todos" (sin
    // filtro) como para búsqueda/categoría. CF-CATEGORÍAS-2D punto 4.1: la
    // versión anterior tenía una rama separada de solo-texto para "sin
    // filtro" — esa rama, no la herramienta de captura, era la causa de la
    // "lista textual en dos columnas" que vio Seba. Unificado: siempre
    // cards.
    const queryTokens = tokenize(rawQ);
    // Solo interpretar la consulta como ISBN cuando contiene únicamente
    // números y separadores habituales. Una búsqueda alfanumérica como
    // "zzzinexistente999" no debe coincidir con ISBN que contengan 999.
    const queryDigits = /^[\d\s-]+$/.test(rawQ.trim()) ? onlyDigits(rawQ) : '';
    const normalizedQuery = normalizeText(rawQ);
    const rankCtx = { normalizedQuery, queryTokens, queryDigits };

    const searchStartedAt = perfNow();
    let strictMatches = rawQ
        ? eligibleItems.filter(b => itemMatchesQuery(b, queryTokens, queryDigits))
        : eligibleItems;
    // Tolerancia liviana a errores de tipeo: solo si la búsqueda estricta no
    // encontró nada, con una sola palabra, y acotada a distancia 1.
    let usedFuzzy = false;
    if (rawQ && strictMatches.length === 0 && queryTokens.length === 1) {
        const fuzzy = eligibleItems.filter(b => fuzzyMatches(b, queryTokens));
        if (fuzzy.length > 0) { strictMatches = fuzzy; usedFuzzy = true; }
    }
    const scopedMatches = strictMatches
        .filter(b => (categoria ? (categoryItems[b.id] || [])[0] === categoria : true))
        .filter(b => (subcategoria ? (categoryItems[b.id] || [])[1] === subcategoria : true));
    // Los contadores de pestañas deben medir el mismo universo visible que
    // la grilla. Si se calculan antes de deduplicar, “Todos 9” puede terminar
    // mostrando “7 resultados”, contradicción directa para el comprador.
    const dedupedScopedMatches = dedupeCatalogResults(scopedMatches);
    const availableCount = dedupedScopedMatches.filter(b =>
        b.status === 'active' && Number(b.available_quantity) > 0
    ).length;
    const orderCount = dedupedScopedMatches.filter(b => b.status === 'paused').length;
    const availabilityMatches = dedupedScopedMatches.filter(b => {
        if (disponibilidad === 'disponibles') {
            return b.status === 'active' && Number(b.available_quantity) > 0;
        }
        if (disponibilidad === 'encargo') return b.status === 'paused';
        return true;
    });
    const ranked = availabilityMatches
        .map(b => ({ book: b, rank: usedFuzzy ? RANK.FUZZY : relevanceRank(b, rankCtx) }))
        .sort((a, b) => {
            if (a.rank !== b.rank) return a.rank - b.rank;
            const tier = commercialTier(a.book) - commercialTier(b.book);
            if (tier !== 0) return tier;
            // CATALOGO-PAGINACION-1: desempate final por id. Sin esto el orden
            // de los empatados depende de la posición en el JSON de R2, que el
            // cron regenera a diario: al paginar, un mismo libro podría
            // repetirse entre páginas o no aparecer en ninguna. `id` (MLU…) es
            // único y estable, así que la secuencia es reproducible.
            return String(a.book.id).localeCompare(String(b.book.id));
        })
        .map(x => x.book);
    const filtered = dedupeCatalogResults(ranked);
    recordPerf(ctx, 'search', searchStartedAt);

    const totalResults = filtered.length;
    const totalPages   = Math.max(1, Math.ceil(totalResults / MAX_RESULTS));
    // Página inexistente: 404 real. No redirigimos a la última página porque
    // el tamaño del catálogo cambia y esa normalización convertiría una URL
    // inexistente en contenido distinto según el sync.
    if (pageParam.page > totalPages) {
        return new Response('<!doctype html><html lang="es"><head><meta charset="UTF-8"><meta name="robots" content="noindex, nofollow"><title>Página no encontrada — Amado Libros</title></head><body><main><h1>Página no encontrada</h1><p>La página del catálogo que buscás no existe.</p><p><a href="/catalogo">Volver al catálogo</a></p></main></body></html>', {
            status: 404,
            headers: {
                'Content-Type': 'text/html;charset=UTF-8',
                'Cache-Control': 'public, max-age=300',
                'X-Robots-Tag': 'noindex, nofollow',
            },
        });
    }

    const page      = pageParam.page;
    const offset    = (page - 1) * MAX_RESULTS;
    const limited   = filtered.slice(offset, offset + MAX_RESULTS);
    const rangeFrom = totalResults === 0 ? 0 : offset + 1;
    const rangeTo   = offset + limited.length;

    // COVER-R2-PRODUCTION-1: una sola lectura memoizada del manifest por
    // request. Con catálogo completo exigimos coincidencia de la URL origen;
    // el índice compacto no conserva pictures[] y pasa null explícitamente.
    const r2Covers = ['preview', 'production'].includes(ctx.env?.APP_ENV)
        ? await Promise.all(limited.map(b => {
            const hasFullPictures = Array.isArray(b.pictures);
            const source = hasFullPictures
                ? httpsImg(b.pictures[0] || b.thumbnail || '')
                : null;
            return previewCoverUrl(ctx, b.id, 0, source);
        }))
        : Array(limited.length).fill(null);

    const cards = limited.map((b, idx) => {
        const slug  = slugify(b.title);
        const href  = escapeHtml(`${previewBase}/libro/${b.id}/${slug}`);
        const img   = escapeHtml(
            r2Covers[idx] || httpsImg(b.pictures?.[0] || b.thumbnail || '')
        );
        const title = escapeHtml(b.title);
        const author = b.author
            ? `<p class="rc-author">${escapeHtml(b.author)}</p>`
            : '';
        const available = b.status === 'active' && Number(b.available_quantity) > 0;
        // Tratamiento "Disponible por encargo"/"Pedir este libro"
        // (CF-CATEGORÍAS-2D) — habilitado en Preview y producción.
        const isPaused   = b.status === 'paused' && categoryFeaturesEnabled;
        const price     = Number(b.price) || 0;
        const transfer  = Math.round(price * 0.88).toLocaleString('es-UY');
        const priceStr  = price.toLocaleString('es-UY');
        const installment = Math.round(price / 12).toLocaleString('es-UY');
        const hasFreeShipping = price >= FREE_SHIPPING_THRESHOLD_UYU;
        const loading  = idx < 8 ? 'eager' : 'lazy';
        const waHref = `${WA}?text=${encodeURIComponent(`Hola Amado Libros, quiero consultar por encargo: ${b.title}`)}`;
        const orderWaHref = `${WA}?text=${encodeURIComponent(buildOrderWaMessage(b, href))}`;
        const imgTag = img
            ? `<img src="${img}" alt="${title}" loading="${loading}" decoding="async">`
            : `<div class="rc-no-img">📚</div>`;

        const badge = available
            ? `<span class="rc-badge available">Disponible</span>`
            : isPaused
                ? `<span class="rc-badge order">Disponible por encargo</span>`
                : `<span class="rc-badge order">No disponible</span>`;

        const bodyCta = available
            ? `<div class="rc-prices">
      <span class="rc-base"><span class="rc-lbl">Precio web/tarjeta:</span> $${escapeHtml(priceStr)} UYU</span>
      <span class="rc-installment">Hasta 12 cuotas de aprox. $${escapeHtml(installment)} UYU</span>
      <span class="rc-transfer"><span aria-hidden="true">🏷️</span> 12% menos por transferencia: $${escapeHtml(transfer)} UYU</span>
      ${hasFreeShipping ? '<span class="rc-free-shipping"><span aria-hidden="true">🚚</span> Envío gratis</span>' : ''}
    </div>
    <a href="${href}" class="rc-cta">Ver ficha →</a>`
            : isPaused
                ? `<div class="rc-order-info">
      <strong>Disponible por encargo</strong>
      <span>Precio y disponibilidad a confirmar.</span>
    </div>
    <a href="${escapeHtml(orderWaHref)}" class="rc-cta rc-wa" target="_blank" rel="noopener noreferrer">Pedir este libro</a>`
                : `<div class="rc-order-info">
      <strong>No disponible por el momento</strong>
      <span>Podés pedir que te avisemos cuando vuelva.</span>
    </div>
    <a href="${href}#aviso-stock" class="rc-cta">Avisame cuando llegue</a>
    <a href="${escapeHtml(waHref)}" class="rc-cta rc-wa" target="_blank" rel="noopener noreferrer">Buscarlo por encargo</a>`;

        return `<article class="rc-card${available ? '' : ' is-order'}">
  <a href="${href}" class="rc-img">${imgTag}</a>
  <div class="rc-body">
    ${badge}
    <a href="${href}" class="rc-title-link"><p class="rc-title">${title}</p></a>
    ${author}
    ${bodyCta}
  </div>
</article>`;
    }).join('\n');

    const resultLabel = totalResults === 1 ? 'resultado' : 'resultados';
    const subText = totalResults === 0
        ? 'No encontramos resultados.'
        : totalPages > 1
            ? `Mostrando ${rangeFrom}–${rangeTo} de ${totalResults} ${resultLabel}.`
            : `${totalResults} ${resultLabel}.`;

    const filterLabelParts = [];
    if (categoria) filterLabelParts.push(escapeHtml(selectedCategory.name));
    if (subcategoria) filterLabelParts.push(escapeHtml(selectedSubcategoryName));
    const filterLabel = filterLabelParts.join(' › ');
    const availabilityLabel = disponibilidad === 'disponibles'
        ? 'Disponibles ahora'
        : disponibilidad === 'encargo'
            ? 'Libros por encargo'
            : '';

    const heading = rawQ && filterLabel
        ? `Resultados para &ldquo;${safeQ}&rdquo; en ${filterLabel}`
        : rawQ
            ? `Resultados para &ldquo;${safeQ}&rdquo;`
            : filterLabel || availabilityLabel || (page > 1
                ? `Libros disponibles y por encargo — Página ${page}`
                : 'Libros disponibles y por encargo');
    const pageTitle = rawQ && filterLabel
        ? `${safeQ} en ${filterLabel} — Amado Libros`
        : rawQ
            ? `Resultados para &ldquo;${safeQ}&rdquo; — Amado Libros`
            : filterLabel
                ? `${filterLabel} — Amado Libros`
                : page > 1
                    ? `Catálogo de libros — Página ${page} | Amado Libros`
                    : 'Comprar libros disponibles y por encargo | Amado Libros';
    const emptyMessage = rawQ
        ? `Sin resultados para &ldquo;${safeQ}&rdquo;${filterLabel ? ` en ${filterLabel}` : ''}. Intentá con otras palabras${categoria ? ' o cambiá de categoría' : ''} o <a href="/">volvé al catálogo</a>.<br><br>¿No encontrás lo que buscás? <a class="wa-link" href="${WA}?text=${encodeURIComponent(`Hola Amado Libros, busco: ${rawQ}`)}" target="_blank" rel="noopener noreferrer">Consultanos por WhatsApp</a> y te ayudamos.`
        : `Todavía no hay resultados en esta categoría. <a href="/catalogo">Volvé a Todos los libros</a>.`;

    // Chips de filtros activos — visibilidad clara de qué está aplicado.
    const chips = [];
    if (rawQ) chips.push(`<span class="filter-chip">“${safeQ}”</span>`);
    if (categoria) chips.push(`<span class="filter-chip">${escapeHtml(selectedCategory.name)}</span>`);
    if (subcategoria) chips.push(`<span class="filter-chip">${escapeHtml(selectedSubcategoryName)}</span>`);
    if (availabilityLabel) chips.push(`<span class="filter-chip">${availabilityLabel}</span>`);
    const chipsHtml = chips.length > 0 ? `<div class="active-filters">${chips.join('')}</div>` : '';

    // Sin filtro: página de índice, indexable, con metadatos/JSON-LD ricos
    // para SEO (comportamiento previo). Con filtro: noindex, evita
    // contenido delgado/duplicado en resultados de búsqueda/categoría.
    const isIndex = !hasFilter;
    const metaDescription = isIndex
        ? page > 1
            ? `Página ${page} de ${totalPages} del catálogo de Amado Libros: títulos disponibles y por encargo, con envíos a todo Uruguay.`
            : `${activeItems.length} libros disponibles y ${pausedItems.length} por encargo en Uruguay; ediciones agotadas e importadas de Europa; envío gratis desde $1.500.`
        : 'Resultados en Amado Libros.';
    // Las búsquedas internas no se indexan, pero sí se siguen: `follow` deja
    // que el crawler descubra las fichas enlazadas desde los resultados.
    const robotsMeta = isIndex
        ? 'index, follow'
        : (rawQ || disponibilidad) ? 'noindex, follow' : 'noindex';
    // La secuencia limpia /catalogo?page=N tiene canonical propio. Las vistas
    // con búsqueda/categoría/subcategoría siguen noindex y canonicalizan al
    // catálogo limpio: no abrimos un segundo espacio SEO de filtros.
    const canonicalHref = isIndex
        ? `${BASE}${catalogPath({ q: '', categoria: '', subcategoria: '', disponibilidad: '', page })}`
        : `${BASE}/catalogo`;
    const paginationBlock = paginationHtml({
        page,
        totalPages,
        hrefFor: target => catalogPath({
            q: rawQ, categoria, subcategoria, disponibilidad, page: target,
        }),
    });
    const jsonLd = isIndex
        ? `<script type="application/ld+json">${JSON.stringify({
            '@context':   'https://schema.org',
            '@type':      'CollectionPage',
            'name':       page > 1
                ? `Catálogo de libros importados y por encargo — Página ${page}`
                : 'Catálogo de libros importados y por encargo en Uruguay',
            'url':        canonicalHref,
            'description': metaDescription,
            'isPartOf':   { '@type': 'WebSite', 'name': 'Amado Libros', 'url': BASE },
            'publisher':  { '@type': 'BookStore', 'name': 'Amado Libros', 'url': BASE },
          })}</script>`
        : '';

    const renderStartedAt = perfNow();
    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${pageTitle}</title>
  <meta name="description" content="${metaDescription}">
  <link rel="canonical" href="${escapeHtml(canonicalHref)}">
  <meta name="robots" content="${robotsMeta}">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="es_UY">
  <meta property="og:site_name" content="Amado Libros">
  <meta property="og:title" content="${pageTitle}">
  <meta property="og:description" content="${metaDescription}">
  <meta property="og:url" content="${escapeHtml(canonicalHref)}">
  <meta property="og:image" content="${BASE}/images/logo-amado.webp">
  <meta property="og:image:alt" content="Amado Libros, librería uruguaya">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${pageTitle}">
  <meta name="twitter:description" content="${metaDescription}">
  <meta name="twitter:image" content="${BASE}/images/logo-amado.webp">
  ${faviconHeadHtml()}
  ${jsonLd}
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         background:#faf7f2;color:#1e293b;line-height:1.5}
    .wrap{max-width:1100px;margin:0 auto;padding:1.25rem 1rem 3rem}
    nav{font-size:.875rem;margin-bottom:1.25rem}
    nav a{color:#3b82f6;text-decoration:none}
    nav a:hover{text-decoration:underline}
    h1{font-size:1.35rem;font-weight:800;margin-bottom:.3rem}
    .sub{color:#64748b;font-size:.875rem;margin-bottom:.75rem}
    .grid{display:grid;gap:1rem;
          grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
    @media(min-width:500px){.grid{grid-template-columns:repeat(auto-fill,minmax(180px,1fr))}}
    @media(min-width:900px){.grid{grid-template-columns:repeat(4,1fr)}}
    .rc-card{display:flex;flex-direction:column;background:#fff;
             border:1px solid #e2dbd0;border-radius:.75rem;overflow:hidden;
             color:inherit;
             transition:box-shadow .15s}
    .rc-card:hover{box-shadow:0 4px 16px rgba(24,18,14,.1)}
    .rc-card.is-order{border-color:#e8c9a0}
    .rc-img{display:block;aspect-ratio:3/4;background:#ede9e1;overflow:hidden;padding:.35rem}
    .rc-img img{width:100%;height:100%;object-fit:contain;display:block;
                transition:transform .25s}
    .rc-card:hover .rc-img img{transform:scale(1.04)}
    .rc-no-img{width:100%;height:100%;display:flex;align-items:center;
               justify-content:center;font-size:2.5rem;color:#c4b9ad}
    .rc-body{padding:.875rem 1rem;display:flex;flex-direction:column;gap:.45rem;flex:1}
    .rc-title{font-size:.95rem;font-weight:700;color:#18120e;line-height:1.25;
              display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
    .rc-title-link{text-decoration:none;color:inherit}
    .rc-title-link:hover .rc-title{color:#a94e3d}
    .rc-author{font-size:.82rem;color:#6b6157;
               white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .rc-prices{display:flex;flex-direction:column;gap:.2rem;margin-top:.35rem}
    .rc-base,.rc-installment,.rc-transfer,.rc-free-shipping{line-height:1.3}
    .rc-base{font-size:.95rem;color:#18120e;font-weight:700}
    .rc-installment{font-size:.82rem;color:#374151;font-weight:600}
    .rc-transfer{font-size:.78rem;color:#a94e3d;font-weight:600}
    .rc-free-shipping{font-size:.78rem;color:#267a42;font-weight:700}
    .rc-lbl{font-weight:700}
    .wa-link{color:#15803d;font-weight:500}
    .rc-badge{display:inline-flex;align-self:flex-start;padding:.18rem .55rem;
              border-radius:999px;font-size:.68rem;font-weight:800;
              letter-spacing:.05em;text-transform:uppercase}
    .rc-badge.available{color:#267a42;background:#eaf7ee}
    .rc-badge.order{color:#8a4b08;background:#fff2dc}
    .rc-order-info{display:flex;flex-direction:column;gap:.15rem;margin-top:.35rem;
                   color:#6b4b2a;font-size:.8rem;line-height:1.4}
    .rc-order-info span{color:#7c6b59;font-size:.75rem}
    .rc-cta{display:inline-block;margin-top:auto;padding:.3rem .75rem;
            border:1px solid #e2dbd0;border-radius:2rem;font-size:.78rem;
            font-weight:600;color:#18120e;background:#f5f0ea;align-self:flex-start;
            text-decoration:none}
    .rc-card:hover .rc-cta{background:#e2dbd0}
    .rc-cta.rc-wa{color:#117a37;border-color:#b9dfc7;background:#effaf3}
    .rc-card:hover .rc-cta.rc-wa{background:#dcf5e5}
    .empty{padding:2rem 0;color:#64748b;font-size:.95rem}
    footer{margin-top:2.5rem;padding-top:1rem;border-top:1px solid #e2e8f0;
           font-size:.78rem;color:#94a3b8}
    footer a{color:#cbd5e1;text-decoration:none}
    footer a:hover{text-decoration:underline}
    ${CAT_SELECT_STYLES}
    ${PAGINATION_STYLES}
  </style>
</head>
<body>
<div class="wrap">
  <nav><a href="/">← Amado Libros</a></nav>
  ${filtersBarHtml({ categories, categoria, subcategoria, disponibilidad, rawQ, safeQ, selectedCategory })}
  ${availabilityTabsHtml({ disponibilidad, rawQ, categoria, subcategoria, availableCount, orderCount })}
  ${chipsHtml}
  <h1>${heading}</h1>
  <p class="sub">${subText}</p>
  ${totalResults > 0
    ? `<div class="grid">\n${cards}\n</div>\n${paginationBlock}`
    : `<p class="empty">${emptyMessage}</p>`
  }
  <footer>
    <a href="/">Inicio</a> · <a href="/libros-agotados-importados-uruguay">Libros agotados e importados</a> · <a href="/politicas">Políticas</a> ·
    &copy; 2026 Amado Libros
  </footer>
</div>
<script src="/search-autocomplete.js" defer></script>
</body>
</html>`;

    recordPerf(ctx, 'render', renderStartedAt);
    const totalDuration = Math.round((perfNow() - requestStartedAt) * 100) / 100;
    const serverTiming = serverTimingValue(ctx, [{
        name: 'route_total',
        duration_ms: totalDuration,
    }]);
    const cacheStatus = ctx.data.perf.cache.miss > 0 ? 'MISS' : 'HIT';
    console.log(JSON.stringify(perfSummary(ctx, {
        route: '/catalogo',
        mode: useCompactSearch ? 'compact' : 'full',
        result_count: filtered.length,
        total_ms: totalDuration,
    })));

    return new Response(html, {
        headers: {
            'content-type':  'text/html;charset=UTF-8',
            'cache-control': isIndex ? 'public, max-age=3600' : 'public, max-age=300',
            'server-timing': serverTiming,
            'x-cache-status': cacheStatus,
            'x-perf-cache-hits': String(ctx.data.perf.cache.hit),
            'x-perf-cache-misses': String(ctx.data.perf.cache.miss),
        },
    });
}
