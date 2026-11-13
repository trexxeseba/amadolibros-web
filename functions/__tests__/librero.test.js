import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
    LIMITS, PREVIEW_SCHEMA, buildCard, buildSummary, createLibreroHandler, suggestCandidates, validateRequest,
} from '../api/_librero_handler.js';

const NOW = new Date('2026-11-13T15:00:00.000Z');

/** D1 mínimo sobre node:sqlite con las migraciones reales. */
function d1(extraSql = []) {
    const db = new DatabaseSync(':memory:');
    db.exec(readFileSync('migrations/0016_book_requests.sql', 'utf8'));
    db.exec(readFileSync('migrations/0023_librero.sql', 'utf8'));
    for (const sql of extraSql) db.exec(sql);
    const wrap = sql => {
        const stmt = db.prepare(sql);
        const bound = (...args) => ({
            sql, args,
            first: async () => stmt.get(...args) ?? null,
            run: async () => { const r = stmt.run(...args); return { meta: { changes: Number(r.changes) } }; },
        });
        return { bind: bound, ...bound() };
    };
    return {
        raw: db,
        prepare: wrap,
        // D1 batch es atómico: si algo falla, no queda nada a medias.
        async batch(statements) {
            db.exec('BEGIN');
            try { for (const s of statements) await s.run(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
        },
    };
}

const ITEMS = [
    { id: 'MLU1', title: 'La tierra baldía', author: 'Eliot, T. S.', isbn: '1', status: 'paused', available_quantity: 0 },
    { id: 'MLU2', title: 'Poesía completa de Eliot', author: 'Eliot, Thomas Stearns', isbn: '2', status: 'active', available_quantity: 2, price: 890.4 },
    { id: 'MLU3', title: 'Ficciones', author: 'Jorge Luis Borges', isbn: '3', status: 'active', available_quantity: 1, price: 500 },
    { id: 'MLU4', title: 'Cuentos del Eliot ajeno', author: 'Otro Autor', isbn: '4', status: 'active', available_quantity: 1, price: 300 },
];

function post(body, { ip = '203.0.113.7', origin = 'https://www.amadolibros.com' } = {}) {
    const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip };
    if (origin) headers.Origin = origin;
    return new Request('https://www.amadolibros.com/api/librero', {
        method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

let seq = 0;
const handler = (opts = {}) => createLibreroHandler({
    getNow: () => NOW,
    random: () => Uint8Array.from([seq++, seq++, seq++, seq++]),
    loadItems: async () => ITEMS,
    ...opts,
});
const call = async (h, db, body, req = {}) => {
    const res = await h({ request: post(body, req), env: { ORDERS_DB: db } });
    return { status: res.status, data: await res.json() };
};

test('la definición de Preview coincide con la migración', () => {
    const real = d1();
    const preview = new DatabaseSync(':memory:');
    for (const sql of PREVIEW_SCHEMA) preview.exec(sql);
    for (const table of ['book_requests', 'librero_sessions', 'librero_events', 'librero_requests']) {
        const cols = db => db.prepare(`PRAGMA table_info(${table})`).all().map(c => `${c.name}:${c.type}:${c.notnull}`).join(',');
        assert.equal(cols(preview), cols(real.raw), table);
    }
});

test('suggestCandidates ofrece libros del autor, con stock primero, sin inventar', () => {
    const found = suggestCandidates(ITEMS, 'TS Eliot');
    assert.deepEqual(found.map(b => b.id).slice(0, 2), ['MLU2', 'MLU1']);
    assert.ok(found.length <= LIMITS.maxCandidates);
    assert.deepEqual(suggestCandidates(ITEMS, 'xqzw libro raro'), []);
    assert.deepEqual(suggestCandidates(ITEMS, 'el de la'), []);
});

test('una palabra suelta que no coincide exacto no se adivina', () => {
    assert.deepEqual(suggestCandidates(ITEMS, 'borjes'), []);
});

test('buildCard toma precio y stock del catálogo y no pone precio a lo que no hay', () => {
    const active = buildCard(ITEMS[1]);
    assert.equal(active.available, true);
    assert.equal(active.price, 890);
    assert.equal(active.url, '/libro/MLU2/poesia-completa-de-eliot');
    const paused = buildCard(ITEMS[0]);
    assert.equal(paused.available, false);
    assert.equal(paused.price, null);
});

test('start abre la sesión, devuelve candidatos reales y la guarda', async () => {
    const db = d1();
    const { status, data } = await call(handler(), db, { action: 'start', query: 'TS Eliot' });
    assert.equal(status, 201);
    assert.equal(data.catalog_ok, true);
    assert.equal(data.candidates[0].id, 'MLU2');
    const row = db.raw.prepare('SELECT * FROM librero_sessions').get();
    assert.equal(row.query, 'TS Eliot');
    assert.equal(row.outcome, 'open');
    assert.deepEqual(JSON.parse(row.candidate_ids).slice(0, 1), ['MLU2']);
    assert.ok(!('ip' in row) && row.ip_hash && row.ip_hash.length === 64);
});

test('si el catálogo falla, lo dice: catalog_ok false y sin candidatos', async () => {
    const db = d1();
    const h = handler({ loadItems: async () => { throw new Error('r2 caído'); } });
    const { status, data } = await call(h, db, { action: 'start', query: 'Rayuela' });
    assert.equal(status, 201);
    assert.equal(data.catalog_ok, false);
    assert.deepEqual(data.candidates, []);
    assert.equal(db.raw.prepare('SELECT catalog_ok FROM librero_sessions').get().catalog_ok, 0);
});

test('límite de sesiones por visitante', async () => {
    const db = d1();
    const h = handler();
    for (let i = 0; i < LIMITS.sessionsPerWindow; i++) {
        assert.equal((await call(h, db, { action: 'start', query: 'Eliot' })).status, 201);
    }
    const blocked = await call(h, db, { action: 'start', query: 'Eliot' });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.data.code, 'RATE_LIMITED');
    // otra red no queda bloqueada
    assert.equal((await call(h, db, { action: 'start', query: 'Eliot' }, { ip: '198.51.100.9' })).status, 201);
});

test('event registra, avanza el resultado y no pisa un pedido', async () => {
    const db = d1();
    const h = handler();
    const { data: s } = await call(h, db, { action: 'start', query: 'Eliot' });
    assert.equal((await call(h, db, { action: 'event', session_id: s.session_id, type: 'candidate_click', payload: 'MLU2' })).status, 200);
    assert.equal(db.raw.prepare('SELECT outcome FROM librero_sessions').get().outcome, 'clicked');
    assert.equal((await call(h, db, { action: 'event', session_id: s.session_id, type: 'inventado' })).status, 400);
    assert.equal((await call(h, db, { action: 'event', session_id: 'no-existe', type: 'left' })).status, 404);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM librero_events').get().n, 1);
});

const REQUEST = (sessionId, extra = {}) => ({
    action: 'request', session_id: sessionId, idempotency_key: 'clave-estable-0001', query: 'La tierra baldía, edición bilingüe',
    accepts_used: true, accepts_other_edition: false, language: 'Español', budget_uyu: 900, urgency: 'sin-apuro',
    contact_kind: 'whatsapp', contact_value: '099 123 456', contact_preferred_time: 'mañana por la tarde', consent_reply: true,
    ...extra,
});

test('request guarda el pedido con contacto y lo copia sin contacto a book_requests', async () => {
    const db = d1();
    const h = handler();
    const { data: s } = await call(h, db, { action: 'start', query: 'Eliot' });
    const { status, data } = await call(h, db, REQUEST(s.session_id));
    assert.equal(status, 201);
    assert.match(data.request_code, /^PL-261113-[A-HJ-NP-Z2-9]{4}$/);
    const row = db.raw.prepare('SELECT * FROM librero_requests').get();
    assert.equal(row.contact_kind, 'whatsapp');
    assert.equal(row.contact_value, '099123456');
    assert.equal(row.consent_reply, 1);
    assert.equal(row.contact_preferred_time, 'mañana por la tarde');
    const shared = db.raw.prepare('SELECT * FROM book_requests').get();
    assert.equal(shared.public_code, data.request_code);
    assert.equal(shared.request_type, 'sin-resultados');
    assert.ok(!JSON.stringify(shared).includes('099123456'), 'el contacto no va a book_requests');
    assert.equal(db.raw.prepare('SELECT outcome FROM librero_sessions').get().outcome, 'request');
});

test('un reintento con la misma clave devuelve el mismo código y no duplica', async () => {
    const db = d1();
    const h = handler();
    const { data: s } = await call(h, db, { action: 'start', query: 'Eliot' });
    const first = await call(h, db, REQUEST(s.session_id));
    const again = await call(h, db, REQUEST(s.session_id));
    assert.equal(again.status, 200);
    assert.equal(again.data.request_code, first.data.request_code);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM librero_requests').get().n, 1);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM book_requests').get().n, 1);
});

test('sin autorización para responder no se guarda el contacto', async () => {
    const db = d1();
    const h = handler();
    const { data: s } = await call(h, db, { action: 'start', query: 'Eliot' });
    const res = await call(h, db, REQUEST(s.session_id, { consent_reply: false }));
    assert.equal(res.status, 400);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM librero_requests').get().n, 0);
});

test('el pedido sin contacto también se guarda (se puede seguir por WhatsApp con el código)', async () => {
    const db = d1();
    const h = handler();
    const { data: s } = await call(h, db, { action: 'start', query: 'Eliot' });
    const res = await call(h, db, REQUEST(s.session_id, { contact_kind: undefined, contact_value: undefined, consent_reply: undefined }));
    assert.equal(res.status, 201);
    const row = db.raw.prepare('SELECT * FROM librero_requests').get();
    assert.equal(row.contact_value, null);
    assert.equal(row.consent_reply, 0);
});

test('pedido de una sesión que no existe, o enviado muy seguido, se rechaza', async () => {
    const db = d1();
    const h = handler();
    assert.equal((await call(h, db, REQUEST('sesion-falsa'))).status, 404);
    const { data: s } = await call(h, db, { action: 'start', query: 'Eliot' });
    for (let i = 0; i < LIMITS.requestsPerHour; i++) {
        assert.equal((await call(h, db, REQUEST(s.session_id, { idempotency_key: `clave-numero-${i}-xx` }))).status, 201);
    }
    assert.equal((await call(h, db, REQUEST(s.session_id, { idempotency_key: 'clave-numero-9-xx' }))).status, 429);
});

test('validateRequest rechaza contactos mal formados o demasiado largos', () => {
    const base = REQUEST('s');
    assert.equal(validateRequest({ ...base, contact_kind: 'email', contact_value: 'no-es-mail' }).ok, false);
    assert.equal(validateRequest({ ...base, contact_value: '12' }).ok, false);
    assert.equal(validateRequest({ ...base, contact_value: '1'.repeat(200) }).ok, false);
    assert.equal(validateRequest({ ...base, contact_kind: 'email', contact_value: 'Ana@Ejemplo.com' }).value.contact_value, 'ana@ejemplo.com');
    assert.equal(validateRequest({ ...base, budget_uyu: -5 }).ok, false);
});

test('buildSummary no incluye el contacto', () => {
    const { value } = validateRequest(REQUEST('s'));
    const summary = buildSummary(value);
    assert.match(summary, /acepta usado/);
    assert.match(summary, /solo esa edición/);
    assert.ok(!summary.includes('099'));
});

test('rechaza otro origen, métodos distintos, cuerpo enorme, bots y base ausente', async () => {
    const db = d1();
    const h = handler();
    assert.equal((await call(h, db, { action: 'start', query: 'x y' }, { origin: 'https://malo.example' })).status, 403);
    const get = await h({ request: new Request('https://www.amadolibros.com/api/librero'), env: { ORDERS_DB: db } });
    assert.equal(get.status, 405);
    assert.equal((await call(h, db, 'x'.repeat(9000))).status, 413);
    const trap = await call(h, db, { action: 'start', query: 'Eliot', website: 'spam.example' });
    assert.equal(trap.status, 202);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM librero_sessions').get().n, 0);
    const noDb = await h({ request: post({ action: 'start', query: 'Eliot' }), env: {} });
    assert.equal(noDb.status, 503);
    assert.equal((await call(h, db, { action: 'borrar-todo' })).status, 400);
});

test('con varias palabras, una sola coincidencia no alcanza', () => {
    const items = [
        { id: 'MLU10', title: 'El Malinois Del Pastor Belga Perro Raza', author: 'X', status: 'active', available_quantity: 1, price: 1 },
        { id: 'MLU11', title: 'El perro azul', author: 'Nadja', status: 'active', available_quantity: 1, price: 1 },
    ];
    // «azl» solo se corrige porque «perro» sostiene la búsqueda en el mismo libro.
    assert.deepEqual(suggestCandidates(items, 'el perro azl').map(b => b.id), ['MLU11']);
    assert.deepEqual(suggestCandidates(items.slice(0, 1), 'el perro azl'), []);
});
