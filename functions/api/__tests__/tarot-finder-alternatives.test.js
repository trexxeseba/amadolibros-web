// TAROT-FINDER-UX-2 (gate de performance): endpoint GET same-origin que
// carga el pool "por encargo" bajo demanda — nunca embebido en el HTML
// inicial (ver functions/libros/[[path]].js y tarot-finder-alternatives.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as alternativesRequest } from '../tarot-finder-alternatives.js';
import { PAUSED_MANIFEST_URL, PRODUCTION_MANIFEST_URL, R2_BASE } from '../../_shared/catalog.js';
import { TAROT_MERCH_TAGS } from '../../_shared/tarot-merch-tags.js';

// MLUs reales y estables, ya clasificados como pausados en TAROT_MERCH_TAGS
// — mismo criterio que tarot-finder-render.test.js: si algún día dejan de
// existir/clasificar así, el test de fixture de abajo lo dice con un
// mensaje claro en vez de fallar en silencio en otro lado.
const TAROT_A = 'MLU603904665'; // Tarot de A.E. Waite — mazo_mas_guia
const TAROT_B = 'MLU605126810'; // After Tarot — mazo_mas_guia
const ORACULO_PAUSED = 'MLU601460832'; // Pequeño Oráculo de los Ángeles

const tagA = TAROT_MERCH_TAGS.find(r => r.id === TAROT_A);
const tagB = TAROT_MERCH_TAGS.find(r => r.id === TAROT_B);
const tagOraculo = TAROT_MERCH_TAGS.find(r => r.id === ORACULO_PAUSED);

test('fixtures: los MLUs pausados reales usados en estos tests siguen clasificados como se espera', () => {
    assert.ok(tagA, `${TAROT_A} ya no existe en TAROT_MERCH_TAGS — actualizar el fixture`);
    assert.equal(tagA.primary_type, 'tarot');
    assert.ok(tagB, `${TAROT_B} ya no existe en TAROT_MERCH_TAGS — actualizar el fixture`);
    assert.equal(tagB.primary_type, 'tarot');
    assert.ok(tagOraculo, `${ORACULO_PAUSED} ya no existe en TAROT_MERCH_TAGS — actualizar el fixture`);
    assert.equal(tagOraculo.primary_type, 'oraculo');
});

const PAUSED_MANIFEST_CURRENT = {
    version: 'v1',
    index_key: 'stock1-preview/index.json',
    block_prefix: 'stock1-preview/blocks',
    block_count: 1,
};

const CATEGORY_DATA = {
    categories: [{ id: 'esoterismo-tarot', name: 'Esoterismo y tarot', count: 3, subcategories: [] }],
    items: {
        [TAROT_A]: ['esoterismo-tarot'],
        [TAROT_B]: ['esoterismo-tarot'],
        [ORACULO_PAUSED]: ['esoterismo-tarot'],
    },
};

const PAUSED_INDEX = {
    schema_version: 1,
    fields: ['id', 'title', 'author', 'isbn', 'image'],
    derived_fields: { slug: 'slugify-v1', status: 'paused', block: 'numeric-id-mod-block-count' },
    block_count: 1,
    items: [
        [TAROT_A, tagA.title, tagA.author || '', tagA.isbn || '', ''],
        [TAROT_B, tagB.title, tagB.author || '', tagB.isbn || '', ''],
        [ORACULO_PAUSED, tagOraculo.title, tagOraculo.author || '', tagOraculo.isbn || '', ''],
    ],
};

function installCacheHits(overrides = {}) {
    const hits = {
        [`https://x/data/active-categories.json`]: CATEGORY_DATA,
        [PAUSED_MANIFEST_URL]: { schema_version: 1, current: PAUSED_MANIFEST_CURRENT, previous: null },
        [PRODUCTION_MANIFEST_URL]: { schema_version: 1, current: PAUSED_MANIFEST_CURRENT, previous: null },
        [`${R2_BASE}/${PAUSED_MANIFEST_CURRENT.index_key}`]: PAUSED_INDEX,
        ...overrides,
    };
    globalThis.caches = {
        default: {
            async match(request) {
                if (request.url.endsWith('/data/active-categories.json')) {
                    const key = Object.keys(hits).find(k => k.endsWith('/data/active-categories.json'));
                    return key ? Response.json(hits[key]) : null;
                }
                return request.url in hits ? Response.json(hits[request.url]) : null;
            },
            async put() {},
        },
    };
}

function request(query, { method = 'GET' } = {}) {
    return new Request(`https://www.amadolibros.com/api/tarot-finder-alternatives${query}`, { method });
}

function context(req, appEnv = 'production') {
    return { request: req, params: {}, env: { APP_ENV: appEnv }, data: {}, waitUntil() {} };
}

test.beforeEach(() => {
    installCacheHits();
    globalThis.fetch = async () => new Response('not found', { status: 404 });
});

test.afterEach(() => {
    delete globalThis.caches;
    delete globalThis.fetch;
});

// ── Método / validación estricta de parámetros ───────────────────────────

test('rechaza método distinto de GET', async () => {
    const response = await alternativesRequest(context(request('', { method: 'POST' })));
    assert.equal(response.status, 405);
});

test('rechaza un parámetro no reconocido, aunque el resto sea válido', async () => {
    const response = await alternativesRequest(context(request('?system=tarot&foo=bar')));
    assert.equal(response.status, 400);
});

test('rechaza un parámetro conocido repetido en vez de elegir silenciosamente uno', async () => {
    const response = await alternativesRequest(context(request('?system=tarot&system=oraculo')));
    assert.equal(response.status, 400);
    const data = await response.json();
    assert.match(data.error || '', /repetido/i);
});

test('rechaza un valor fuera de enum para cada parámetro conocido', async () => {
    const cases = ['?intent=cualquier_cosa', '?system=vampiro', '?deckFamily=egipcio', '?language=klingon', '?guide=tal_vez'];
    for (const query of cases) {
        const response = await alternativesRequest(context(request(query)));
        assert.equal(response.status, 400, query);
    }
});

test('nunca acepta texto libre disfrazado de un enum válido (mayúsculas, espacios, inyección)', async () => {
    // Nota: un espacio al FINAL de toda la URL lo recorta el propio parser
    // de URL (WHATWG) antes de llegar acá — por eso el espacio de prueba va
    // en el medio del valor, donde el parser no lo toca.
    const cases = ['?system=Tarot', '?system=ta%20rot', '?system=tarot%00', '?language=espanol<script>'];
    for (const query of cases) {
        const response = await alternativesRequest(context(request(query)));
        assert.equal(response.status, 400, query);
    }
});

test('acepta una combinación válida de parámetros (incluida la ausencia de algunos)', async () => {
    const response = await alternativesRequest(context(request('?system=tarot')));
    assert.equal(response.status, 200);
});

// ── system nunca se relaja (mismo motor canónico) ────────────────────────

test('pedir Tarot nunca devuelve un Oráculo, aunque sea el único pausado con alguna coincidencia', async () => {
    const response = await alternativesRequest(context(request('?system=tarot&language=espanol')));
    const data = await response.json();
    for (const candidate of data.candidates) {
        assert.equal(candidate.primary_type, 'tarot', JSON.stringify(candidate));
    }
});

// ── Nunca precio/stock inventado, máximo 3 ───────────────────────────────

test('ningún candidato devuelto tiene price/stock distinto de null (status=paused siempre)', async () => {
    const response = await alternativesRequest(context(request('?system=tarot')));
    const data = await response.json();
    assert.ok(data.candidates.length > 0, 'la fixture debería producir al menos un candidato');
    for (const candidate of data.candidates) {
        assert.equal(candidate.price, null);
        assert.equal(candidate.stock, null);
        assert.equal(candidate.status, 'paused');
    }
});

test('nunca devuelve más de 3 candidatos', async () => {
    const response = await alternativesRequest(context(request('?system=tarot')));
    const data = await response.json();
    assert.ok(data.candidates.length <= 3);
});

// ── Headers: noindex + cache ──────────────────────────────────────────────

test('headers: X-Robots-Tag noindex,nofollow y Cache-Control cacheable en una respuesta válida', async () => {
    const response = await alternativesRequest(context(request('?system=tarot')));
    assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
    assert.match(response.headers.get('Cache-Control') || '', /public/);
});

// ── Fail-open: infraestructura caída nunca es un 500 ─────────────────────

test('si el catálogo de categorías no responde (infraestructura caída), responde 200 con candidates: [] — nunca 500', async () => {
    installCacheHits({ [`https://x/data/active-categories.json`]: null });
    globalThis.caches.default.match = async () => null; // fuerza MISS total
    globalThis.fetch = async () => new Response('down', { status: 502 });
    const response = await alternativesRequest(context(request('?system=tarot')));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.candidates, []);
});

test('sin ningún parámetro (answers vacío), responde 200 con candidates: [] (no aplica el concepto de "alternativa")', async () => {
    const response = await alternativesRequest(context(request('')));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.candidates, []);
});
