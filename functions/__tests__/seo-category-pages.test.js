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
    id: category.kind === 'tarot-decks' ? 'MLU624123456' : `MLU${index + 1}`,
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
    categories: SEO_CATEGORIES
        .filter(category => !category.classificationId && !category.classificationIds)
        .map(category => ({
            id: category.id,
            name: category.name,
            count: category.id === 'psicologia' ? 791
                : category.id === 'religion-espiritualidad' ? 3
                    : category.id === 'esoterismo-tarot' ? 3
                        : 1,
            subcategories: category.id === 'religion-espiritualidad'
                ? [
                    { id: 'biblia', name: 'Biblia', count: 1 },
                    { id: 'reina-valera', name: 'Reina-Valera', count: 1 },
                ]
                : category.id === 'esoterismo-tarot'
                    ? [{ id: 'tarot-oraculos', name: 'Tarot y oráculos', count: 1 }]
                : [],
        })),
    items: Object.fromEntries(ITEMS.map((item, index) => [
        item.id,
        SEO_CATEGORIES[index].classificationIds
            ? ['religion-espiritualidad', SEO_CATEGORIES[index].classificationIds[0]]
            : SEO_CATEGORIES[index].classificationId
                ? [
                    SEO_CATEGORIES[index].id.startsWith('esoterismo-tarot/')
                        ? 'esoterismo-tarot'
                        : 'religion-espiritualidad',
                    SEO_CATEGORIES[index].classificationId,
                ]
                : [SEO_CATEGORIES[index].id],
    ])),
};

function context(path, appEnv = 'production', search = '') {
    return {
        request: new Request(`https://${appEnv === 'preview' ? 'preview.example' : 'www.amadolibros.com'}/libros/${path}${search}`),
        params: { path: path ? path.split('/') : [] },
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

test('la allowlist contiene las categorías base y las verticales comerciales aprobadas', () => {
    assert.equal(SEO_CATEGORIES.length, 11);
    assert.equal(new Set(SEO_CATEGORIES.map(category => category.id)).size, 11);
    for (const category of SEO_CATEGORIES) {
        assert.match(category.title, /Uruguay.*\| Amado Libros$/);
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
    const psychologyItem = ITEMS.find((_, index) => SEO_CATEGORIES[index].id === 'psicologia');
    const response = await categoryRequest(context('psicologia'));
    const html = await response.text();

    assert.match(html, /Libro de prueba Psicología/);
    assert.doesNotMatch(html, /Libro de prueba Infantil y juvenil/);
    assert.match(html, /<section class="books-grid"/);
    assert.ok(html.includes(`href="https://www.amadolibros.com/libro/${psychologyItem.id}/`));
    assert.ok(html.includes(`/book-cover/${psychologyItem.id}/cover.jpg`));
    assert.match(html, /srcset="[^"]+240w,[^"]+360w,[^"]+480w"/);
    assert.match(html, /<strong>1 título disponible ahora\.<\/strong> Los 791 títulos informados en la portada incluyen disponibles y libros que podemos buscar por encargo\./);
});

test('Biblias une Biblia y Reina-Valera, mientras Reina-Valera conserva su intención propia', async () => {
    const biblesResponse = await categoryRequest(context('biblias'));
    const biblesHtml = await biblesResponse.text();
    const rvrResponse = await categoryRequest(context('biblias/reina-valera'));
    const rvrHtml = await rvrResponse.text();

    assert.match(biblesHtml, /Libro de prueba Biblias/);
    assert.match(biblesHtml, /Libro de prueba Reina-Valera/);
    assert.match(rvrHtml, /Libro de prueba Reina-Valera/);
    assert.doesNotMatch(rvrHtml, /Libro de prueba Biblias</);
    assert.match(rvrHtml, /<link rel="canonical" href="https:\/\/www\.amadolibros\.com\/libros\/biblias\/reina-valera">/);
    assert.match(rvrHtml, /<a href="\/libros\/biblias">Biblias<\/a> › <span>Reina-Valera<\/span>/);
});

test('Religión excluye Biblias de su grilla y las enlaza como colecciones separadas', async () => {
    const response = await categoryRequest(context('religion-espiritualidad'));
    const html = await response.text();

    assert.match(html, /Libro de prueba Religión y espiritualidad/);
    assert.doesNotMatch(html, /Libro de prueba Biblias</);
    assert.doesNotMatch(html, /Libro de prueba Reina-Valera/);
    assert.match(html, /href="\/libros\/biblias"/);
    assert.match(html, /href="\/libros\/biblias\/reina-valera"/);
});

test('las landings bíblicas incluyen guía factual y una promesa logística condicionada', async () => {
    const response = await categoryRequest(context('biblias'));
    const html = await response.text();

    assert.match(html, /Cómo elegir una Biblia/);
    assert.match(html, /Traducción o tradición/);
    assert.match(html, /pueden coordinarse para entrega en el día en Montevideo, según zona, horario y confirmación/);
    assert.match(html, /El envío cuesta \$250/);
    assert.match(html, /es gratis en compras desde \$1\.500/);
    assert.match(html, /La entrega rápida no se promete hasta verificar esos datos/);
    assert.doesNotMatch(html, /entrega gratis en el día en Uruguay/i);
});

test('la landing de mazos muestra sólo mazos de tarot verificados y su promesa comercial condicionada', async () => {
    const response = await categoryRequest(context('esoterismo-tarot/mazos'));
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Mazos de tarot en Uruguay con entrega hoy en Montevideo/);
    assert.match(html, /Libro de prueba Mazos de tarot/);
    assert.match(html, /Los mazos con stock pueden coordinarse para entrega en el día/);
    assert.match(html, /Envío \$250/);
    assert.match(html, /Atención personalizada/);
    assert.match(html, /Cómo elegir un mazo de tarot sin equivocarte de edición/);
    assert.match(html, /"name":"Mazo de tarot"/);
});

test('las landings bíblicas conservan el contrato responsive para celular', async () => {
    const response = await categoryRequest(context('biblias'));
    const html = await response.text();

    assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
    assert.match(html, /\.books-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
    assert.match(html, /@media\(max-width:620px\)\{\.header-inner/);
    assert.match(html, /\.header-search\{grid-column:1\/-1;grid-row:2/);
    assert.match(html, /\.bible-guide-head\{flex-direction:column\}/);
    assert.match(html, /\.bible-cross-link\{width:100%;justify-content:center\}/);
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

test('la portada enlaza las landings limpias, incluyendo Biblias y Reina-Valera, sin filtros', () => {
    const file = fileURLToPath(new URL('../../astro-front/src/components/CategoryAccess.astro', import.meta.url));
    const source = readFileSync(file, 'utf8');

    assert.match(source, /href={`\/libros\/\$\{encodeURIComponent\(cat\.id\)\}`}/);
    assert.match(source, /number\.format\(cat\.count\)/);
    assert.doesNotMatch(source, /subcategoria=biblia/);
    assert.doesNotMatch(source, /subcategoria=reina-valera/);
    assert.doesNotMatch(source, /href="\/biblias"|href="\/reina-valera"/);
    for (const category of SEO_CATEGORIES.filter(entry => !entry.classificationId && !entry.classificationIds)) {
        assert.ok(source.includes(`'${category.id}'`), category.id);
    }
    assert.match(source, /href: '\/libros\/biblias'/);
    assert.match(source, /href: '\/libros\/biblias\/reina-valera'/);
});

test('el sitemap de categorías publica todas las landings SEO', async () => {
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
