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
    const db = createD1();
    await db.prepare(`
    CREATE TABLE IF NOT EXISTS demand_radar_unmatched_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      normalized_query TEXT NOT NULL UNIQUE,
      raw_query TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('catalogo_search','autocomplete','reading_list')),
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )`).bind().run();

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

test('línea con match NO dispara ninguna escritura en el radar de demanda', async () => {
    const db = createD1();
    await db.prepare(`
    CREATE TABLE IF NOT EXISTS demand_radar_unmatched_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      normalized_query TEXT NOT NULL UNIQUE,
      raw_query TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('catalogo_search','autocomplete','reading_list')),
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )`).bind().run();

    const waitUntilCalls = [];
    await listLookup(context(request({ lines: ['Cien Años De Soledad'] }), { db, waitUntilCalls }));
    await Promise.all(waitUntilCalls);

    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries').all();
    assert.equal(rows.length, 0);
});
