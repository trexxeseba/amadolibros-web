import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { onRequest as categoryRequest } from '../libros/[[path]].js';
import { onRequest as categorySitemapRequest } from '../sitemap-categories.xml.js';
import {
    CATALOG_URL,
    PAUSED_MANIFEST_URL,
    PRODUCTION_MANIFEST_URL,
} from '../_shared/catalog.js';
import { SEO_CATEGORIES } from '../_shared/seo-categories.js';

const ITEMS = SEO_CATEGORIES.map((category, index) => ({
    id: `MLU${index + 1}`,
    title: `Libro de prueba ${category.name}`,
    author: `Autor ${index + 1}`,
    price: 1000 + index,
    status: 'active',
    available_quantity: 2,
    thumbnail: `https://images.example/${index + 1}.jpg`,
    pictures: [],
    start_time: '2026-07-01T00:00:00Z',
}));

const CATEGORY_DATA = {
    categories: SEO_CATEGORIES.map((category, index) => ({
        id: category.id,
        name: category.name,
        count: category.id === 'psicologia' ? 791 : 1,
        subcategories: [],
    })),
    items: Object.fromEntries(ITEMS.map((item, index) => [
        item.id,
        [SEO_CATEGORIES[index].id],
    ])),
};

function context(path, appEnv = 'production', search = '') {
    return {
        request: new Request(`https://${appEnv === 'preview' ? 'preview.example' : 'www.amadolibros.com'}/libros/${path}${search}`),
        params: { path: path ? [path] : [] },
        env: { APP_ENV: appEnv },
        data: {},
        waitUntil() {},
    };
}

test.beforeEach(() => {
    globalThis.caches = {
        default: {
            async match(request) {
                if (request.url.endsWith('/data/active-categories.json')) {
                    return Response.json(CATEGORY_DATA);
                }
                if (request.url === CATALOG_URL) {
                    return Response.json({ total: ITEMS.length, items: ITEMS });
                }
                // Fuerza el fallback seguro al catálogo completo sin red.
                if ([PRODUCTION_MANIFEST_URL, PAUSED_MANIFEST_URL].includes(request.url)) {
                    return Response.json({ schema_version: 0 });
                }
                return null;
            },
            async put() {},
        },
    };
});

test('la allowlist contiene exactamente las ocho categorías SEO aprobadas', () => {
    assert.equal(SEO_CATEGORIES.length, 8);
    assert.equal(new Set(SEO_CATEGORIES.map(category => category.id)).size, 8);
    for (const category of SEO_CATEGORIES) {
        assert.match(category.title, /Uruguay \| Amado Libros$/);
        assert.ok(category.description.length >= 100);
        assert.ok(category.intro.length >= 100);
    }
});

test('cada categoría autorizada responde 200 con SEO y contenido diferenciados', async () => {
    for (const category of SEO_CATEGORIES) {
        const response = await categoryRequest(context(category.id));
        const html = await response.text();

        assert.equal(response.status, 200, category.id);
        assert.ok(html.includes(`<title>${category.title}</title>`), category.id);
        assert.ok(html.includes(`<h1>${category.h1}</h1>`), category.id);
        assert.ok(html.includes(`<link rel="canonical" href="https://www.amadolibros.com/libros/${category.id}">`), category.id);
        assert.match(html, /<meta name="robots" content="index, follow">/);
        assert.match(html, /"@type":"CollectionPage"/);
        assert.match(html, /"@type":"ItemList"/);
        assert.match(html, /"@type":"BreadcrumbList"/);
        assert.ok(html.includes(`Libro de prueba ${category.name}`), category.id);
    }
});

test('la landing filtra productos por la categoría solicitada', async () => {
    const response = await categoryRequest(context('psicologia'));
    const html = await response.text();

    assert.match(html, /Libro de prueba Psicología/);
    assert.doesNotMatch(html, /Libro de prueba Infantil y juvenil/);
    assert.match(html, /<section class="books-grid"/);
    assert.match(html, /href="https:\/\/www\.amadolibros\.com\/libro\/MLU6\//);
    assert.match(html, /\/cdn-cgi\/image\/format=auto[^\"]+\/book-cover\/MLU6\/cover\.jpg/);
    assert.match(html, /srcset="[^"]+240w,[^"]+360w,[^"]+480w"/);
    assert.match(html, /<strong>1 título disponible ahora\.<\/strong> Los 791 títulos informados en la portada incluyen disponibles y libros que podemos buscar por encargo\./);
});

test('una categoría inventada responde 404 real, noindex y sin canonical', async () => {
    const response = await categoryRequest(context('categoria-inventada'));
    const html = await response.text();

    assert.equal(response.status, 404);
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    assert.doesNotMatch(html, /<link rel="canonical"/);
    assert.match(html, /Buscar en el catálogo/);
});

test('preview queda noindex y conserva enlaces internos del mismo preview', async () => {
    const response = await categoryRequest(context('infantil-juvenil', 'preview'));
    const html = await response.text();

    assert.match(html, /<meta name="robots" content="noindex, follow">/);
    assert.match(html, /href="https:\/\/preview\.example\/libro\/MLU1\//);
});

test('parámetros arbitrarios no crean otra landing indexable', async () => {
    const response = await categoryRequest(context('psicologia', 'production', '?orden=precio'));
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /<meta name="robots" content="noindex, follow">/);
    assert.match(html, /<link rel="canonical" href="https:\/\/www\.amadolibros\.com\/libros\/psicologia">/);
});

test('la portada enlaza las ocho landings limpias y no filtros con parámetros', () => {
    const file = fileURLToPath(new URL('../../astro-front/src/components/CategoryAccess.astro', import.meta.url));
    const source = readFileSync(file, 'utf8');

    assert.match(source, /href={`\/libros\/\$\{encodeURIComponent\(cat\.id\)\}`}/);
    assert.doesNotMatch(source, /href={`\/catalogo\?categoria=/);
    assert.match(source, /\{cat\.count\} títulos/);
    assert.match(source, />Disponibles y por encargo<\/span>/);
    for (const category of SEO_CATEGORIES) {
        assert.ok(source.includes(`'${category.id}'`), category.id);
    }
});

test('el sitemap de categorías publica las ocho landings SEO', async () => {
    const response = await categorySitemapRequest({
        request: new Request('https://www.amadolibros.com/sitemap-categories.xml'),
        env: { APP_ENV: 'production' },
        data: {},
        waitUntil() {},
    });
    const xml = await response.text();

    for (const category of SEO_CATEGORIES) {
        assert.ok(xml.includes(`<loc>https://www.amadolibros.com/libros/${category.id}</loc>`), category.id);
    }
});
