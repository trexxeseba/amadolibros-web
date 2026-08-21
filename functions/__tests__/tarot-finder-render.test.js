// TAROT-FINDER-1 — tests de render sobre el HTML real que devuelve
// functions/libros/[[path]].js: un solo H1, sin canonical/URLs nuevas,
// robots intactos, el resto de categorías no lleva Finder, "Ver todo"
// sigue presente, y la página es usable sin JavaScript.
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as categoryRequest } from '../libros/[[path]].js';
import {
    CATALOG_URL,
    PAUSED_MANIFEST_URL,
    PRODUCTION_MANIFEST_URL,
} from '../_shared/catalog.js';
import { SEO_CATEGORIES } from '../_shared/seo-categories.js';
import { TAROT_MERCH_TAGS } from '../_shared/tarot-merch-tags.js';

// MLU real y estable del artefacto TAROT-MERCH-TAGS-1 (tarot, Marsella,
// mazo_mas_guia) — se usa como fixture para que buildTarotFinderDataset()
// tenga al menos un candidato real y el Finder efectivamente renderice.
// Si algún día este MLU deja de existir/clasificar así, el test explícito
// de abajo lo va a decir con un mensaje claro en vez de fallar en silencio.
const REAL_TAROT_MLU = 'MLU1418182736';
const realTag = TAROT_MERCH_TAGS.find(row => row.id === REAL_TAROT_MLU);

test('fixture: el MLU real usado en estos tests sigue clasificado como mazo de tarot activo', () => {
    assert.ok(realTag, `${REAL_TAROT_MLU} ya no existe en TAROT_MERCH_TAGS — actualizar el fixture de tarot-finder-render.test.js`);
    assert.equal(realTag.primary_type, 'tarot');
    assert.equal(realTag.format, 'mazo');
});

const ITEMS = SEO_CATEGORIES.map((category, index) => {
    if (category.id === 'esoterismo-tarot') {
        return {
            id: REAL_TAROT_MLU,
            title: 'Tarot de Marsella de prueba',
            author: null,
            price: 2200,
            status: 'active',
            available_quantity: 3,
            thumbnail: 'https://images.example/tarot.jpg',
            pictures: [],
            start_time: '2026-07-01T00:00:00Z',
        };
    }
    return {
        id: `MLU${index + 1}`,
        title: `Libro de prueba ${category.name}`,
        author: `Autor ${index + 1}`,
        price: 1000 + index,
        status: 'active',
        available_quantity: 2,
        thumbnail: `https://images.example/${index + 1}.jpg`,
        pictures: [],
        start_time: '2026-07-01T00:00:00Z',
    };
});

const CATEGORY_DATA = {
    categories: SEO_CATEGORIES.map(category => ({
        id: category.id,
        name: category.name,
        count: 1,
        subcategories: [],
    })),
    // ITEMS[index] corresponde siempre a SEO_CATEGORIES[index] — mismo
    // orden de construcción arriba, así que el mapeo id->categoría es
    // directo por índice.
    items: Object.fromEntries(
        ITEMS.map((item, index) => [item.id, [SEO_CATEGORIES[index].id]]),
    ),
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
                if ([PRODUCTION_MANIFEST_URL, PAUSED_MANIFEST_URL].includes(request.url)) {
                    return Response.json({ schema_version: 0 });
                }
                return null;
            },
            async put() {},
        },
    };
});

async function html(path, appEnv = 'production', search = '') {
    const response = await categoryRequest(context(path, appEnv, search));
    return { response, html: await response.text() };
}

// ── Un solo H1 ────────────────────────────────────────────────────────────

test('la página de esoterismo-tarot con Finder tiene exactamente un <h1>', async () => {
    const { html: body } = await html('esoterismo-tarot');
    const h1Count = (body.match(/<h1[ >]/g) || []).length;
    assert.equal(h1Count, 1, 'el CTA "Encontrá tu mazo" usa <h2>, no <h1> — el único <h1> sigue siendo el de la categoría');
    assert.match(body, /<h1>Libros de esoterismo y tarot en Uruguay<\/h1>/);
});

// ── Sin canonical ni URLs indexables nuevas ──────────────────────────────

test('el Finder no introduce un canonical nuevo: sigue siendo exactamente /libros/esoterismo-tarot', async () => {
    const { html: body } = await html('esoterismo-tarot');
    const canonicals = [...body.matchAll(/<link rel="canonical" href="([^"]+)">/g)].map(m => m[1]);
    assert.deepEqual(canonicals, ['https://www.amadolibros.com/libros/esoterismo-tarot']);
});

test('el Finder no introduce ningún <a href> a rutas propias (/tarot-finder/, /tarot/, querystrings de respuestas)', async () => {
    const { html: body } = await html('esoterismo-tarot');
    const hrefs = [...body.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
    for (const href of hrefs) {
        assert.doesNotMatch(href, /\/tarot-finder\//, `href indexable inesperado: ${href}`);
        assert.doesNotMatch(href, /\/tarot\/(rider-waite|marsella|lenormand|thoth)/, `href indexable inesperado: ${href}`);
        assert.doesNotMatch(href, /\?(sistema|idioma|guia|tradicion|experiencia)=/, `querystring de respuestas indexable: ${href}`);
    }
});

test('el dataset del Finder viaja embebido en un <script type="application/json">, no en una URL propia', async () => {
    const { html: body } = await html('esoterismo-tarot');
    assert.match(body, /<script type="application\/json" id="tarot-finder-dataset">/);
    // Nunca un <link> ni un fetch a un endpoint /api/tarot-finder o similar.
    assert.doesNotMatch(body, /\/api\/tarot-finder/);
});

// ── Robots intactos en Preview ────────────────────────────────────────────

test('robots de Preview siguen noindex,follow con el Finder presente', async () => {
    const { html: body } = await html('esoterismo-tarot', 'preview');
    assert.match(body, /<meta name="robots" content="noindex, follow">/);
});

test('robots en producción siguen index,follow con el Finder presente', async () => {
    const { html: body } = await html('esoterismo-tarot', 'production');
    assert.match(body, /<meta name="robots" content="index, follow">/);
});

// ── El resto de categorías no lleva Finder ───────────────────────────────

test('ninguna categoría distinta de esoterismo-tarot incluye el Finder', async () => {
    for (const category of SEO_CATEGORIES) {
        if (category.id === 'esoterismo-tarot') continue;
        const { html: body } = await html(category.id);
        assert.doesNotMatch(body, /id="tarot-finder-cta"/, category.id);
        assert.doesNotMatch(body, /tarot-finder\.js/, category.id);
        assert.doesNotMatch(body, /tarot-finder-dataset/, category.id);
    }
});

// ── "Ver todo" sigue presente ────────────────────────────────────────────

test('"Ver todo" (la grilla paginada existente) sigue presente y funcional con el Finder activo', async () => {
    const { html: body } = await html('esoterismo-tarot');
    assert.match(body, /<h2>Ver todo<\/h2>/);
    assert.match(body, /<section class="books-grid"/);
});

// ── Funciona sin JavaScript ───────────────────────────────────────────────

test('sin JS: el CTA "Empezar" es un <button> real (no depende de un href de JS) y hay un <noscript> con salida por WhatsApp', async () => {
    const { html: body } = await html('esoterismo-tarot');
    assert.match(body, /<button type="button" id="tarot-finder-start"/);
    assert.match(body, /<noscript>[\s\S]*wa\.me\/59899841325[\s\S]*<\/noscript>/);
});

test('FIX 4: el botón "Empezar" no declara aria-haspopup — el Finder se expande inline, no abre popup/menú/diálogo', async () => {
    const { html: body } = await html('esoterismo-tarot');
    assert.doesNotMatch(body, /aria-haspopup/);
});

test('sin JS: el resto de módulos, WhatsApp flotante y footer están en el HTML servidor, no dependen de tarot-finder.js', async () => {
    const { html: body } = await html('esoterismo-tarot');
    assert.match(body, /class="wa-float"/, 'el flotante de WhatsApp ya viene renderizado por el servidor');
    assert.match(body, /Amado Libros/); // footer
    assert.match(body, /id="tarot-finder-app" hidden/, 'el contenedor del Finder arranca oculto en el HTML crudo, sin esperar a JS para no mostrarse roto');
});

test('el script /tarot-finder.js se carga con defer, nunca bloqueante', async () => {
    const { html: body } = await html('esoterismo-tarot');
    assert.match(body, /<script src="\/tarot-finder\.js" defer><\/script>/);
});

// ── Sin candidatos reales, el Finder no aparece (mismo criterio que los módulos merchandising) ──

test('si el universo de esoterismo-tarot no tiene ningún candidato clasificado, el Finder no se renderiza', async () => {
    // Reusa el harness genérico (sin el MLU real fijado) para simular el
    // caso "0 candidatos": ningún id sintético matchea TAROT_MERCH_TAGS.
    const genericItems = SEO_CATEGORIES.map((category, index) => ({
        id: `MLU${900 + index}`,
        title: `Libro genérico ${category.name}`,
        author: null,
        price: 1500,
        status: 'active',
        available_quantity: 2,
        thumbnail: '',
        pictures: [],
        start_time: '2026-07-01T00:00:00Z',
    }));
    const genericCategoryData = {
        categories: SEO_CATEGORIES.map(category => ({ id: category.id, name: category.name, count: 1, subcategories: [] })),
        items: Object.fromEntries(genericItems.map((item, index) => [item.id, [SEO_CATEGORIES[index].id]])),
    };
    globalThis.caches = {
        default: {
            async match(request) {
                if (request.url.endsWith('/data/active-categories.json')) return Response.json(genericCategoryData);
                if (request.url === CATALOG_URL) return Response.json({ total: genericItems.length, items: genericItems });
                if ([PRODUCTION_MANIFEST_URL, PAUSED_MANIFEST_URL].includes(request.url)) return Response.json({ schema_version: 0 });
                return null;
            },
            async put() {},
        },
    };
    const response = await categoryRequest(context('esoterismo-tarot'));
    const body = await response.text();
    assert.doesNotMatch(body, /id="tarot-finder-cta"/);
    assert.doesNotMatch(body, /tarot-finder\.js/);
});
