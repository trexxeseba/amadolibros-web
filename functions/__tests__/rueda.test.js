import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
    RUEDA_PREMIOS, validarPremios, drawPrize, randomInt, diaMontevideo, generarCodigo, normalizarCodigo,
    normalizarWhatsapp, hashWhatsapp, precioConPremio, CODIGO_RE, CODIGO_VIGENCIA_HORAS, mensajeCodigoWhatsapp,
} from '../_shared/juego.js';
import { MAX_TOTAL_DISCOUNT, PRICE_FLOOR_UYU } from '../_shared/descuentos.js';
import { createRuedaHandler, PREVIEW_TABLE_SQL, RATE_LIMIT } from '../api/_rueda_handler.js';
import { createCanjePanel, estadoCodigo } from '../panel/canje.js';
import { ruedaHtml, RUEDA_SCRIPT, RUEDA_STYLES } from '../_shared/rueda-ui.js';

const NOW = new Date('2026-11-10T15:00:00.000Z');

function d1() {
    const db = new DatabaseSync(':memory:');
    db.exec(readFileSync('migrations/0017_juego_codigos.sql', 'utf8'));
    return {
        raw: db,
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

const post = (body, { ip = '203.0.113.7', origin = 'https://www.amadolibros.com' } = {}) => new Request('https://www.amadolibros.com/api/rueda', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...(origin ? { Origin: origin } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
});

let n = 0;
const handler = (opts = {}) => createRuedaHandler({
    getNow: () => NOW,
    codeBytes: () => Uint8Array.from([n++, n++, n++, n++, n++]),
    ...opts,
});

test('los premios suman 100 y ninguno pasa el tope de 25 %', () => {
    assert.equal(RUEDA_PREMIOS.reduce((s, p) => s + p.peso, 0), 100);
    assert.ok(RUEDA_PREMIOS.every(p => p.pct / 100 <= MAX_TOTAL_DISCOUNT));
    assert.deepEqual(RUEDA_PREMIOS.map(p => [p.pct, p.peso]), [[10, 35], [12, 25], [15, 20], [18, 10], [20, 6], [25, 4]]);
    assert.throws(() => validarPremios([{ pct: 30, peso: 100 }]), /supera el tope/);
    assert.throws(() => validarPremios([{ pct: 10, peso: 90 }]), /suman/);
});

test('drawPrize respeta los pesos en los bordes y en distribución', () => {
    assert.equal(drawPrize(0).pct, 10);
    assert.equal(drawPrize(34).pct, 10);
    assert.equal(drawPrize(35).pct, 12);
    assert.equal(drawPrize(59).pct, 12);
    assert.equal(drawPrize(60).pct, 15);
    assert.equal(drawPrize(80).pct, 18);
    assert.equal(drawPrize(90).pct, 20);
    assert.equal(drawPrize(96).pct, 25);
    assert.equal(drawPrize(99).pct, 25);
    const counts = {};
    for (let i = 0; i < 20000; i++) { const p = drawPrize(randomInt(100)).pct; counts[p] = (counts[p] || 0) + 1; }
    for (const p of RUEDA_PREMIOS) assert.ok(Math.abs(counts[p.pct] / 200 - p.peso) < 2, `premio ${p.pct}`);
});

test('códigos legibles, sin caracteres ambiguos, y normalización', () => {
    for (let i = 0; i < 200; i++) assert.match(generarCodigo(), CODIGO_RE);
    assert.equal(normalizarCodigo(' lib 7k3m2 '), 'LIB-7K3M2');
    assert.equal(normalizarCodigo('LIB-7K3M2'), 'LIB-7K3M2');
    assert.equal(normalizarCodigo('LIB-0O1I2'), null);
    assert.equal(normalizarCodigo('hola'), null);
});

test('número de WhatsApp: formas válidas y hash diario sin el número', async () => {
    for (const v of ['099 841 325', '+598 99 841 325', '59899841325', '0059899841325', '99841325']) assert.equal(normalizarWhatsapp(v), '59899841325', v);
    for (const v of ['', '12345', '+54 9 11 1234 5678', '098', '02 123 4567']) assert.equal(normalizarWhatsapp(v), null, v);
    const h1 = await hashWhatsapp('59899841325', '2026-11-10');
    assert.match(h1, /^[0-9a-f]{64}$/);
    assert.ok(!h1.includes('99841325'));
    assert.notEqual(h1, await hashWhatsapp('59899841325', '2026-11-11'));
    assert.equal(diaMontevideo(new Date('2026-11-11T02:00:00Z')), '2026-11-10');
});

test('precio con premio: tope, transferencia solo si entra y piso de $1.200', () => {
    assert.deepEqual(precioConPremio(2000, 15), { ok: true, price: 1700, totalPct: 15, transferSumada: false, reason: 'ok' });
    const conTransf = precioConPremio(2000, 10, { transferencia: true });
    assert.equal(conTransf.totalPct, 22);
    assert.equal(conTransf.transferSumada, true);
    // 15 + 12 pasa el tope: la transferencia completa hasta 25 %, nunca deja al cliente peor que sin premio.
    const quince = precioConPremio(2000, 15, { transferencia: true });
    assert.equal(quince.totalPct, 25);
    assert.equal(quince.price, 1500);
    assert.equal(quince.transferSumada, true);
    for (const p of RUEDA_PREMIOS) {
        const con = precioConPremio(2000, p.pct, { transferencia: true });
        const base = precioConPremio(2000, 10, { transferencia: true });
        assert.ok(con.price <= base.price, `premio ${p.pct}% no puede costar más que el 10% + transferencia`);
        assert.ok(con.totalPct <= MAX_TOTAL_DISCOUNT * 100);
    }
    const veinticinco = precioConPremio(2000, 25, { transferencia: true });
    assert.equal(veinticinco.totalPct, 25);
    assert.equal(veinticinco.transferSumada, false, 'el 25 % ya está en el tope');
    assert.equal(precioConPremio(1400, 25).reason, 'bajo_piso');
    assert.ok(precioConPremio(1600, 25).price >= PRICE_FLOOR_UYU);
    assert.equal(precioConPremio(2000, 99).totalPct, 25, 'nunca pasa el tope aunque el dato venga mal');
    assert.equal(precioConPremio('x', 10).reason, 'precio_invalido');
});

test('POST /api/rueda: el servidor decide el premio y entrega un código de 48 horas', async () => {
    const db = d1();
    const res = await handler({ roll: () => 97 })({ request: post({ whatsapp: '099 841 325' }), env: { ORDERS_DB: db } });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.discount_pct, 25);
    assert.match(data.code, CODIGO_RE);
    assert.equal(data.valid_hours, CODIGO_VIGENCIA_HORAS);
    assert.equal(data.expires_at, '2026-11-12T15:00:00.000Z');
    const row = db.raw.prepare('SELECT * FROM juego_codigos').get();
    assert.equal(row.origen, 'rueda');
    assert.equal(row.used_at, null);
    assert.ok(!JSON.stringify(row).includes('99841325'), 'no se guarda el número');
});

test('un giro por día y por número: el segundo devuelve el mismo código', async () => {
    const db = d1();
    const h = handler({ roll: () => 0 });
    const a = await (await h({ request: post({ whatsapp: '099841325' }), env: { ORDERS_DB: db } })).json();
    const r2 = await h({ request: post({ whatsapp: '+598 99 841 325' }, { ip: '198.51.100.9' }), env: { ORDERS_DB: db } });
    assert.equal(r2.status, 200);
    const b = await r2.json();
    assert.equal(b.code, a.code);
    assert.equal(b.repeat, true);
    assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM juego_codigos').get().n, 1);
});

test('un código ya usado o vencido no da otro giro el mismo día', async () => {
    const db = d1();
    const h = handler({ roll: () => 0 });
    const a = await (await h({ request: post({ whatsapp: '099841325' }), env: { ORDERS_DB: db } })).json();
    db.raw.prepare('UPDATE juego_codigos SET used_at=? WHERE code=?').run(NOW.toISOString(), a.code);
    const res = await h({ request: post({ whatsapp: '099841325' }), env: { ORDERS_DB: db } });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'YA_USADO');
});

test('validaciones: número inválido, trampa, origen, método y límite por IP', async () => {
    const db = d1();
    const env = { ORDERS_DB: db };
    const h = handler();
    assert.equal((await h({ request: post({ whatsapp: '123' }), env })).status, 400);
    const trampa = await h({ request: post({ whatsapp: '099841325', website: 'x.com' }), env });
    assert.equal(trampa.status, 202);
    assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM juego_codigos').get().n, 0);
    assert.equal((await h({ request: post({ whatsapp: '099841325' }, { origin: 'https://otro.com' }), env })).status, 403);
    assert.equal((await h({ request: new Request('https://www.amadolibros.com/api/rueda'), env })).status, 405);
    assert.equal((await h({ request: post('no es json'), env })).status, 400);
    for (let i = 0; i < RATE_LIMIT.max; i++) {
        const r = await h({ request: post({ whatsapp: `09900${1000 + i}` }, { ip: '192.0.2.50' }), env });
        assert.equal(r.status, 201, `giro ${i}`);
    }
    const bloqueado = await h({ request: post({ whatsapp: '099009999' }, { ip: '192.0.2.50' }), env });
    assert.equal(bloqueado.status, 429);
});

test('sin base de datos responde 503 y nunca un código', async () => {
    const res = await handler()({ request: post({ whatsapp: '099841325' }), env: {} });
    assert.equal(res.status, 503);
});

test('la tabla de preview es la misma de la migración', () => {
    const norm = s => s.replace(/--.*$/gm, '').replace(/\s+/g, ' ').replace(/ ?\( ?/g, '(').replace(/ ?\) ?/g, ')').trim();
    const mig = readFileSync('migrations/0017_juego_codigos.sql', 'utf8');
    const create = mig.match(/CREATE TABLE IF NOT EXISTS juego_codigos[\s\S]*?\);/)[0].replace(/;$/, '');
    assert.equal(norm(PREVIEW_TABLE_SQL), norm(create));
});

// ---- Canje (panel) ----
const PANEL_ENV = { APP_ENV: 'production', PANEL_PASSWORD: 'una-clave-larga-de-prueba' };

async function cookieDeSesion() {
    const { deriveSessionSecret, createSessionToken, sessionCookieHeader } = await import('../_shared/panel-auth.js');
    const token = await createSessionToken(await deriveSessionSecret(PANEL_ENV.PANEL_PASSWORD));
    return sessionCookieHeader(token).split(';')[0];
}

function canjeReq(cookie, fields) {
    return new Request('https://www.amadolibros.com/panel/canje', {
        method: 'POST',
        headers: { cookie, origin: 'https://www.amadolibros.com', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
    });
}

test('el canje exige sesión del panel y producción', async () => {
    const panel = createCanjePanel({ getNow: () => NOW });
    const sinSesion = await panel({ request: new Request('https://www.amadolibros.com/panel/canje'), env: { APP_ENV: 'production', ORDERS_DB: d1() } });
    assert.equal(sinSesion.status, 303);
    const preview = await panel({ request: new Request('https://www.amadolibros.com/panel/canje'), env: { APP_ENV: 'preview' } });
    assert.equal(preview.status, 403);
});

test('canje: verificar no cambia nada; marcar como usado funciona una sola vez', async () => {
    const db = d1();
    const env = { ...PANEL_ENV, ORDERS_DB: db };
    const h = handler({ roll: () => 0 });
    const { code } = await (await h({ request: post({ whatsapp: '099841325' }), env: { ORDERS_DB: db } })).json();
    const panel = createCanjePanel({ getNow: () => NOW });
    const cookie = await cookieDeSesion();

    const ver = await panel({ request: canjeReq(cookie, { codigo: code.toLowerCase(), accion: 'verificar' }), env });
    assert.equal(ver.status, 200);
    const html = await ver.text();
    assert.match(html, /Código vigente/);
    assert.match(html, /10%/);
    assert.equal(db.raw.prepare('SELECT used_at FROM juego_codigos').get().used_at, null);

    const uso = await panel({ request: canjeReq(cookie, { codigo: code, accion: 'usar' }), env });
    assert.match(await uso.text(), /quedó marcado como usado/);
    assert.equal(db.raw.prepare('SELECT used_at FROM juego_codigos').get().used_at, NOW.toISOString());

    const otraVez = await panel({ request: canjeReq(cookie, { codigo: code, accion: 'usar' }), env });
    const t = await otraVez.text();
    assert.doesNotMatch(t, /quedó marcado como usado/);
    assert.match(t, /Ya fue usado/);

    const inexistente = await panel({ request: canjeReq(cookie, { codigo: 'LIB-ZZZZZ', accion: 'verificar' }), env });
    assert.match(await inexistente.text(), /No encontramos ese código/);
    const malFormato = await panel({ request: canjeReq(cookie, { codigo: 'hola', accion: 'verificar' }), env });
    assert.equal(malFormato.status, 400);
});

test('canje: un código vencido no se puede usar', async () => {
    const db = d1();
    const env = { ...PANEL_ENV, ORDERS_DB: db };
    db.raw.prepare("INSERT INTO juego_codigos (code, origen, discount_pct, wa_hash, dia, created_at, expires_at) VALUES ('LIB-ABCDE','rueda',12,'h','2026-11-01','2026-11-01T10:00:00Z','2026-11-03T10:00:00Z')").run();
    const res = await createCanjePanel({ getNow: () => NOW })({ request: canjeReq(await cookieDeSesion(), { codigo: 'LIB-ABCDE', accion: 'usar' }), env });
    assert.match(await res.text(), /Venció/);
    assert.equal(db.raw.prepare('SELECT used_at FROM juego_codigos').get().used_at, null);
});

test('estadoCodigo: vigente, usado, vencido e inexistente', () => {
    const ahora = NOW.toISOString();
    assert.equal(estadoCodigo(null, ahora).estado, 'inexistente');
    assert.equal(estadoCodigo({ expires_at: '2026-11-12T00:00:00Z', used_at: null }, ahora).estado, 'vigente');
    assert.equal(estadoCodigo({ expires_at: '2026-11-12T00:00:00Z', used_at: ahora }, ahora).estado, 'usado');
    assert.equal(estadoCodigo({ expires_at: '2026-11-09T00:00:00Z', used_at: null }, ahora).estado, 'vencido');
});

test('la pantalla de la Rueda: texto en positivo, tope y accesibilidad', () => {
    const html = ruedaHtml();
    assert.match(html, /id="rueda-form"/);
    assert.match(html, /name="website"/, 'campo trampa');
    assert.match(html, /aria-label="Rueda con premios de 10% a 25%/);
    assert.match(html, /wa\.me\/59899841325\?text=__CODIGO__/);
    assert.doesNotMatch(html + RUEDA_SCRIPT, /únicamente|sólo|solo |inteligencia artificial|🙂|🎰/i);
    assert.match(RUEDA_STYLES, /prefers-reduced-motion:reduce/);
    assert.match(RUEDA_SCRIPT, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
    for (const e of ['juego_visto', 'rueda_girada', 'codigo_enviado_whatsapp']) assert.match(RUEDA_SCRIPT, new RegExp(e));
    assert.match(mensajeCodigoWhatsapp('LIB-ABCDE'), /^Hola, tengo el código LIB-ABCDE para este libro$/);
});

test('el premio nunca se decide en el navegador', () => {
    assert.doesNotMatch(RUEDA_SCRIPT, /Math\.random\(\)\s*\*\s*100|drawPrize/);
    assert.match(RUEDA_SCRIPT, /fetch\('\/api\/rueda'/);
});

test('/liquidacion incluye la Rueda y su script', () => {
    const src = readFileSync('functions/liquidacion.js', 'utf8');
    assert.match(src, /\$\{ruedaHtml\(\)\}/);
    assert.match(src, /\$\{RUEDA_SCRIPT\}/);
    assert.match(src, /\$\{RUEDA_STYLES\}/);
});
