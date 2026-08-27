// GW2 (Kit de Lista de Lectura) — validación del endpoint POST /api/list-lookup
// y su integración con el catálogo real (índice compacto activo + pausado)
// y con el Radar de Demanda No Satisfecha (GW1) para las líneas sin match.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { onRequest as listLookup } from '../list-lookup.js';
import { PAUSED_MANIFEST_URL, R2_BASE } from '../../_shared/catalog.js';

const MANIFEST_CURRENT = {
    version: 'v1',
    index_key: 'stock1-preview/index.json',
    active_index_key: 'stock1-preview/active-index.json',
    block_prefix: 'stock1-preview/blocks',
    block_count: 1,
};

const ACTIVE_INDEX = {
    schema_version: 1,
    fields: ['id', 'title', 'author', 'isbn', 'image', 'price', 'available_quantity'],
    derived_fields: { slug: 'slugify-v1', status: 'active' },
    items: [
        ['MLU0001', 'Cien Años De Soledad', 'Gabriel García Márquez', '9789871387861', '', 1200, 3],
    ],
};

const PAUSED_INDEX = {
    schema_version: 1,
    fields: ['id', 'title', 'author', 'isbn', 'image'],
    derived_fields: { slug: 'slugify-v1', status: 'paused', block: 'numeric-id-mod-block-count' },
    block_count: 1,
    items: [
        ['MLU0002', 'El Amor En Los Tiempos Del Cólera', 'Gabriel García Márquez', '', ''],
    ],
};

function installCacheHits(hits) {
    globalThis.caches = {
        default: {
            async match(request) {
                const entry = hits[request.url];
                return entry === undefined ? null : Response.json(entry);
            },
            async put() {},
        },
    };
}

function createD1() {
    const sqlite = new DatabaseSync(':memory:');
    return {
        sqlite,
        prepare(sql) {
            const statement = sqlite.prepare(sql);
            return {
                bind(...args) {
                    return {
                        async first() { return statement.get(...args) || null; },
                        async all() { return { results: statement.all(...args) }; },
                        async run() {
                            const result = statement.run(...args);
                            return { success: true, meta: { changes: Number(result.changes) } };
                        },
                    };
                },
            };
        },
    };
}

async function withDemandRadarSchema(db) {
    await db.prepare(`
    CREATE TABLE IF NOT EXISTS demand_radar_unmatched_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      normalized_query TEXT NOT NULL,
      raw_query TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('catalogo_search','reading_list')),
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      UNIQUE (normalized_query, source)
    )`).bind().run();
    return db;
}

function request(body, { method = 'POST', contentType = 'application/json' } = {}) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const headers = {};
    if (contentType) headers['Content-Type'] = contentType;
    return new Request('https://www.amadolibros.com/api/list-lookup', {
        method,
        headers,
        body: method === 'GET' ? undefined : text,
    });
}

function context(req, { db, waitUntilCalls } = {}) {
    return {
        request: req,
        params: {},
        env: { APP_ENV: 'preview', ORDERS_DB: db },
        data: {},
        waitUntil(promise) {
            if (waitUntilCalls) waitUntilCalls.push(promise);
        },
    };
}

test.beforeEach(() => {
    installCacheHits({
        [PAUSED_MANIFEST_URL]: { schema_version: 1, current: MANIFEST_CURRENT, previous: null },
        [`${R2_BASE}/${MANIFEST_CURRENT.active_index_key}`]: ACTIVE_INDEX,
        [`${R2_BASE}/${MANIFEST_CURRENT.index_key}`]: PAUSED_INDEX,
    });
    globalThis.fetch = async () => new Response('not found', { status: 404 });
});

test.afterEach(() => {
    delete globalThis.fetch;
    delete globalThis.caches;
});

// ── validación de método / content-type / body ───────────────────────────

test('rechaza método distinto de POST', async () => {
    const response = await listLookup(context(request(null, { method: 'GET' })));
    assert.equal(response.status, 405);
});

test('rechaza Content-Type distinto de application/json', async () => {
    const response = await listLookup(context(request('lines=x', { contentType: 'text/plain' })));
    assert.equal(response.status, 415);
});

test('rechaza JSON inválido', async () => {
    const response = await listLookup(context(request('{esto no es json', {})));
    assert.equal(response.status, 400);
});

test('rechaza body sin { lines: string[] }', async () => {
    const response = await listLookup(context(request({ foo: 'bar' })));
    assert.equal(response.status, 400);
});

test('lines vacío o sólo espacios devuelve results: []', async () => {
    const response = await listLookup(context(request({ lines: ['   ', ''] })));
    const data = await response.json();
    assert.deepEqual(data.results, []);
});

// ── matching contra el catálogo real (índice compacto activo + pausado) ──

test('responde matched_active con precio y stock para un título disponible', async () => {
    const response = await listLookup(context(request({ lines: ['Cien Años De Soledad'] })));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.results.length, 1);
    assert.equal(data.results[0].status, 'matched_active');
    assert.equal(data.results[0].match.price, 1200);
    assert.equal(data.results[0].match.stock, 3);
});

test('responde matched_by_encargo sin precio ni stock para un título pausado', async () => {
    const response = await listLookup(context(request({ lines: ['El Amor En Los Tiempos Del Cólera'] })));
    const data = await response.json();
    assert.equal(data.results[0].status, 'matched_by_encargo');
    assert.equal(data.results[0].match.price, null);
    assert.equal(data.results[0].match.stock, null);
});

test('varias líneas en una sola consulta: cada una se resuelve de forma independiente', async () => {
    const response = await listLookup(context(request({
        lines: ['Cien Años De Soledad', 'El Amor En Los Tiempos Del Cólera', 'Un libro que no existe en absoluto'],
    })));
    const data = await response.json();
    assert.equal(data.results.length, 3);
    assert.deepEqual(data.results.map(r => r.status), ['matched_active', 'matched_by_encargo', 'no_match']);
});

test('trunca a MAX_LINES=40 y descarta líneas de más de MAX_LINE_LENGTH', async () => {
    const manyLines = Array.from({ length: 50 }, (_, i) => `línea de consulta número ${i}`);
    const response = await listLookup(context(request({ lines: manyLines })));
    const data = await response.json();
    assert.equal(data.results.length, 40);
});

// ── integración con el Radar de Demanda No Satisfecha (GW1) ──────────────

test('línea sin match dispara recordUnmatchedQuery vía waitUntil (source: reading_list)', async () => {
    const db = await withDemandRadarSchema(createD1());
    const waitUntilCalls = [];
    const response = await listLookup(context(
        request({ lines: ['Un libro que definitivamente no tenemos'] }),
        { db, waitUntilCalls },
    ));
    assert.equal(response.status, 200);
    await Promise.all(waitUntilCalls);

    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'reading_list');
    assert.equal(rows[0].raw_query, 'Un libro que definitivamente no tenemos');
});

test('la misma línea repetida dos veces en una lista sólo registra una vez en el radar (dedup)', async () => {
    const db = await withDemandRadarSchema(createD1());
    const waitUntilCalls = [];
    const response = await listLookup(context(
        request({ lines: ['Un libro que no tenemos', '  UN LIBRO QUE NO TENEMOS  '] }),
        { db, waitUntilCalls },
    ));
    const data = await response.json();
    assert.equal(data.results.length, 2, 'ambas líneas aparecen en la respuesta al usuario');
    await Promise.all(waitUntilCalls);

    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries').all();
    assert.equal(rows.length, 1, 'pero sólo generan una fila en el ledger');
    assert.equal(rows[0].occurrence_count, 1, 'occurrence_count no se infla por el duplicado dentro del mismo POST');
});

// ── rate limit por IP (protege el ledger de contaminación barata) ────────

function fakeKv(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
        store,
        async get(key) { return store.has(key) ? store.get(key) : null; },
        async put(key, value) { store.set(key, value); },
    };
}

test('bajo el límite: permite la consulta y NO escala el 429 (clave incluye el namespace de entorno)', async () => {
    const kv = fakeKv();
    const req = request({ lines: ['Cien Años De Soledad'] });
    req.headers.set('CF-Connecting-IP', '203.0.113.5');
    const ctx = context(req); // context() usa APP_ENV: 'preview'
    ctx.env.AMADO_KV = kv;
    const response = await listLookup(ctx);
    assert.equal(response.status, 200);
    assert.equal(kv.store.get('list-lookup-rl:preview:203.0.113.5'), '1');
});

test('al superar RATE_LIMIT_MAX_REQUESTS para la misma IP y el mismo entorno, responde 429', async () => {
    const kv = fakeKv({ 'list-lookup-rl:preview:203.0.113.9': '15' });
    const req = request({ lines: ['Cien Años De Soledad'] });
    req.headers.set('CF-Connecting-IP', '203.0.113.9');
    const ctx = context(req);
    ctx.env.AMADO_KV = kv;
    const response = await listLookup(ctx);
    assert.equal(response.status, 429);
});

test('IPs distintas tienen contadores independientes', async () => {
    const kv = fakeKv({ 'list-lookup-rl:preview:203.0.113.9': '15' });
    const req = request({ lines: ['Cien Años De Soledad'] });
    req.headers.set('CF-Connecting-IP', '203.0.113.10');
    const ctx = context(req);
    ctx.env.AMADO_KV = kv;
    const response = await listLookup(ctx);
    assert.equal(response.status, 200);
});

test('la misma IP en Preview y en producción NO comparte cupo — AMADO_KV es el mismo namespace, la clave lo separa', async () => {
    // Preview ya consumió su cupo entero para esta IP...
    const kv = fakeKv({ 'list-lookup-rl:preview:203.0.113.30': '15' });
    const previewReq = request({ lines: ['Cien Años De Soledad'] });
    previewReq.headers.set('CF-Connecting-IP', '203.0.113.30');
    const previewCtx = context(previewReq);
    previewCtx.env.AMADO_KV = kv;
    const previewResponse = await listLookup(previewCtx);
    assert.equal(previewResponse.status, 429, 'preview ya sin cupo');

    // ...pero producción, misma IP, mismo AMADO_KV compartido, sigue con cupo.
    const prodReq = request({ lines: ['Cien Años De Soledad'] });
    prodReq.headers.set('CF-Connecting-IP', '203.0.113.30');
    const prodCtx = context(prodReq);
    prodCtx.env.APP_ENV = 'production';
    prodCtx.env.AMADO_KV = kv;
    const prodResponse = await listLookup(prodCtx);
    assert.equal(prodResponse.status, 200, 'producción no paga el consumo de preview');
});

test('sin APP_ENV, usa el hostname de la request como namespace de fallback (nunca junta todo bajo una sola clave)', async () => {
    const kv = fakeKv();
    const req = new Request('https://pr-999.amadolibros-web.pages.dev/api/list-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: ['Cien Años De Soledad'] }),
    });
    req.headers.set('CF-Connecting-IP', '203.0.113.40');
    const ctx = context(req);
    delete ctx.env.APP_ENV;
    ctx.env.AMADO_KV = kv;
    const response = await listLookup(ctx);
    assert.equal(response.status, 200);
    assert.equal(kv.store.get('list-lookup-rl:pr-999.amadolibros-web.pages.dev:203.0.113.40'), '1');
});

test('si AMADO_KV no está disponible (o falla), nunca bloquea al usuario real (fail open)', async () => {
    const req = request({ lines: ['Cien Años De Soledad'] });
    req.headers.set('CF-Connecting-IP', '203.0.113.20');
    const ctx = context(req); // sin AMADO_KV en env
    const response = await listLookup(ctx);
    assert.equal(response.status, 200);

    const brokenKv = { async get() { throw new Error('KV down'); }, async put() { throw new Error('KV down'); } };
    const ctx2 = context(request({ lines: ['Cien Años De Soledad'] }), {});
    ctx2.request.headers.set('CF-Connecting-IP', '203.0.113.21');
    ctx2.env.AMADO_KV = brokenKv;
    const response2 = await listLookup(ctx2);
    assert.equal(response2.status, 200);
});

test('sin header CF-Connecting-IP (ej. en tests locales), no aplica rate limit', async () => {
    const kv = fakeKv({ 'list-lookup-rl:': '999' });
    const ctx = context(request({ lines: ['Cien Años De Soledad'] }));
    ctx.env.AMADO_KV = kv;
    const response = await listLookup(ctx);
    assert.equal(response.status, 200);
});

test('línea con match NO dispara ninguna escritura en el radar de demanda', async () => {
    const db = await withDemandRadarSchema(createD1());
    const waitUntilCalls = [];
    await listLookup(context(request({ lines: ['Cien Años De Soledad'] }), { db, waitUntilCalls }));
    await Promise.all(waitUntilCalls);

    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries').all();
    assert.equal(rows.length, 0);
});

// ── needs_confirmation: ambigüedad real, nunca una afirmación arbitraria ─

test('dos obras activas distintas empatadas en precisión responden needs_confirmation, no un match arbitrario', async () => {
    installCacheHits({
        [PAUSED_MANIFEST_URL]: { schema_version: 1, current: MANIFEST_CURRENT, previous: null },
        [`${R2_BASE}/${MANIFEST_CURRENT.active_index_key}`]: {
            schema_version: 1,
            fields: ['id', 'title', 'author', 'isbn', 'image', 'price', 'available_quantity'],
            derived_fields: { slug: 'slugify-v1', status: 'active' },
            items: [
                ['MLU0010', 'Poemas', 'Autor Uno', '', '', 500, 1],
                ['MLU0011', 'Poemas', 'Autor Dos', '', '', 600, 2],
            ],
        },
        [`${R2_BASE}/${MANIFEST_CURRENT.index_key}`]: { ...PAUSED_INDEX, items: [] },
    });
    const response = await listLookup(context(request({ lines: ['Poemas'] })));
    const data = await response.json();
    assert.equal(data.results[0].status, 'needs_confirmation');
    assert.equal(data.results[0].match, null);
    assert.equal(data.results[0].candidates.length, 2);
});

test('una línea needs_confirmation NO dispara escritura en el radar de demanda (encontró algo, sólo es ambiguo)', async () => {
    installCacheHits({
        [PAUSED_MANIFEST_URL]: { schema_version: 1, current: MANIFEST_CURRENT, previous: null },
        [`${R2_BASE}/${MANIFEST_CURRENT.active_index_key}`]: {
            schema_version: 1,
            fields: ['id', 'title', 'author', 'isbn', 'image', 'price', 'available_quantity'],
            derived_fields: { slug: 'slugify-v1', status: 'active' },
            items: [
                ['MLU0010', 'Poemas', 'Autor Uno', '', '', 500, 1],
                ['MLU0011', 'Poemas', 'Autor Dos', '', '', 600, 2],
            ],
        },
        [`${R2_BASE}/${MANIFEST_CURRENT.index_key}`]: { ...PAUSED_INDEX, items: [] },
    });
    const db = await withDemandRadarSchema(createD1());
    const waitUntilCalls = [];
    await listLookup(context(request({ lines: ['Poemas'] }), { db, waitUntilCalls }));
    await Promise.all(waitUntilCalls);
    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries').all();
    assert.equal(rows.length, 0);
});

// ── higiene de PII en 'reading_list' (extremo a extremo vía el endpoint) ─

test('una línea sin match que contiene un email no se persiste en el radar (extremo a extremo)', async () => {
    const db = await withDemandRadarSchema(createD1());
    const waitUntilCalls = [];
    const response = await listLookup(context(
        request({ lines: ['contactame a juan@example.com'] }),
        { db, waitUntilCalls },
    ));
    const data = await response.json();
    assert.equal(data.results[0].status, 'no_match', 'la respuesta al usuario no cambia');
    await Promise.all(waitUntilCalls);
    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries').all();
    assert.equal(rows.length, 0, 'pero no se persiste el email');
});
