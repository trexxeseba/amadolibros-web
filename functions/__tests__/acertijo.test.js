import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import DATA from '../_shared/acertijos-data.js';
import {
    normalizarRespuesta, acertijoDelDia, diasDesdeEpoca, esRespuestaCorrecta, regaloTexto,
} from '../_shared/acertijos.js';
import { RUEDA_PREMIOS, CODIGO_RE, PREMIO_MAX_UYU } from '../_shared/juego.js';
import { createAcertijoHandler, PREMIO_ACIERTO_UYU } from '../api/_acertijo_handler.js';
import { RATE_LIMIT } from '../api/_rueda_handler.js';
import { acertijoHtml, ACERTIJO_SCRIPT, ACERTIJO_STYLES } from '../_shared/acertijo-ui.js';

const NOW = new Date('2026-11-10T15:00:00.000Z');
const DIA = '2026-11-10';
const HOY = acertijoDelDia(DIA);

function d1() {
    const db = new DatabaseSync(':memory:');
    db.exec(readFileSync('migrations/0017_juego_codigos.sql', 'utf8'));
    db.exec(readFileSync('migrations/0018_juego_acertijo.sql', 'utf8'));
    db.exec(readFileSync('migrations/0019_juego_premios_en_pesos.sql', 'utf8'));
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

const post = (body, { ip = '203.0.113.7' } = {}) => new Request('https://www.amadolibros.com/api/acertijo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, Origin: 'https://www.amadolibros.com' },
    body: JSON.stringify(body),
});
let n = 0;
const handler = (opts = {}) => createAcertijoHandler({ getNow: () => NOW, codeBytes: () => Uint8Array.from([n++, n++, n++, n++, n++]), ...opts });
const correcta = () => HOY.respuestas[0];

test('hay 14 acertijos de borrador, con id único, respuestas y libro', () => {
    assert.equal(DATA.acertijos.length, 14);
    assert.equal(new Set(DATA.acertijos.map(a => a.id)).size, 14);
    for (const a of DATA.acertijos) {
        assert.equal(a.borrador, true, `${a.id} debe estar marcado como borrador`);
        assert.ok(a.pregunta.length > 20 && a.respuestas.length >= 1 && a.libro.buscar, a.id);
        assert.ok(a.respuestas.every(r => r === normalizarRespuesta(r)), `${a.id}: respuestas ya normalizadas`);
    }
});

test('el módulo generado está al día con data/acertijos.json', () => {
    execFileSync('node', ['scripts/acertijos/generar.mjs', '--check'], { stdio: 'pipe' });
});

test('normalización y comparación de respuestas', () => {
    assert.equal(normalizarRespuesta('  ¡Gabriel García-Márquez!  '), 'gabriel garcia marquez');
    const a = DATA.acertijos[0]; // García Márquez
    assert.ok(esRespuestaCorrecta('García Márquez', a));
    assert.ok(esRespuestaCorrecta('  GABRIEL GARCÍA MÁRQUEZ ', a));
    assert.ok(esRespuestaCorrecta('creo que fue Gabo', a), 'contiene la respuesta como palabra completa');
    assert.ok(!esRespuestaCorrecta('Cortázar', a));
    assert.ok(!esRespuestaCorrecta('', a));
    assert.ok(!esRespuestaCorrecta('g', a));
    assert.ok(!esRespuestaCorrecta('gabon', a), 'no acepta fragmentos de palabra');
    assert.ok(!esRespuestaCorrecta('x', null));
});

test('rotación diaria: cambia cada día, recorre los 14 y se repite', () => {
    const vistos = new Set();
    for (let i = 0; i < 14; i++) {
        const dia = new Date(Date.parse(`${DIA}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
        vistos.add(acertijoDelDia(dia).id);
    }
    assert.equal(vistos.size, 14);
    assert.notEqual(acertijoDelDia('2026-11-10').id, acertijoDelDia('2026-11-11').id);
    assert.equal(acertijoDelDia('2026-11-10').id, acertijoDelDia('2026-11-24').id);
    assert.equal(diasDesdeEpoca('1970-01-02'), 1);
    assert.equal(acertijoDelDia('2026-11-10', { acertijos: [] }), null);
});

test('el regalo es configurable por JSON y por variable', () => {
    assert.equal(regaloTexto({}), 'Marcapáginas de Amado');
    assert.equal(regaloTexto({ ACERTIJO_REGALO: 'envio-express' }), 'Envío express en Montevideo el mismo día');
    assert.equal(regaloTexto({ ACERTIJO_REGALO: 'otra-cosa' }), 'Marcapáginas de Amado');
});

test('GET devuelve el acertijo de hoy sin respuestas ni sin caché', async () => {
    const res = await handler()({ request: new Request('https://www.amadolibros.com/api/acertijo'), env: {} });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    const body = await res.json();
    assert.equal(body.id, HOY.id);
    assert.equal(body.dia, DIA);
    const txt = JSON.stringify(body);
    for (const r of HOY.respuestas) assert.ok(!txt.toLowerCase().includes(`"${r}"`), 'no revela la respuesta');
    assert.ok(!('respuestas' in body) && !('libro' in body) && !('borrador' in body));
});

test('acierto: código de $450 (el premio máximo) con regalo', async () => {
    assert.equal(PREMIO_ACIERTO_UYU, PREMIO_MAX_UYU);
    const db = d1();
    const res = await handler()({ request: post({ id: HOY.id, respuesta: correcta(), whatsapp: '099 841 325' }), env: { ORDERS_DB: db } });
    assert.equal(res.status, 201);
    const d = await res.json();
    assert.equal(d.acerto, true);
    assert.equal(d.consuelo, false);
    assert.equal(d.monto_uyu, 450);
    assert.equal(d.regalo, 'Marcapáginas de Amado');
    assert.match(d.code, CODIGO_RE);
    const row = db.raw.prepare('SELECT * FROM juego_codigos').get();
    assert.equal(row.origen, 'acertijo');
    assert.ok(!JSON.stringify(row).includes('99841325'));
});

test('error: consuelo con un premio de la Rueda, sin regalo y sin pasar el tope', async () => {
    const db = d1();
    const res = await handler({ roll: () => 60 })({ request: post({ id: HOY.id, respuesta: 'ni idea', whatsapp: '099841325' }), env: { ORDERS_DB: db } });
    assert.equal(res.status, 201);
    const d = await res.json();
    assert.equal(d.acerto, false);
    assert.equal(d.consuelo, true);
    assert.equal(d.regalo, null);
    assert.equal(d.monto_uyu, 250);
    assert.ok(RUEDA_PREMIOS.some(p => p.monto === d.monto_uyu) && d.monto_uyu <= 450);
});

test('un intento por día y por número: el segundo ve el mismo resultado', async () => {
    const db = d1();
    const h = handler({ roll: () => 0 });
    const a = await (await h({ request: post({ id: HOY.id, respuesta: 'no se', whatsapp: '099841325' }), env: { ORDERS_DB: db } })).json();
    const r2 = await h({ request: post({ id: HOY.id, respuesta: correcta(), whatsapp: '+598 99 841 325' }, { ip: '198.51.100.4' }), env: { ORDERS_DB: db } });
    assert.equal(r2.status, 200);
    const b = await r2.json();
    assert.equal(b.code, a.code);
    assert.equal(b.repeat, true);
    assert.equal(b.acerto, false, 'acertar después no cambia el resultado del día');
    assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM juego_codigos').get().n, 1);
});

test('el acertijo y la rueda del mismo día son independientes', async () => {
    const db = d1();
    db.raw.prepare("INSERT INTO juego_codigos (code, origen, monto_uyu, wa_hash, dia, created_at, expires_at) VALUES ('LIB-AAAAA','rueda',150,'otro','2026-11-10','2026-11-10T10:00:00Z','2026-11-12T10:00:00Z')").run();
    const res = await handler()({ request: post({ id: HOY.id, respuesta: correcta(), whatsapp: '099841325' }), env: { ORDERS_DB: db } });
    assert.equal(res.status, 201);
    assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM juego_codigos').get().n, 2);
});

test('validaciones: id viejo, respuesta vacía, número, trampa, método y límite por IP', async () => {
    const db = d1();
    const env = { ORDERS_DB: db };
    const h = handler();
    assert.equal((await h({ request: post({ id: 'a99', respuesta: 'x', whatsapp: '099841325' }), env })).status, 409);
    assert.equal((await h({ request: post({ id: HOY.id, respuesta: '', whatsapp: '099841325' }), env })).status, 400);
    assert.equal((await h({ request: post({ id: HOY.id, respuesta: 'x', whatsapp: '123' }), env })).status, 400);
    const trampa = await h({ request: post({ id: HOY.id, respuesta: 'x', whatsapp: '099841325', website: 'spam' }), env });
    assert.equal(trampa.status, 202);
    assert.equal((await h({ request: new Request('https://www.amadolibros.com/api/acertijo', { method: 'DELETE' }), env })).status, 405);
    assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM juego_codigos').get().n, 0);
    for (let i = 0; i < RATE_LIMIT.max; i++) {
        assert.equal((await h({ request: post({ id: HOY.id, respuesta: 'x', whatsapp: `09900${2000 + i}` }, { ip: '192.0.2.77' }), env })).status, 201);
    }
    assert.equal((await h({ request: post({ id: HOY.id, respuesta: 'x', whatsapp: '099009999' }, { ip: '192.0.2.77' }), env })).status, 429);
});

test('el acierto no se decide en el navegador', () => {
    assert.doesNotMatch(ACERTIJO_SCRIPT, /respuestas|esRespuestaCorrecta|normalizarRespuesta/);
    assert.match(ACERTIJO_SCRIPT, /fetch\('\/api\/acertijo'/);
});

test('pantalla del Acertijo: positiva, sin términos prohibidos y con los eventos', () => {
    const html = acertijoHtml();
    assert.match(html, /id="acertijo-form"/);
    assert.match(html, /name="website"/);
    assert.match(html, /wa\.me\/59899841325\?text=__CODIGO__/);
    assert.match(ACERTIJO_STYLES, /\.acertijo\[hidden\]\{display:none\}/);
    assert.doesNotMatch(html + ACERTIJO_SCRIPT, /únicamente|sólo|solo |inteligencia artificial/i);
    for (const e of ['juego_visto', 'acertijo_respondido', 'codigo_enviado_whatsapp']) assert.match(ACERTIJO_SCRIPT, new RegExp(e));
    const liq = readFileSync('functions/liquidacion.js', 'utf8');
    for (const t of ['${acertijoHtml()}', '${ACERTIJO_SCRIPT}', '${ACERTIJO_STYLES}']) assert.ok(liq.includes(t), t);
});

test('la migración del acertijo crea el índice de un intento diario', () => {
    assert.match(readFileSync('migrations/0018_juego_acertijo.sql', 'utf8'), /UNIQUE INDEX IF NOT EXISTS idx_juego_codigos_un_acertijo_diario[\s\S]*WHERE origen = 'acertijo'/);
});
