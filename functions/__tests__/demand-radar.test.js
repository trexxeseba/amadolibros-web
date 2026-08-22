// GW1 (Radar de Demanda No Satisfecha) + GW2 (Kit de Lista de Lectura) —
// lógica pura de matching y persistencia del registro agregado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
    ensureDemandRadarSchema,
    matchCatalogLine,
    normalizeQuery,
    recordUnmatchedQuery,
} from '../_shared/demand-radar.js';

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

function activeItem(overrides = {}) {
    return { id: 'MLU1', title: 'Cien Años De Soledad', author: 'Gabriel García Márquez', isbn: null, price: 1200, available_quantity: 3, ...overrides };
}

function pausedItem(overrides = {}) {
    return { id: 'MLU2', title: 'El Amor En Los Tiempos Del Cólera', author: 'Gabriel García Márquez', isbn: null, ...overrides };
}

// ── normalizeQuery ────────────────────────────────────────────────────────

test('normalizeQuery: minúsculas, sin acentos, espacios colapsados', () => {
    assert.equal(normalizeQuery('  Cién   Años  '), 'cien anos');
    assert.equal(normalizeQuery(''), '');
    assert.equal(normalizeQuery(null), '');
});

// ── matchCatalogLine: activos ────────────────────────────────────────────

test('matchCatalogLine: título con cobertura fuerte de tokens matchea activo con precio y stock', () => {
    const result = matchCatalogLine('cien años de soledad', { activeItems: [activeItem()], pausedItems: [] });
    assert.equal(result.status, 'matched_active');
    assert.equal(result.match.id, 'MLU1');
    assert.equal(result.match.price, 1200);
    assert.equal(result.match.stock, 3);
});

test('matchCatalogLine: activo tiene prioridad sobre por-encargo cuando ambos matchean', () => {
    const result = matchCatalogLine('cien años de soledad', {
        activeItems: [activeItem()],
        pausedItems: [pausedItem({ title: 'Cien Años De Soledad' })],
    });
    assert.equal(result.status, 'matched_active');
});

// ── matchCatalogLine: por encargo ────────────────────────────────────────

test('matchCatalogLine: sin match activo, matchea por-encargo sin precio ni stock (nunca se inventan)', () => {
    const result = matchCatalogLine('el amor en los tiempos del colera', { activeItems: [], pausedItems: [pausedItem()] });
    assert.equal(result.status, 'matched_by_encargo');
    assert.equal(result.match.id, 'MLU2');
    assert.equal(result.match.price, null);
    assert.equal(result.match.stock, null);
});

// ── matchCatalogLine: ISBN ────────────────────────────────────────────────

test('matchCatalogLine: ISBN exacto (>=10 dígitos) matchea aunque el título no coincida en texto', () => {
    const result = matchCatalogLine('978-987-138-786-1', {
        activeItems: [activeItem({ id: 'MLU9', title: 'Título Distinto', isbn: '9789871387861' })],
        pausedItems: [],
    });
    assert.equal(result.status, 'matched_active');
    assert.equal(result.match.id, 'MLU9');
});

// ── matchCatalogLine: no_match — nunca inventa una coincidencia dudosa ──

test('matchCatalogLine: sin ningún candidato real, no_match', () => {
    const result = matchCatalogLine('un libro que no existe en absoluto', { activeItems: [activeItem()], pausedItems: [] });
    assert.equal(result.status, 'no_match');
    assert.equal(result.match, null);
});

test('matchCatalogLine: coincidencia de una sola palabra común NO alcanza (evita falsos positivos)', () => {
    // "el libro" comparte sólo "libro" con un título que también dice
    // "libro" en otro contexto — no debe considerarse una coincidencia real.
    const result = matchCatalogLine('el libro', {
        activeItems: [activeItem({ title: 'Un Libro Cualquiera Sobre Otra Cosa Completamente Distinta' })],
        pausedItems: [],
    });
    assert.equal(result.status, 'no_match');
});

test('matchCatalogLine: cobertura parcial insuficiente (menos del 80% de los tokens) queda no_match', () => {
    const result = matchCatalogLine('cien años de soledad y algo mas que no esta', {
        activeItems: [activeItem()],
        pausedItems: [],
    });
    assert.equal(result.status, 'no_match');
});

test('matchCatalogLine: línea vacía devuelve null (no genera una fila de resultado)', () => {
    assert.equal(matchCatalogLine('   ', { activeItems: [], pausedItems: [] }), null);
    assert.equal(matchCatalogLine('', { activeItems: [], pausedItems: [] }), null);
});

// ── recordUnmatchedQuery / ensureDemandRadarSchema (D1 real vía sqlite) ──

test('recordUnmatchedQuery: primera vez inserta con occurrence_count=1', async () => {
    const db = createD1();
    await ensureDemandRadarSchema(db);
    await recordUnmatchedQuery(db, { rawQuery: 'Rayuela Cortázar', source: 'catalogo_search', appEnv: 'production' });
    const row = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries WHERE normalized_query = ?').get('rayuela cortazar');
    assert.ok(row);
    assert.equal(row.occurrence_count, 1);
    assert.equal(row.raw_query, 'Rayuela Cortázar');
    assert.equal(row.source, 'catalogo_search');
});

test('recordUnmatchedQuery: repetir la misma búsqueda (normalizada) incrementa el contador, no duplica fila', async () => {
    const db = createD1();
    await ensureDemandRadarSchema(db);
    await recordUnmatchedQuery(db, { rawQuery: 'rayuela', source: 'catalogo_search' });
    await recordUnmatchedQuery(db, { rawQuery: 'Rayuela', source: 'autocomplete' });
    await recordUnmatchedQuery(db, { rawQuery: '  RAYUELA  ', source: 'reading_list' });
    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].occurrence_count, 3);
    assert.equal(rows[0].source, 'reading_list', 'la fuente se actualiza a la del último evento');
});

test('recordUnmatchedQuery: sin db (undefined), no lanza (llamador siempre puede invocarlo sin binding)', async () => {
    await assert.doesNotReject(recordUnmatchedQuery(undefined, { rawQuery: 'x', source: 'catalogo_search' }));
});

test('recordUnmatchedQuery: query demasiado corta o source inválido se ignora silenciosamente', async () => {
    const db = createD1();
    await ensureDemandRadarSchema(db);
    await recordUnmatchedQuery(db, { rawQuery: 'a', source: 'catalogo_search' });
    await recordUnmatchedQuery(db, { rawQuery: 'consulta valida', source: 'fuente_no_reconocida' });
    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries').all();
    assert.equal(rows.length, 0);
});

test('recordUnmatchedQuery: recorta a MAX_QUERY_LENGTH sin lanzar con input extremadamente largo', async () => {
    const db = createD1();
    await ensureDemandRadarSchema(db);
    await recordUnmatchedQuery(db, { rawQuery: 'x'.repeat(5000), source: 'catalogo_search' });
    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries').all();
    assert.equal(rows.length, 1);
    assert.ok(rows[0].raw_query.length <= 200);
});
