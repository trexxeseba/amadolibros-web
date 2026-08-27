// GW1 (Radar de Demanda No Satisfecha) + GW2 (Kit de Lista de Lectura) —
// lógica pura de matching y persistencia del registro agregado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
    ensureDemandRadarSchema,
    matchCatalogLine,
    normalizeQuery,
    prepareCatalogCandidates,
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

function prepared({ activeItems = [], pausedItems = [] } = {}) {
    return prepareCatalogCandidates({ activeItems, pausedItems });
}

// ── normalizeQuery ────────────────────────────────────────────────────────

test('normalizeQuery: minúsculas, sin acentos, espacios colapsados', () => {
    assert.equal(normalizeQuery('  Cién   Años  '), 'cien anos');
    assert.equal(normalizeQuery(''), '');
    assert.equal(normalizeQuery(null), '');
});

// ── matchCatalogLine: activos ────────────────────────────────────────────

test('matchCatalogLine: título con cobertura fuerte de tokens matchea activo con precio y stock', () => {
    const result = matchCatalogLine('cien años de soledad', prepared({ activeItems: [activeItem()] }));
    assert.equal(result.status, 'matched_active');
    assert.equal(result.match.id, 'MLU1');
    assert.equal(result.match.price, 1200);
    assert.equal(result.match.stock, 3);
});

// ── matchCatalogLine: por encargo ────────────────────────────────────────

test('matchCatalogLine: sin match activo, matchea por-encargo sin precio ni stock (nunca se inventan)', () => {
    const result = matchCatalogLine('el amor en los tiempos del colera', prepared({ pausedItems: [pausedItem()] }));
    assert.equal(result.status, 'matched_by_encargo');
    assert.equal(result.match.id, 'MLU2');
    assert.equal(result.match.price, null);
    assert.equal(result.match.stock, null);
});

// ── matchCatalogLine: ISBN ────────────────────────────────────────────────

test('matchCatalogLine: ISBN exacto (>=10 dígitos) matchea aunque el título no coincida en texto', () => {
    const result = matchCatalogLine('978-987-138-786-1', prepared({
        activeItems: [activeItem({ id: 'MLU9', title: 'Título Distinto', isbn: '9789871387861' })],
    }));
    assert.equal(result.status, 'matched_active');
    assert.equal(result.match.id, 'MLU9');
});

// ── matchCatalogLine: no_match — nunca inventa una coincidencia dudosa ──

test('matchCatalogLine: sin ningún candidato real, no_match', () => {
    const result = matchCatalogLine('un libro que no existe en absoluto', prepared({ activeItems: [activeItem()] }));
    assert.equal(result.status, 'no_match');
    assert.equal(result.match, null);
});

test('matchCatalogLine: coincidencia de una sola palabra común NO alcanza (evita falsos positivos)', () => {
    const result = matchCatalogLine('el libro', prepared({
        activeItems: [activeItem({ title: 'Un Libro Cualquiera Sobre Otra Cosa Completamente Distinta' })],
    }));
    assert.equal(result.status, 'no_match');
});

test('matchCatalogLine: cobertura parcial insuficiente (menos del 80% de los tokens) queda no_match', () => {
    const result = matchCatalogLine('cien años de soledad y algo mas que no esta', prepared({ activeItems: [activeItem()] }));
    assert.equal(result.status, 'no_match');
});

test('matchCatalogLine: línea vacía devuelve null (no genera una fila de resultado)', () => {
    assert.equal(matchCatalogLine('   ', prepared({})), null);
    assert.equal(matchCatalogLine('', prepared({})), null);
});

// ── matchCatalogLine: el autor refuerza, nunca sustituye ni perjudica ────

test('matchCatalogLine: título solo matchea (referencia)', () => {
    const result = matchCatalogLine('Cien años de soledad', prepared({ activeItems: [activeItem()] }));
    assert.equal(result.status, 'matched_active');
});

test('matchCatalogLine: título + autor CORRECTO también matchea (agregar el autor no debe empeorar la cobertura)', () => {
    const result = matchCatalogLine('Cien años de soledad Gabriel García Márquez', prepared({ activeItems: [activeItem()] }));
    assert.equal(result.status, 'matched_active');
    assert.equal(result.match.id, 'MLU1');
});

test('matchCatalogLine: mismo título + autor INCORRECTO no matchea (el autor no sustituye evidencia de título)', () => {
    const result = matchCatalogLine('Cien años de soledad Isabel Allende', prepared({ activeItems: [activeItem()] }));
    assert.equal(result.status, 'no_match');
});

test('matchCatalogLine: sólo el nombre del autor (sin ningún token de título) nunca matchea — un autor prolífico es ambiguo por definición', () => {
    const result = matchCatalogLine('Gabriel García Márquez', prepared({ activeItems: [activeItem()] }));
    assert.equal(result.status, 'no_match');
});

// ── matchCatalogLine: ranking determinista + detección de ambigüedad ────

test('matchCatalogLine: empate de precisión entre DOS obras activas distintas → needs_confirmation, nunca una afirmación arbitraria', () => {
    const itemA = activeItem({ id: 'MLU10', title: 'Poemas', author: 'Autor Uno' });
    const itemB = activeItem({ id: 'MLU11', title: 'Poemas', author: 'Autor Dos' });
    const result = matchCatalogLine('poemas', prepared({ activeItems: [itemA, itemB] }));
    assert.equal(result.status, 'needs_confirmation');
    assert.equal(result.match, null);
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(result.candidates.map(c => c.id).sort(), ['MLU10', 'MLU11']);
});

test('matchCatalogLine: empate de precisión entre DOS obras por-encargo distintas → needs_confirmation', () => {
    const itemA = pausedItem({ id: 'MLU20', title: 'Ensayos', author: 'Autor Uno' });
    const itemB = pausedItem({ id: 'MLU21', title: 'Ensayos', author: 'Autor Dos' });
    const result = matchCatalogLine('ensayos', prepared({ pausedItems: [itemA, itemB] }));
    assert.equal(result.status, 'needs_confirmation');
    assert.equal(result.candidates.length, 2);
});

test('matchCatalogLine: mismo orden de aparición invertido da el mismo resultado (no depende de la posición en el array)', () => {
    const itemA = activeItem({ id: 'MLU10', title: 'Poemas', author: 'Autor Uno' });
    const itemB = activeItem({ id: 'MLU11', title: 'Poemas', author: 'Autor Dos' });
    const forward = matchCatalogLine('poemas', prepared({ activeItems: [itemA, itemB] }));
    const reversed = matchCatalogLine('poemas', prepared({ activeItems: [itemB, itemA] }));
    assert.equal(forward.status, 'needs_confirmation');
    assert.equal(reversed.status, 'needs_confirmation');
    assert.deepEqual(forward.candidates.map(c => c.id).sort(), reversed.candidates.map(c => c.id).sort());
});

// ── matchCatalogLine: activo vs. por-encargo — sólo desempata, no decide ─

test('matchCatalogLine: un activo MEDIOCRE no debe tapar un por-encargo mucho más preciso', () => {
    // Activa parcial: comparte sólo 2 de 4 tokens del título real buscado.
    const weakActive = activeItem({ id: 'MLU30', title: 'Eva Luna Historias De Mujeres', author: 'Otro Autor' });
    // Pausada exacta: coincide 100% con la búsqueda.
    const exactPaused = pausedItem({ id: 'MLU31', title: 'Eva Luna', author: 'Isabel Allende' });
    const result = matchCatalogLine('eva luna', prepared({ activeItems: [weakActive], pausedItems: [exactPaused] }));
    assert.equal(result.status, 'matched_by_encargo', 'la pausada exacta tiene más precisión que la activa parcial');
    assert.equal(result.match.id, 'MLU31');
});

test('matchCatalogLine: con precisión IDÉNTICA entre activo y por-encargo, el estado comercial desempata a favor del activo', () => {
    const active = activeItem({ id: 'MLU40', title: 'Rayuela', author: 'Julio Cortázar' });
    const paused = pausedItem({ id: 'MLU41', title: 'Rayuela', author: 'Julio Cortázar' });
    const result = matchCatalogLine('Rayuela Julio Cortázar', prepared({ activeItems: [active], pausedItems: [paused] }));
    assert.equal(result.status, 'matched_active');
    assert.equal(result.match.id, 'MLU40');
});

// ── prepareCatalogCandidates: guard estructural de escala ────────────────

test('prepareCatalogCandidates: pre-tokeniza título y autor una sola vez (estructura reutilizable)', () => {
    const [candidate] = prepared({ activeItems: [activeItem()] });
    assert.deepEqual(candidate.titleTokens, ['cien', 'anos', 'de', 'soledad']);
    assert.ok(candidate.titleTokenSet instanceof Set);
    assert.deepEqual(candidate.authorTokens, ['gabriel', 'garcia', 'marquez']);
    assert.ok(candidate.authorTokenSet instanceof Set);
});

test('matchCatalogLine reutiliza los tokens ya preparados en vez de retokenizar por línea (guard estructural de escala)', () => {
    const candidates = prepared({ activeItems: [activeItem()] });
    // Saboteamos deliberadamente los tokens ya preparados: si matchCatalogLine
    // volviera a tokenizar item.title en cada llamada, este sabotaje no
    // tendría efecto y el resultado seguiría siendo un match.
    candidates[0].titleTokens = ['manzana'];
    candidates[0].titleTokenSet = new Set(['manzana']);
    const result = matchCatalogLine('cien años de soledad', candidates);
    assert.equal(result.status, 'no_match', 'si usara item.title en vivo esto matchearía; al no matchear, confirma que usa la caché preparada');
});

test('matchCatalogLine resuelve 40 líneas contra la misma estructura preparada sin volver a llamar prepareCatalogCandidates', () => {
    const candidates = prepared({ activeItems: [activeItem()], pausedItems: [pausedItem()] });
    const lines = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 'cien años de soledad' : 'el amor en los tiempos del colera'));
    const results = lines.map(line => matchCatalogLine(line, candidates));
    assert.equal(results.length, 40);
    assert.ok(results.every(r => r.status === 'matched_active' || r.status === 'matched_by_encargo'));
});

// ── recordUnmatchedQuery / ensureDemandRadarSchema (D1 real vía sqlite) ──

test('recordUnmatchedQuery: primera vez inserta con occurrence_count=1', async () => {
    const db = createD1();
    await ensureDemandRadarSchema(db);
    await recordUnmatchedQuery(db, { rawQuery: 'Rayuela Cortázar', source: 'catalogo_search', appEnv: 'production' });
    const row = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries WHERE normalized_query = ? AND source = ?').get('rayuela cortazar', 'catalogo_search');
    assert.ok(row);
    assert.equal(row.occurrence_count, 1);
    assert.equal(row.raw_query, 'Rayuela Cortázar');
    assert.equal(row.source, 'catalogo_search');
});

test('recordUnmatchedQuery: repetir la misma búsqueda (normalizada, misma fuente) incrementa el contador, no duplica fila', async () => {
    const db = createD1();
    await ensureDemandRadarSchema(db);
    await recordUnmatchedQuery(db, { rawQuery: 'rayuela', source: 'catalogo_search' });
    await recordUnmatchedQuery(db, { rawQuery: 'Rayuela', source: 'catalogo_search' });
    await recordUnmatchedQuery(db, { rawQuery: '  RAYUELA  ', source: 'catalogo_search' });
    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].occurrence_count, 3);
});

test('recordUnmatchedQuery: la MISMA query normalizada en fuentes distintas genera dos filas separadas, sin pisar la atribución de origen', async () => {
    const db = createD1();
    await ensureDemandRadarSchema(db);
    await recordUnmatchedQuery(db, { rawQuery: 'rayuela', source: 'catalogo_search' });
    await recordUnmatchedQuery(db, { rawQuery: 'rayuela', source: 'reading_list' });
    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries ORDER BY source').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].source, 'catalogo_search');
    assert.equal(rows[0].occurrence_count, 1);
    assert.equal(rows[1].source, 'reading_list');
    assert.equal(rows[1].occurrence_count, 1);
});

test('recordUnmatchedQuery: "autocomplete" ya no es una fuente válida — se ignora silenciosamente', async () => {
    const db = createD1();
    await ensureDemandRadarSchema(db);
    await recordUnmatchedQuery(db, { rawQuery: 'consulta valida', source: 'autocomplete' });
    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries').all();
    assert.equal(rows.length, 0);
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

// ── recordUnmatchedQuery: higiene de PII para 'reading_list' ─────────────

test('recordUnmatchedQuery: NO persiste una línea de reading_list que contiene un email', async () => {
    const db = createD1();
    await ensureDemandRadarSchema(db);
    await recordUnmatchedQuery(db, { rawQuery: 'contactame a juan@example.com por el libro', source: 'reading_list' });
    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries').all();
    assert.equal(rows.length, 0);
});

test('recordUnmatchedQuery: NO persiste una línea de reading_list que contiene una URL', async () => {
    const db = createD1();
    await ensureDemandRadarSchema(db);
    await recordUnmatchedQuery(db, { rawQuery: 'mira este libro en https://ejemplo.com/libro', source: 'reading_list' });
    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries').all();
    assert.equal(rows.length, 0);
});

test('recordUnmatchedQuery: NO persiste una línea de reading_list que es un teléfono largo (9 dígitos, formato UY móvil)', async () => {
    const db = createD1();
    await ensureDemandRadarSchema(db);
    await recordUnmatchedQuery(db, { rawQuery: '099 123 456', source: 'reading_list' });
    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries').all();
    assert.equal(rows.length, 0);
});

test('recordUnmatchedQuery: NO persiste una línea de reading_list que es un teléfono largo (8 dígitos, formato UY fijo)', async () => {
    const db = createD1();
    await ensureDemandRadarSchema(db);
    await recordUnmatchedQuery(db, { rawQuery: '2900-1234', source: 'reading_list' });
    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries').all();
    assert.equal(rows.length, 0);
});

test('recordUnmatchedQuery: SÍ persiste un ISBN-13 de reading_list (shape de 13 dígitos preservado a propósito, no es un teléfono)', async () => {
    const db = createD1();
    await ensureDemandRadarSchema(db);
    await recordUnmatchedQuery(db, { rawQuery: '9789871387861', source: 'reading_list' });
    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries').all();
    assert.equal(rows.length, 1);
});

test('recordUnmatchedQuery: SÍ persiste un ISBN-10 de reading_list', async () => {
    const db = createD1();
    await ensureDemandRadarSchema(db);
    await recordUnmatchedQuery(db, { rawQuery: '0143039431', source: 'reading_list' });
    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries').all();
    assert.equal(rows.length, 1);
});

test('recordUnmatchedQuery: SÍ persiste un título normal con números cortos (ej. "1984")', async () => {
    const db = createD1();
    await ensureDemandRadarSchema(db);
    await recordUnmatchedQuery(db, { rawQuery: '1984 George Orwell', source: 'reading_list' });
    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries').all();
    assert.equal(rows.length, 1);
});

test('recordUnmatchedQuery: la higiene de PII no aplica a catalogo_search (la caja de búsqueda no es texto libre pegado)', async () => {
    const db = createD1();
    await ensureDemandRadarSchema(db);
    // Un número de 9 dígitos buscado explícitamente en /catalogo?q= (por
    // ejemplo, alguien probando un ISBN mal copiado) sí se registra —
    // sólo 'reading_list' aplica el filtro de teléfonos, porque ahí el
    // texto es pegado libremente y con más riesgo de traer datos ajenos.
    await recordUnmatchedQuery(db, { rawQuery: '099123456', source: 'catalogo_search' });
    const rows = db.sqlite.prepare('SELECT * FROM demand_radar_unmatched_queries').all();
    assert.equal(rows.length, 1);
});
