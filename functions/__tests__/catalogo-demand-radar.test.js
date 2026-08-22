// GW1 (Radar de Demanda No Satisfecha) en /catalogo — el registro debe medir
// si el libro existe en TODO el catálogo elegible, no en la vista filtrada.
// Un libro real que el usuario dejó afuera con un filtro de categoría o de
// disponibilidad no es demanda insatisfecha: es un libro que sí tenemos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { onRequest as catalogRequest } from '../catalogo.js';
import { PAUSED_MANIFEST_URL, PRODUCTION_MANIFEST_URL, R2_BASE } from '../_shared/catalog.js';

const CATALOG = {
    total: 2,
    items: [
        {
            id: 'MLU1', title: 'El Género En Disputa', author: 'Judith Butler',
            isbn: '9780415924993', price: 1000, status: 'active', available_quantity: 2,
            thumbnail: '', pictures: [], permalink: 'https://x/MLU1',
        },
        {
            id: 'MLU5', title: 'Vinilo The Beatles Abbey Road', author: '',
            isbn: '5', price: 700, status: 'active', available_quantity: 1,
            thumbnail: '', pictures: [], permalink: 'https://x/MLU5',
        },
    ],
};

const ACTIVE_CATEGORIES = {
    generated_at: '2026-08-02T00:00:00.000Z',
    taxonomy_version: 2,
    rules_version: 8,
    categories: [
        { id: 'filosofia-ciencias-sociales', name: 'Filosofía y ciencias sociales', count: 1, subcategories: [] },
        { id: 'esoterismo-tarot', name: 'Esoterismo y tarot', count: 0, subcategories: [] },
    ],
    items: {
        MLU1: ['filosofia-ciencias-sociales'],
    },
};

const PAUSED_MANIFEST = {
    schema_version: 1,
    current: {
        version: 'v1',
        index_key: 'stock1-preview/index.json',
        block_prefix: 'stock1-preview/blocks',
        block_count: 1,
    },
};

const PAUSED_INDEX = {
    schema_version: 1,
    fields: ['id', 'title', 'author', 'isbn', 'image'],
    derived_fields: { slug: 'slugify-v1', status: 'paused', block: 'numeric-id-mod-block-count' },
    block_count: 1,
    items: [
        // Sólo existe por encargo — ningún activo lo matchea.
        ['MLU6', 'Diccionario Inglés Avanzado', 'Autor Encargo', '111', ''],
    ],
};

function createD1() {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
    CREATE TABLE IF NOT EXISTS demand_radar_unmatched_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      normalized_query TEXT NOT NULL,
      raw_query TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('catalogo_search','reading_list')),
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      UNIQUE (normalized_query, source)
    )`);
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

function context(url, { db, waitUntilCalls } = {}) {
    return {
        request: new Request(url),
        params: {},
        env: { APP_ENV: 'preview', ORDERS_DB: db },
        waitUntil(promise) {
            if (waitUntilCalls) waitUntilCalls.push(promise);
        },
    };
}

test.beforeEach(() => {
    globalThis.caches = {
        default: {
            async match(request) {
                if (request.url === PAUSED_MANIFEST_URL) return Response.json(PAUSED_MANIFEST);
                if (request.url === PRODUCTION_MANIFEST_URL) return Response.json({ current: null, previous: null });
                if (request.url === `${R2_BASE}/${PAUSED_MANIFEST.current.index_key}`) {
                    return Response.json(PAUSED_INDEX);
                }
                if (request.url.endsWith('/data/active-categories.json')) {
                    return Response.json(ACTIVE_CATEGORIES);
                }
                return null;
            },
            async put() {},
        },
    };
    globalThis.fetch = async () => Response.json(CATALOG);
});

test.afterEach(() => {
    delete globalThis.caches;
    delete globalThis.fetch;
});

test('existe globalmente (activo) pero la categoría elegida lo excluye → NO registra en el Radar', async () => {
    const db = createD1();
    const waitUntilCalls = [];
    const res = await catalogRequest(context(
        'https://preview.example/catalogo?q=genero+en+disputa&categoria=esoterismo-tarot',
        { db, waitUntilCalls },
    ));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.doesNotMatch(html, /El Género En Disputa/, 'la vista filtrada efectivamente no lo muestra');
    await Promise.all(waitUntilCalls);
    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries').all();
    assert.equal(rows.length, 0, 'el libro existe globalmente — no es demanda insatisfecha, sólo quedó fuera del filtro');
});

test('existe globalmente (por encargo) pero el filtro "disponibles" lo excluye → NO registra en el Radar', async () => {
    const db = createD1();
    const waitUntilCalls = [];
    const res = await catalogRequest(context(
        'https://preview.example/catalogo?q=diccionario+ingles+avanzado&disponibilidad=disponibles',
        { db, waitUntilCalls },
    ));
    assert.equal(res.status, 200);
    await Promise.all(waitUntilCalls);
    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries').all();
    assert.equal(rows.length, 0, 'existe por encargo — no es demanda insatisfecha, sólo no está "disponible ahora"');
});

test('no existe en ningún lado del catálogo elegible → SÍ registra en el Radar', async () => {
    const db = createD1();
    const waitUntilCalls = [];
    const res = await catalogRequest(context(
        'https://preview.example/catalogo?q=zzzznoexisteenningunaparte',
        { db, waitUntilCalls },
    ));
    assert.equal(res.status, 200);
    await Promise.all(waitUntilCalls);
    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'catalogo_search');
    assert.equal(rows[0].raw_query, 'zzzznoexisteenningunaparte');
});

test('existe globalmente y SIN ningún filtro activo → tampoco registra (totalResults ya sería > 0)', async () => {
    const db = createD1();
    const waitUntilCalls = [];
    const res = await catalogRequest(context(
        'https://preview.example/catalogo?q=genero+en+disputa',
        { db, waitUntilCalls },
    ));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /El Género En Disputa/);
    await Promise.all(waitUntilCalls);
    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries').all();
    assert.equal(rows.length, 0);
});
