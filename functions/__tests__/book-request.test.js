import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
    createBookRequestHandler, validateBookRequest, generateRequestCode, RATE_LIMIT, REQUEST_TYPES, normalizeReplyContact,
} from '../api/_book_request_handler.js';

import { buildBookRequestEmail, createBookRequestNotifier } from '../api/_book_request_email.js';

const NOW = new Date('2026-11-10T15:00:00.000Z');

/** D1 mínimo sobre node:sqlite con la migración real. */
function d1() {
    const db = new DatabaseSync(':memory:');
    db.exec(readFileSync('migrations/0016_book_requests.sql', 'utf8'));
    db.exec(readFileSync('migrations/0023_book_request_contacts.sql', 'utf8'));
    db.exec('PRAGMA foreign_keys=ON');
    return {
        raw: db,
        async batch(statements) {
            db.exec('BEGIN');
            try {
                const results = [];
                for (const stmt of statements) results.push(await stmt.run());
                db.exec('COMMIT');
                return results;
            } catch (error) { db.exec('ROLLBACK'); throw error; }
        },
        prepare(sql) {
            const stmt = db.prepare(sql);
            const bound = (...args) => ({
                first: async () => stmt.get(...args) ?? null,
                run: async () => { const r = stmt.run(...args); return { meta: { changes: Number(r.changes) } }; },
            });
            return { bind: bound, ...bound() };
        },
    };
}

function post(body, { ip = '203.0.113.7', origin = 'https://www.amadolibros.com', contentType = 'application/json' } = {}) {
    const headers = { 'Content-Type': contentType, 'CF-Connecting-IP': ip };
    if (origin) headers.Origin = origin;
    return new Request('https://www.amadolibros.com/api/book-request', {
        method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

const VALID = {
    request_type: 'agotado', query: 'Rayuela, primera edición', author_isbn: 'Cortázar',
    format: 'Libro físico', language: 'Español', budget: 1800, details: 'Tapa dura',
    source_url: 'https://www.amadolibros.com/pedir-libro/?tipo=agotado',
};

let seq = 0;
const handler = (opts = {}) => createBookRequestHandler({
    getNow: () => NOW,
    random: () => Uint8Array.from([seq++, seq++, seq++, seq++]),
    ...opts,
});

test('registra el pedido y devuelve 201 con un código corto', async () => {
    const db = d1();
    const res = await handler()({ request: post(VALID), env: { ORDERS_DB: db } });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.received, true);
    assert.match(data.request_code, /^PL-261110-[A-HJ-NP-Z2-9]{4}$/);
    const row = db.raw.prepare('SELECT * FROM book_requests').get();
    assert.equal(row.public_code, data.request_code);
    assert.equal(row.request_type, 'agotado');
    assert.equal(row.query, 'Rayuela, primera edición');
    assert.equal(row.budget_uyu, 1800);
    assert.equal(row.status, 'received');
    assert.match(row.ip_hash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(row).includes('203.0.113.7'), false, 'la IP no se guarda en claro');
});

test('validación: tipo, texto y largo', () => {
    assert.equal(validateBookRequest({ ...VALID, request_type: 'otro' }).ok, false);
    assert.equal(validateBookRequest({ ...VALID, query: ' ' }).ok, false);
    assert.equal(validateBookRequest({ ...VALID, query: 'x'.repeat(301) }).ok, false);
    assert.equal(validateBookRequest({ ...VALID, budget: -5 }).ok, false);
    assert.equal(validateBookRequest([]).ok, false);
    const ok = validateBookRequest({ ...VALID, format: 'inventado', source_url: 'https://evil.example/x' });
    assert.equal(ok.value.format, null);
    assert.equal(ok.value.source_url, null);
    for (const type of ['exacto', 'sin-resultados', 'tapa', 'regalo']) assert.ok(REQUEST_TYPES.includes(type));
});

test('errores no registran nada ni devuelven código', async () => {
    const db = d1();
    const h = handler();
    assert.equal((await h({ request: post({ ...VALID, query: '' }), env: { ORDERS_DB: db } })).status, 400);
    assert.equal((await h({ request: post('{malo'), env: { ORDERS_DB: db } })).status, 400);
    assert.equal((await h({ request: post(VALID, { contentType: 'text/plain' }), env: { ORDERS_DB: db } })).status, 415);
    assert.equal((await h({ request: post(VALID, { origin: 'https://evil.example' }), env: { ORDERS_DB: db } })).status, 403);
    assert.equal((await h({ request: post(VALID), env: {} })).status, 503);
    assert.equal((await h({ request: new Request('https://www.amadolibros.com/api/book-request'), env: { ORDERS_DB: db } })).status, 405);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM book_requests').get().n, 0);
});

test('campo trampa: responde sin registrar y sin código', async () => {
    const db = d1();
    const res = await handler()({ request: post({ ...VALID, website: 'http://spam' }), env: { ORDERS_DB: db } });
    assert.equal(res.status, 202);
    const data = await res.json();
    assert.equal(data.received, false);
    assert.equal(data.request_code, undefined);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM book_requests').get().n, 0);
});

test('límite por IP: el sexto pedido en 10 minutos no se registra', async () => {
    const db = d1();
    const h = handler();
    for (let i = 0; i < RATE_LIMIT.max; i++) {
        assert.equal((await h({ request: post(VALID), env: { ORDERS_DB: db } })).status, 201);
    }
    const res = await h({ request: post(VALID), env: { ORDERS_DB: db } });
    assert.equal(res.status, 429);
    assert.equal((await h({ request: post(VALID, { ip: '198.51.100.1' }), env: { ORDERS_DB: db } })).status, 201);
});

test('si la base falla, 503 y sin código (no hay conversión)', async () => {
    const broken = { prepare() { throw new Error('d1 caído'); } };
    const res = await handler()({ request: post(VALID), env: { ORDERS_DB: broken } });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).request_code, undefined);
});

test('código: fecha de Montevideo y alfabeto sin caracteres ambiguos', () => {
    assert.equal(generateRequestCode(new Date('2026-11-10T02:30:00Z'), Uint8Array.from([0, 1, 2, 3])), 'PL-261109-ABCD');
    for (let i = 0; i < 200; i++) {
        assert.match(generateRequestCode(NOW), /^PL-261110-[A-HJ-NP-Z2-9]{4}$/);
    }
});

// ── Formulario ───────────────────────────────────────────────────────────

const page = readFileSync('astro-front/src/pages/pedir-libro.astro', 'utf8');

test('book_request_submitted se dispara solo con el pedido recibido, no al tocar el botón', () => {
    const submit = page.slice(page.indexOf("form.addEventListener('submit'"));
    const register = submit.indexOf('await registerRequest(');
    const track = submit.indexOf('if (code) await trackSubmitted(type, code);');
    assert.ok(register > 0 && track > register, 'primero registra, después mide');
    assert.equal((page.match(/'book_request_submitted'/g) || []).length, 1);
    assert.match(page, /response\.status === 201 && data\?\.received === true/);
    // El clic en sí no dispara el evento: no hay gtag de book_request_submitted fuera de trackSubmitted.
    const trackFn = page.slice(page.indexOf('function trackSubmitted'), page.indexOf("form.addEventListener('submit'"));
    assert.match(trackFn, /'book_request_submitted'/);
});

test('el mensaje de WhatsApp lleva el código y el texto de privacidad dice la verdad', () => {
    assert.match(page, /if \(code\) lines\.push\(`Pedido: \$\{code\}`\)/);
    assert.doesNotMatch(page, /no guarda datos en la web/);
    assert.match(page, /Guardamos el pedido con un código/);
    assert.match(page, /name="website"/);
    assert.doesNotMatch(page, /Sólo recuerd/);
});

test('ruta y migración', () => {
    assert.match(readFileSync('functions/api/book-request.js', 'utf8'), /createBookRequestHandler\(\)/);
    assert.match(readFileSync('migrations/0016_book_requests.sql', 'utf8'), /CREATE TABLE IF NOT EXISTS book_requests/);
});

test('contacto: acepta correo o WhatsApp y rechaza datos incompletos o cabeceras inyectadas', () => {
    assert.deepEqual(normalizeReplyContact(' CLIENTE@example.test '), { type: 'email', value: 'cliente@example.test' });
    assert.deepEqual(normalizeReplyContact('099 123 456'), { type: 'whatsapp', value: '099 123 456' });
    for (const value of ['', '123', 'cliente@', 'a@example.test\nBcc: x@example.test', '<script>099123456</script>']) {
        assert.equal(normalizeReplyContact(value), null);
        assert.equal(validateBookRequest({ ...VALID, reply_contact: value }).ok, false);
    }
});

test('la solicitud con contacto se guarda y se confirma después de avisar al equipo', async () => {
    const db = d1();
    let notified = 0;
    const notify = async ({ value, code, requestId }) => {
        const stored = db.raw.prepare('SELECT * FROM book_request_contacts WHERE request_id=?').get(requestId);
        assert.equal(stored.contact_value, 'cliente@example.test');
        assert.equal(value.reply_contact.type, 'email');
        assert.match(code, /^PL-/);
        notified++;
        return { ok: true };
    };
    const res = await handler({ notify })({ request: post({ ...VALID, reply_contact: 'cliente@example.test' }), env: { ORDERS_DB: db } });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.notification_sent, true);
    assert.equal(notified, 1);
    assert.equal(JSON.stringify(data).includes('cliente@example.test'), false);
    assert.equal(db.raw.prepare('SELECT notification_sent_at FROM book_request_contacts').get().notification_sent_at, NOW.toISOString());
});

test('si falla el aviso, conserva la solicitud pero informa el problema sin confirmar el envío', async () => {
    const db = d1();
    const res = await handler({ notify: async () => ({ ok: false }) })({
        request: post({ ...VALID, reply_contact: '099 123 456' }), env: { ORDERS_DB: db },
    });
    assert.equal(res.status, 202);
    const data = await res.json();
    assert.equal(data.notification_sent, false);
    assert.match(data.error, /no pudimos avisar/);
    assert.match(data.request_code, /^PL-/);
    assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM book_request_contacts').get().n, 1);
});

test('pedido y contacto se guardan juntos: un fallo revierte ambos y no envía correo', async () => {
    const db = d1();
    db.raw.exec('DROP TABLE book_request_contacts');
    let notified = false;
    const res = await handler({ notify: async () => { notified = true; return { ok: true }; } })({
        request: post({ ...VALID, reply_contact: 'cliente@example.test' }), env: { ORDERS_DB: db },
    });
    assert.equal(res.status, 503);
    assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM book_requests').get().n, 0);
    assert.equal(notified, false);
});

test('el aviso interno incluye datos útiles y permite responder al correo del cliente', async () => {
    const value = validateBookRequest({ ...VALID, query: 'Libro <A>', reply_contact: 'cliente@example.test' }).value;
    const email = buildBookRequestEmail({ value, code: 'PL-261125-ABCD' });
    assert.match(email.html, /Libro &lt;A&gt;/);
    assert.doesNotMatch(email.html, /Libro <A>/);
    assert.equal(email.reply_to, 'cliente@example.test');
    let payload;
    const notify = createBookRequestNotifier({ fetchFn: async (url, options) => {
        assert.equal(url, 'https://api.resend.com/emails');
        assert.equal(options.headers['Idempotency-Key'], 'book-request-test-id');
        payload = JSON.parse(options.body);
        return Response.json({ id: 'email-id' });
    } });
    const result = await notify({ env: { RESEND_API_KEY: 'fake-key', SALES_NOTIFICATION_FROM: 'test@example.test', SALES_NOTIFICATION_TO: 'ops@example.test' },
        value, code: 'PL-261125-ABCD', requestId: 'test-id' });
    assert.equal(result.ok, true);
    assert.deepEqual(payload.to, ['ops@example.test']);
    assert.equal(payload.reply_to, 'cliente@example.test');
});

test('configuración ausente o rechazo de correo no produce un aviso exitoso', async () => {
    const value = validateBookRequest({ ...VALID, reply_contact: '099 123 456' }).value;
    const input = { value, code: 'PL-261125-ABCD', requestId: 'test-id' };
    const notify = createBookRequestNotifier({ fetchFn: async () => Response.json({ error: 'rechazo' }, { status: 500 }) });
    assert.equal((await notify({ ...input, env: {} })).ok, false);
    assert.equal((await notify({ ...input, env: { RESEND_API_KEY: 'fake', SALES_NOTIFICATION_FROM: 'test@example.test', SALES_NOTIFICATION_TO: 'ops@example.test' } })).ok, false);
    assert.equal(buildBookRequestEmail({ value, code: input.code }).reply_to, undefined);
});
