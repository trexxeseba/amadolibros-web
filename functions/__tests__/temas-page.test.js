// /temas: mapa de todos los temas, con disponible ahora vs por encargo.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildThemeGroups,
    catalogFilterHref,
    countAvailabilityByCategory,
    onRequest,
    themeHref,
} from '../temas.js';
import { CATALOG_URL, PAUSED_MANIFEST_URL, R2_BASE } from '../_shared/catalog.js';
import { STATIC_SITEMAP_PAGES } from '../sitemap-pages.xml.js';

const CATALOG = {
    items: [
        { id: 'MLU1', title: 'Historia del Uruguay', author: 'A', isbn: '9789974000011', status: 'active', available_quantity: 2 },
        // Misma edición publicada dos veces: cuenta una sola, igual que /catalogo.
        { id: 'MLU2', title: 'Historia del Uruguay', author: 'A', isbn: '9789974000011', status: 'active', available_quantity: 1 },
        { id: 'MLU3', title: 'Sin stock', author: 'B', isbn: '9789974000028', status: 'active', available_quantity: 0 },
        { id: 'MLU4', title: 'Manga uno', author: 'C', isbn: '9789974000035', status: 'active', available_quantity: 1 },
        { id: 'MLU5', title: 'Sin tema', author: 'D', isbn: '9789974000042', status: 'active', available_quantity: 1 },
    ],
};

const PAUSED_MANIFEST = {
    schema_version: 1,
    current: { version: 'v1', index_key: 'stock1-preview/index.json', block_prefix: 'stock1-preview/blocks', block_count: 1 },
};

const PAUSED_INDEX = {
    schema_version: 1,
    fields: ['id', 'title', 'author', 'isbn', 'image'],
    derived_fields: { slug: 'slugify-v1', status: 'paused', block: 'numeric-id-mod-block-count' },
    block_count: 1,
    items: [
        ['MLU6', 'Historia de Roma', 'E', '9789974000059', ''],
        ['MLU7', 'Historia de Grecia', 'F', '9789974000066', ''],
    ],
};

const CATEGORIES = {
    categories: [
        {
            id: 'historia', name: 'Historia', count: 5,
            subcategories: [
                { id: 'historia-mundial', name: 'Historia mundial', count: 2 },
                { id: 'historia-argentina-uruguay', name: 'Historia argentina y uruguaya', count: 3 },
            ],
        },
        { id: 'comics-manga', name: 'Cómics y manga', count: 1, subcategories: [] },
        { id: 'psicologia', name: 'Psicología', count: 0, subcategories: [] },
        { id: 'tema-nuevo', name: 'Tema nuevo', count: 1, subcategories: [] },
        { id: 'otros-libros', name: 'Otros libros', count: 1, subcategories: [] },
    ],
    items: {
        MLU1: [['historia', 'historia-argentina-uruguay']],
        MLU2: [['historia', 'historia-argentina-uruguay']],
        MLU3: [['historia']],
        MLU4: [['comics-manga']],
        MLU5: [['otros-libros']],
        MLU6: [['historia', 'historia-mundial']],
        MLU7: [['historia', 'historia-mundial'], ['tema-nuevo']],
    },
};

function context(url = 'https://amadolibros.com/temas', appEnv = 'preview') {
    return { request: new Request(url), params: {}, env: { APP_ENV: appEnv }, waitUntil() {} };
}

function installCache({ catalog = CATALOG } = {}) {
    globalThis.caches = {
        default: {
            async match(request) {
                if (request.url === CATALOG_URL) return catalog ? Response.json(catalog) : null;
                if (request.url === PAUSED_MANIFEST_URL) return Response.json(PAUSED_MANIFEST);
                if (request.url === `${R2_BASE}/${PAUSED_MANIFEST.current.index_key}`) return Response.json(PAUSED_INDEX);
                if (request.url.endsWith('/data/active-categories.json')) return Response.json(CATEGORIES);
                return null;
            },
            async put() {},
        },
    };
}

test('cuenta disponibles y por encargo con la misma deduplicación que /catalogo', () => {
    const counts = countAvailabilityByCategory({
        activeItems: CATALOG.items.filter(b => b.status === 'active' && b.available_quantity > 0),
        pausedItems: PAUSED_INDEX.items.map(([id, title, author, isbn]) => ({ id, title, author, isbn, status: 'paused' })),
        categoryItems: CATEGORIES.items,
    });
    assert.deepEqual(counts.get('historia'), { available: 1, order: 2 });
    assert.deepEqual(counts.get('comics-manga'), { available: 1, order: 0 });
    assert.deepEqual(counts.get('tema-nuevo'), { available: 0, order: 1 });
});

test('agrupa las categorías existentes, oculta las vacías y no pierde ninguna', () => {
    const { groups, catchAll } = buildThemeGroups(CATEGORIES.categories, null);
    const ids = groups.flatMap(group => group.themes.map(theme => theme.id));
    assert.ok(ids.includes('historia'));
    assert.ok(ids.includes('comics-manga'));
    assert.ok(ids.includes('tema-nuevo'), 'una categoría no prevista cae en "Más temas"');
    assert.ok(!ids.includes('psicologia'), 'sin libros no se muestra');
    assert.ok(!ids.includes('otros-libros'), 'otros-libros no es un tema');
    assert.deepEqual(catchAll.map(theme => theme.id), ['otros-libros']);
    const historia = groups.flatMap(group => group.themes).find(theme => theme.id === 'historia');
    assert.deepEqual(historia.subcategories.map(sub => sub.id), ['historia-argentina-uruguay', 'historia-mundial']);
});

test('los enlaces usan landing cuando existe y el filtro del catálogo si no', () => {
    assert.equal(themeHref('psicologia'), '/libros/psicologia');
    assert.equal(themeHref('historia'), '/catalogo?categoria=historia');
    assert.equal(
        catalogFilterHref('historia', { availability: 'encargo' }),
        '/catalogo?categoria=historia&disponibilidad=encargo',
    );
});

test('renderiza /temas con disponibilidad separada, subtemas y datos estructurados', async () => {
    installCache();
    const response = await onRequest(context());
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<h1>Todos los temas<\/h1>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/www\.amadolibros\.com\/temas">/);
    assert.match(html, /href="\/catalogo\?categoria=historia&amp;disponibilidad=disponibles"><strong>1<\/strong> disponibles ahora/);
    assert.match(html, /href="\/catalogo\?categoria=historia&amp;disponibilidad=encargo"><strong>2<\/strong> por encargo/);
    assert.match(html, /href="\/catalogo\?categoria=historia&amp;subcategoria=historia-mundial">Historia mundial</);
    assert.match(html, /Fuera de los temas/);
    assert.match(html, /"@type":"CollectionPage"/);
    assert.match(html, /"@type":"BreadcrumbList"/);
    assert.match(response.headers.get('cache-control'), /max-age=900/);
});

test('sin catálogo se degrada a los totales, nunca a un error', async () => {
    installCache({ catalog: null });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('nope', { status: 503 });
    try {
        const response = await onRequest(context());
        assert.equal(response.status, 200);
        const html = await response.text();
        assert.match(html, /href="\/catalogo\?categoria=historia">5 títulos</);
        assert.doesNotMatch(html, /disponibles ahora<\/a>/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('/temas entra en el sitemap de páginas', () => {
    assert.ok(STATIC_SITEMAP_PAGES.includes('https://www.amadolibros.com/temas'));
});
