/**
 * /temas — mapa de todos los temas del catálogo.
 *
 * La portada muestra ocho tarjetas; el resto de los rubros quedaba escondido
 * en el desplegable de /catalogo. Esta página lista las categorías que ya
 * existen (sin inventar ninguna), agrupadas, con sus subtemas, y separa en
 * cada tema lo disponible ahora de lo que se pide por encargo: para quien
 * compra desde Uruguay, esa diferencia es el plazo de entrega.
 *
 * Los contadores usan el mismo universo que las pestañas de /catalogo
 * (activas con stock + pausadas, deduplicadas con dedupeCatalogResults), así
 * que el número que se lee acá coincide con el que aparece al entrar.
 */

import { BASE, fetchCatalog, fetchPausedIndex } from './_shared/catalog.js';
import {
    BRAND,
    faviconHeadHtml,
    footerHtml,
    FOOTER_STYLES,
    waFloatHtml,
    WA_FLOAT_STYLES,
} from './_shared/brand.js';
import { SEO_CATEGORIES } from './_shared/seo-categories.js';
import { siteHeaderHtml, SITE_HEADER_STYLES, SITE_HEADER_SCRIPT, SITE_FONTS_HEAD } from './_shared/site-header.js';
import { normalizeCategoryPaths } from './_shared/category-paths.js';
import { dedupeCatalogResults } from './catalogo.js';

const PATH = '/temas';
const TITLE = 'Todos los temas de libros | Amado Libros Uruguay';
const DESCRIPTION = 'Explorá todos los temas del catálogo de Amado Libros: literatura, psicología, historia, educación, cómics, arte y más. Separamos los libros disponibles ahora de los que pedimos por encargo.';
const HTML_CACHE_SECONDS = 900;

/**
 * Agrupación editorial de las categorías existentes. Cualquier categoría
 * nueva que aparezca en active-categories.json y no esté listada acá cae en
 * "Más temas", para que nunca quede invisible por olvido.
 */
export const THEME_GROUPS = Object.freeze([
    {
        id: 'leer-por-placer',
        title: 'Leer por placer',
        intro: 'Novelas, cuentos, historietas y lecturas para todas las edades.',
        categories: ['literatura-ficcion', 'comics-manga', 'infantil-juvenil'],
    },
    {
        id: 'mente-y-vinculos',
        title: 'Mente, salud y vínculos',
        intro: 'Psicología, crianza, bienestar y formación en salud.',
        categories: ['psicologia', 'desarrollo-personal', 'familia-crianza', 'medicina-salud'],
    },
    {
        id: 'espiritualidad',
        title: 'Espiritualidad y esoterismo',
        intro: 'Biblias, tradiciones, tarot, astrología y caminos interiores.',
        categories: ['religion-espiritualidad', 'esoterismo-tarot'],
    },
    {
        id: 'estudio',
        title: 'Estudio y conocimiento',
        intro: 'Para aprender, enseñar y entender el mundo.',
        categories: [
            'historia',
            'educacion',
            'filosofia-ciencias-sociales',
            'idiomas-aprendizaje',
            'ciencia-tecnologia',
            'negocios-economia',
            'derecho',
        ],
    },
    {
        id: 'artes-y-vida',
        title: 'Artes, ocio y vida práctica',
        intro: 'Arte, cocina, deportes, naturaleza y juegos.',
        categories: [
            'arte-diseno-fotografia',
            'cocina-gastronomia',
            'deportes',
            'naturaleza-animales',
            'juegos-actividades',
        ],
    },
]);

// Rubros que no son un tema de lectura: se muestran aparte, con su nombre
// real, para no mezclarlos con la navegación temática.
const CATCH_ALL_IDS = new Set(['otros-libros', 'otros-productos']);

// Landing SEO de primer nivel, cuando existe. El resto entra por el filtro
// del catálogo, que ya funciona para todas las categorías.
const LANDING_BY_CATEGORY = new Map(
    SEO_CATEGORIES
        .filter(category => !category.parentId && !category.id.includes('/'))
        .map(category => [category.id, `/libros/${category.id}`]),
);

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const numberFormat = new Intl.NumberFormat('es-UY');
const formatCount = value => numberFormat.format(value);

export function catalogFilterHref(categoryId, { subcategoryId = '', availability = '' } = {}) {
    const query = new URLSearchParams({ categoria: categoryId });
    if (subcategoryId) query.set('subcategoria', subcategoryId);
    if (availability) query.set('disponibilidad', availability);
    return `/catalogo?${query}`;
}

export function themeHref(categoryId) {
    return LANDING_BY_CATEGORY.get(categoryId) || catalogFilterHref(categoryId);
}

async function fetchCategoryMap(ctx) {
    try {
        const url = new URL('/data/active-categories.json', ctx.request.url).toString();
        const cache = typeof caches !== 'undefined' ? caches.default : null;
        const cacheKey = new Request(url);
        let response = cache ? await cache.match(cacheKey) : null;
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
            if (cache && typeof ctx?.waitUntil === 'function') {
                ctx.waitUntil(cache.put(cacheKey, response.clone()));
            }
        }
        const data = await response.json();
        return data && Array.isArray(data.categories) && data.items && typeof data.items === 'object'
            ? data
            : null;
    } catch {
        return null;
    }
}

/**
 * Cuenta, por categoría, cuántos títulos hay disponibles ahora y cuántos por
 * encargo. Mismo universo y misma deduplicación que las pestañas de
 * /catalogo?categoria=X. Devuelve null si falta el catálogo: la página se
 * degrada a los totales del mapa de categorías, nunca a un error.
 */
export function countAvailabilityByCategory({ activeItems, pausedItems, categoryItems }) {
    if (!Array.isArray(activeItems)) return null;
    const seenIds = new Set();
    const buckets = new Map();
    for (const item of [...activeItems, ...(pausedItems || [])]) {
        if (!item || seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        const paths = normalizeCategoryPaths(categoryItems[item.id]);
        const categoryIds = new Set(paths.map(path => path[0]));
        for (const categoryId of categoryIds) {
            if (!buckets.has(categoryId)) buckets.set(categoryId, []);
            buckets.get(categoryId).push(item);
        }
    }
    const counts = new Map();
    for (const [categoryId, items] of buckets) {
        const deduped = dedupeCatalogResults(items);
        counts.set(categoryId, {
            available: deduped.filter(b => b.status === 'active' && Number(b.available_quantity) > 0).length,
            order: deduped.filter(b => b.status === 'paused').length,
        });
    }
    return counts;
}

async function loadCounts(ctx, categoryItems) {
    try {
        const [catalog, pausedIndex] = await Promise.all([
            fetchCatalog(ctx),
            fetchPausedIndex(ctx).catch(() => null),
        ]);
        if (!catalog || !Array.isArray(catalog.items)) return null;
        const activeItems = catalog.items.filter(b => b.status === 'active' && Number(b.available_quantity) > 0);
        const pausedItems = Array.isArray(pausedIndex?.items) ? pausedIndex.items : [];
        return countAvailabilityByCategory({ activeItems, pausedItems, categoryItems });
    } catch {
        return null;
    }
}

/**
 * Arma los grupos visibles a partir de las categorías reales. Ninguna
 * categoría vacía aparece; ninguna categoría existente queda afuera.
 */
export function buildThemeGroups(categories, counts) {
    const byId = new Map(categories.map(category => [category.id, category]));
    const placed = new Set();
    const toTheme = category => {
        const split = counts?.get(category.id) || null;
        return {
            id: category.id,
            name: category.name,
            total: split ? split.available + split.order : Number(category.count) || 0,
            available: split ? split.available : null,
            order: split ? split.order : null,
            subcategories: (category.subcategories || [])
                .filter(sub => Number(sub.count) > 0)
                .sort((a, b) => Number(b.count) - Number(a.count)),
        };
    };
    const groups = THEME_GROUPS.map(group => {
        const themes = group.categories
            .map(id => byId.get(id))
            .filter(Boolean)
            .map(category => {
                placed.add(category.id);
                return toTheme(category);
            })
            .filter(theme => theme.total > 0);
        return { ...group, themes };
    });
    const leftovers = categories
        .filter(category => !placed.has(category.id) && !CATCH_ALL_IDS.has(category.id))
        .map(toTheme)
        .filter(theme => theme.total > 0);
    if (leftovers.length) {
        groups.push({ id: 'mas-temas', title: 'Más temas', intro: '', categories: [], themes: leftovers });
    }
    const catchAll = categories
        .filter(category => CATCH_ALL_IDS.has(category.id))
        .map(toTheme)
        .filter(theme => theme.total > 0);
    return { groups: groups.filter(group => group.themes.length), catchAll };
}

function availabilityHtml(theme) {
    if (theme.available === null) {
        return `<p class="theme-counts"><a href="${escapeHtml(catalogFilterHref(theme.id))}">${formatCount(theme.total)} títulos</a></p>`;
    }
    const parts = [];
    if (theme.available > 0) {
        parts.push(`<a class="count-now" href="${escapeHtml(catalogFilterHref(theme.id, { availability: 'disponibles' }))}"><strong>${formatCount(theme.available)}</strong> disponibles ahora</a>`);
    }
    if (theme.order > 0) {
        parts.push(`<a class="count-order" href="${escapeHtml(catalogFilterHref(theme.id, { availability: 'encargo' }))}"><strong>${formatCount(theme.order)}</strong> por encargo</a>`);
    }
    return `<p class="theme-counts">${parts.join('')}</p>`;
}

function themeCardHtml(theme) {
    const subs = theme.subcategories.length
        ? `<ul class="subtopics" aria-label="Subtemas de ${escapeHtml(theme.name)}">${theme.subcategories.map(sub => `<li><a href="${escapeHtml(catalogFilterHref(theme.id, { subcategoryId: sub.id }))}">${escapeHtml(sub.name)}</a></li>`).join('')}</ul>`
        : '';
    return `<article class="theme" id="${escapeHtml(theme.id)}">
        <h3><a href="${escapeHtml(themeHref(theme.id))}">${escapeHtml(theme.name)}</a></h3>
        ${availabilityHtml(theme)}
        ${subs}
      </article>`;
}

function catchAllHtml(catchAll) {
    if (!catchAll.length) return '';
    const labels = {
        'otros-libros': 'Libros que todavía no ubicamos en un tema. Los estamos revisando uno por uno para sumarlos a su lugar.',
        'otros-productos': 'Discos, revistas, objetos de colección y papelería.',
    };
    return `<section class="group catch-all" aria-labelledby="catch-all-title">
      <div class="group-head">
        <h2 id="catch-all-title">Fuera de los temas</h2>
      </div>
      <div class="themes">
        ${catchAll.map(theme => `<article class="theme theme-muted" id="${escapeHtml(theme.id)}">
          <h3><a href="${escapeHtml(catalogFilterHref(theme.id))}">${escapeHtml(theme.name)}</a></h3>
          <p class="theme-note">${escapeHtml(labels[theme.id] || '')}</p>
          ${availabilityHtml(theme)}
        </article>`).join('')}
      </div>
    </section>`;
}

export function renderTemasPage({ groups, catchAll, hasSplit }) {
    const canonical = `${BASE}${PATH}`;
    const allThemes = groups.flatMap(group => group.themes);
    const schema = {
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'CollectionPage',
                '@id': `${canonical}#webpage`,
                'url': canonical,
                'name': 'Todos los temas',
                'description': DESCRIPTION,
                'inLanguage': 'es-UY',
                'isPartOf': { '@id': `${BASE}/#website` },
                'mainEntity': {
                    '@type': 'ItemList',
                    'itemListElement': allThemes.map((theme, index) => ({
                        '@type': 'ListItem',
                        'position': index + 1,
                        'name': theme.name,
                        'url': `${BASE}${themeHref(theme.id)}`,
                    })),
                },
            },
            {
                '@type': 'BreadcrumbList',
                'itemListElement': [
                    { '@type': 'ListItem', 'position': 1, 'name': 'Inicio', 'item': `${BASE}/` },
                    { '@type': 'ListItem', 'position': 2, 'name': 'Todos los temas', 'item': canonical },
                ],
            },
        ],
    };
    const legend = hasSplit
        ? `<ul class="legend">
        <li><span class="dot dot-now" aria-hidden="true"></span><span><strong>Disponible ahora:</strong> en stock, listo para enviar.</span></li>
        <li><span class="dot dot-order" aria-hidden="true"></span><span><strong>Por encargo:</strong> lo conseguimos para vos y te confirmamos el plazo antes de avanzar.</span></li>
      </ul>`
        : '';

    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${TITLE}</title>
  <meta name="description" content="${DESCRIPTION}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${canonical}">
  ${faviconHeadHtml()}
  ${SITE_FONTS_HEAD}
  <meta property="og:type" content="website">
  <meta property="og:locale" content="es_UY">
  <meta property="og:site_name" content="${BRAND.name}">
  <meta property="og:title" content="${TITLE}">
  <meta property="og:description" content="${DESCRIPTION}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${BASE}/images/logo-amado.webp">
  <script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:#fffaf3;color:#1b1714;line-height:1.55}
    a{color:inherit}
    ${SITE_HEADER_STYLES}
    .crumbs{max-width:1200px;margin:0 auto;padding:1rem 1rem 0;color:#6b6157;font-size:.85rem}
    .crumbs a{color:#a94e3d;text-decoration:none}
    main{max-width:1200px;margin:0 auto;padding:1rem 1rem 3rem}
    .intro{padding:1.5rem 0 1rem}
    .eyebrow{color:#b4442a;font-size:.72rem;font-weight:850;letter-spacing:.1em;text-transform:uppercase}
    h1{margin-top:.35rem;font-family:Georgia,"Times New Roman",serif;font-size:clamp(2rem,6vw,3.4rem);line-height:1.02;letter-spacing:-.03em}
    .lead{max-width:62ch;margin-top:.8rem;color:#574d45}
    .legend{list-style:none;margin-top:1rem;display:flex;flex-wrap:wrap;gap:.35rem 1.2rem;color:#574d45;font-size:.88rem}
    .legend li{display:flex;align-items:baseline;gap:.45rem}
    .dot{flex:0 0 auto;display:inline-block;width:.7rem;height:.7rem;border-radius:50%}
    .dot-now{background:#1f8a5b}.dot-order{background:#c9861c}
    .jump{display:flex;flex-wrap:wrap;gap:.5rem;margin:1.25rem 0 .5rem}
    .jump a{padding:.5rem .8rem;border:1px solid rgba(27,23,20,.2);border-radius:999px;background:#fff;text-decoration:none;font-size:.85rem;font-weight:700}
    .group{padding-top:2.25rem;scroll-margin-top:1rem}
    .group-head h2{font-family:Georgia,"Times New Roman",serif;font-size:clamp(1.45rem,4vw,2rem);line-height:1.15}
    .group-head p{color:#6b6157;margin-top:.2rem}
    .themes{display:grid;gap:.8rem;margin-top:1rem}
    .theme{padding:1.1rem;background:#fff;border:1px solid #e6dccf;border-radius:.9rem;scroll-margin-top:1rem}
    .theme h3{font-size:1.15rem;line-height:1.2}
    .theme h3 a{text-decoration:none}
    .theme h3 a:hover{text-decoration:underline;text-underline-offset:.15em}
    .theme-counts{display:flex;flex-wrap:wrap;gap:.45rem;margin-top:.65rem}
    .theme-counts a{display:inline-flex;align-items:center;gap:.25rem;min-height:40px;padding:.35rem .55rem;border-radius:.55rem;text-decoration:none;font-size:.8rem;white-space:nowrap}
    .count-now{background:#e5f4ec;color:#145c3c}
    .count-order{background:#fbf0dc;color:#7a4f0c}
    .theme-counts a:not(.count-now):not(.count-order){background:#f0e8dc}
    .subtopics{list-style:none;display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.75rem}
    .subtopics a{display:inline-block;padding:.3rem .6rem;border:1px solid #e6dccf;border-radius:999px;color:#574d45;text-decoration:none;font-size:.8rem}
    .subtopics a:hover{background:#f6efe5}
    .theme-muted{background:#f8f3eb}
    .theme-note{margin-top:.35rem;color:#6b6157;font-size:.88rem}
    .closing{margin-top:2.75rem;padding:1.4rem;background:#1b1714;color:#fff8f0;border-radius:1rem}
    .closing h2{font-family:Georgia,"Times New Roman",serif;font-size:1.5rem}
    .closing p{margin:.4rem 0 1rem;color:rgba(255,248,240,.75)}
    .closing a{display:inline-flex;min-height:44px;align-items:center;padding:.65rem 1rem;border-radius:.6rem;background:#ef6844;color:#1b1714;font-weight:800;text-decoration:none}
    @media(min-width:720px){.theme-counts a{padding:.4rem .7rem;font-size:.86rem}.themes{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(min-width:1080px){.themes{grid-template-columns:repeat(3,minmax(0,1fr))}}
    ${FOOTER_STYLES}
    ${WA_FLOAT_STYLES}
  </style>
</head>
<body>
  ${siteHeaderHtml({ current: 'temas' })}
  <nav class="crumbs" aria-label="Migas de pan"><a href="/">Inicio</a> › Todos los temas</nav>
  <main>
    <section class="intro">
      <p class="eyebrow">Catálogo completo</p>
      <h1>Todos los temas</h1>
      <p class="lead">Elegí un tema para ver sus libros, o entrá directo a un subtema. En cada uno separamos lo que tenemos en stock de lo que conseguimos por encargo.</p>
      ${legend}
      <nav class="jump" aria-label="Ir a un grupo de temas">
        ${groups.map(group => `<a href="#${escapeHtml(group.id)}">${escapeHtml(group.title)}</a>`).join('')}
      </nav>
    </section>
    ${groups.map(group => `<section class="group" id="${escapeHtml(group.id)}" aria-labelledby="${escapeHtml(group.id)}-title">
      <div class="group-head">
        <h2 id="${escapeHtml(group.id)}-title">${escapeHtml(group.title)}</h2>
        ${group.intro ? `<p>${escapeHtml(group.intro)}</p>` : ''}
      </div>
      <div class="themes">
        ${group.themes.map(themeCardHtml).join('')}
      </div>
    </section>`).join('\n    ')}
    ${catchAllHtml(catchAll)}
    <section class="closing">
      <h2>¿No encontrás el tema o el libro?</h2>
      <p>Contanos qué buscás: título, autor, ISBN o una foto. Lo buscamos por encargo, también agotados e importados.</p>
      <a href="/pedir-libro/">Pedir un libro</a>
    </section>
  </main>
  ${footerHtml(undefined, canonical)}
  ${waFloatHtml(undefined, canonical)}
  ${SITE_HEADER_SCRIPT}
</body>
</html>`;
}

export async function onRequest(ctx) {
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    const cacheKey = new Request(new URL(PATH, ctx.request.url).toString());
    if (cache) {
        const cached = await cache.match(cacheKey).catch(() => null);
        if (cached) return cached;
    }

    const categoryData = await fetchCategoryMap(ctx);
    if (!categoryData) {
        return new Response('<!doctype html><html lang="es"><head><meta charset="UTF-8"><meta name="robots" content="noindex"><title>Temas no disponibles — Amado Libros</title></head><body><main><h1>Estamos actualizando los temas</h1><p><a href="/catalogo">Ir al catálogo</a></p></main></body></html>', {
            status: 503,
            headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store', 'Retry-After': '300' },
        });
    }
    const counts = await loadCounts(ctx, categoryData.items);
    const { groups, catchAll } = buildThemeGroups(categoryData.categories, counts);
    const response = new Response(renderTemasPage({ groups, catchAll, hasSplit: Boolean(counts) }), {
        headers: {
            'Content-Type': 'text/html;charset=UTF-8',
            'Cache-Control': `public, max-age=${HTML_CACHE_SECONDS}`,
        },
    });
    // Sólo se guarda la versión completa: una degradada (sin contadores)
    // no debe quedar pegada en el borde.
    if (cache && counts && typeof ctx?.waitUntil === 'function') {
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
}
