import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
    candidatos, vendidoEn, coberturaSuficiente, nuncaVendido, evaluar, SIN_VENTA_DIAS, MIN_PUBLICADO_DIAS, ISBN_BATCH,
} from '../../scripts/liquidacion/armar-lista.mjs';
import { resumenFinal } from '../../scripts/liquidacion/resumen.mjs';

const NOW = Date.parse('2026-11-05T12:00:00-03:00');
const DAY = 86400000;
const iso = days => new Date(NOW - days * DAY).toISOString();

// ISBN-13 válidos.
const ISBN = ['9788433920447', '9780306406157', '9783161484100', '9780131103627', '9781861972712'];

function book(id, extra = {}) {
    return { id, title: `Libro número ${id}`, isbn: null, status: 'active', available_quantity: 1, price: 1800, start_time: iso(900), ...extra };
}

test('candidatos: activos, con stock y precio, publicados hace 730 días o más', () => {
    const items = [
        book('MLU1'),
        book('MLU2', { start_time: iso(729) }),          // casi dos años
        book('MLU3', { start_time: iso(730) }),          // justo
        book('MLU4', { status: 'paused' }),
        book('MLU5', { available_quantity: 0 }),
        book('MLU6', { price: 0 }),
        book('MLU7', { start_time: null }),
    ];
    assert.deepEqual(candidatos(items, NOW).map(i => i.id), ['MLU1', 'MLU3']);
    assert.equal(MIN_PUBLICADO_DIAS, 730);
    assert.deepEqual(candidatos(null, NOW), []);
});

test('vendidoEn: venta dentro de 730 días cuenta; fuera o sin venta, no', () => {
    assert.equal(vendidoEn({ ultima_venta: iso(10) }, NOW), true);
    assert.equal(vendidoEn({ ultima_venta: iso(730) }, NOW), true);
    assert.equal(vendidoEn({ ultima_venta: iso(731) }, NOW), false);
    assert.equal(vendidoEn({ ultima_venta: null }, NOW), false);
    assert.equal(vendidoEn({}, NOW), false);
    assert.equal(SIN_VENTA_DIAS, 730);
});

test('cobertura: el histórico tiene que cubrir los 730 días', () => {
    assert.equal(coberturaSuficiente({ cobertura_desde: iso(2000) }, NOW), true);
    assert.equal(coberturaSuficiente({ cobertura_desde: iso(500) }, NOW), false);
    assert.equal(coberturaSuficiente({ cobertura_desde: null }, NOW), false);
});

/** Worker falso: ventas por ISBN y por título. */
function fakeWorker({ porIsbn = {}, porTitulo = {}, cobertura = iso(5000), calls = [] } = {}) {
    return Object.assign(async body => {
        calls.push(body);
        if (body.isbns) {
            return { resultados: body.isbns.map(isbn => ({ isbn, ultima_venta: porIsbn[isbn] ?? null, cobertura_desde: cobertura })) };
        }
        if (body.titulo in porTitulo && porTitulo[body.titulo] === 400) { const e = new Error('corto'); e.status = 400; throw e; }
        const last = porTitulo[body.titulo];
        return { titulo: body.titulo, resultados: last ? [{ ultima_venta: last }] : [] };
    }, { calls });
}

test('nuncaVendido: solo sold_quantity numérico igual a 0', () => {
    assert.equal(nuncaVendido({ sold_quantity: 0 }), true);
    assert.equal(nuncaVendido({ sold_quantity: '0' }), true);
    assert.equal(nuncaVendido({ sold_quantity: 3 }), false);
    assert.equal(nuncaVendido({ sold_quantity: null }), false);
    assert.equal(nuncaVendido({}), false);
    assert.equal(nuncaVendido({ sold_quantity: '' }), false);
});

test('evaluar con histórico completo: entran los que no vendieron por ISBN ni por título', async () => {
    const items = [
        book('MLU1', { isbn: ISBN[0] }),                       // sin ventas → entra
        book('MLU2', { isbn: ISBN[1] }),                       // vendió hace 100 días por ISBN
        book('MLU3', { isbn: ISBN[2] }),                       // vendió hace 800 días → entra
        book('MLU4', { isbn: ISBN[3], title: 'Rayuela edición especial' }),   // venta sin ISBN, por título
        book('MLU5'),                                          // sin ISBN y sin dato de que nunca vendió → no se verifica
        book('MLU6', { isbn: ISBN[4], title: 'Of' }),          // título muy corto para verificar
    ];
    const worker = fakeWorker({
        porIsbn: { [ISBN[1]]: iso(100), [ISBN[2]]: iso(800) },
        porTitulo: { 'Rayuela edición especial': iso(60), Of: 400 },
    });
    const { ids, conteos } = await evaluar(items, worker, { now: NOW });
    assert.deepEqual(ids, ['MLU1', 'MLU3']);
    assert.equal(conteos.cobertura_completa, true);
    assert.deepEqual(
        { c: conteos.candidatos, s: conteos.sin_isbn, i: conteos.vendido_por_isbn, n: conteos.titulo_no_verificable, t: conteos.vendido_por_titulo, l: conteos.en_lista },
        { c: 6, s: 1, i: 1, n: 1, t: 1, l: 2 },
    );
});

test('evaluar con histórico corto: solo entran los que nunca vendieron (sold_quantity 0)', async () => {
    const items = [
        book('MLU1', { isbn: ISBN[0], sold_quantity: 0 }),     // nunca vendió, D1 sin ventas → entra
        book('MLU2', { isbn: ISBN[1], sold_quantity: 4 }),     // vendió alguna vez y D1 no alcanza → no entra
        book('MLU3', { isbn: ISBN[2] }),                       // sin dato → no entra
        book('MLU4', { isbn: ISBN[3], sold_quantity: 0 }),     // nunca vendió pero D1 muestra venta del ISBN → no entra
        book('MLU5', { sold_quantity: 0, title: 'Libro sin código de barras' }),   // sin ISBN, nunca vendió → entra
    ];
    const worker = fakeWorker({ cobertura: iso(300), porIsbn: { [ISBN[3]]: iso(40) } });
    const { ids, conteos } = await evaluar(items, worker, { now: NOW });
    assert.deepEqual(ids, ['MLU1', 'MLU5']);
    assert.equal(conteos.cobertura_completa, false);
    assert.equal(conteos.cobertura_dias, 300);
    assert.equal(conteos.nunca_vendidos, 3);
    assert.equal(conteos.no_verificable_por_cobertura, 2);
    assert.equal(conteos.vendido_por_isbn, 1);
});

test('evaluar: una venta reciente por título saca a un libro aunque sold_quantity sea 0', async () => {
    const items = [book('MLU1', { isbn: ISBN[0], sold_quantity: 0, title: 'Ficciones de Borges' })];
    const worker = fakeWorker({ cobertura: iso(300), porTitulo: { 'Ficciones de Borges': iso(20) } });
    const { ids, conteos } = await evaluar(items, worker, { now: NOW });
    assert.deepEqual(ids, []);
    assert.equal(conteos.vendido_por_titulo, 1);
});

test('evaluar: consulta los ISBN de a 50', async () => {
    const items = Array.from({ length: 120 }, (_, i) => book(`MLU${i + 1}`, { isbn: ISBN[i % ISBN.length] }));
    const worker = fakeWorker();
    await evaluar(items, worker, { now: NOW });
    const isbnCalls = worker.calls.filter(c => c.isbns);
    assert.equal(ISBN_BATCH, 50);
    assert.ok(isbnCalls.every(c => c.isbns.length <= 50));
    assert.equal(new Set(isbnCalls.flatMap(c => c.isbns)).size, ISBN.length); // la sonda de cobertura usa uno de estos ISBN
});

test('evaluar: falla cerrada ante errores del Worker o respuestas raras', async () => {
    const items = [book('MLU1', { isbn: ISBN[0] })];
    const roto = async () => { const e = new Error('el Worker respondió 500'); e.status = 500; throw e; };
    await assert.rejects(evaluar(items, roto, { now: NOW }), /500/);
    const sinResultados = async () => ({});
    await assert.rejects(evaluar(items, sinResultados, { now: NOW }), /cobertura/);
    const rechaza = async b => ({ resultados: b.isbns.map(isbn => ({ isbn, error: 'invalid_isbn' })) });
    await assert.rejects(evaluar(items, rechaza, { now: NOW }), /cobertura/);
    // Un error del Worker por título que no es "título corto" tampoco se traga.
    const tituloRoto = async b => { if (b.isbns) return fakeWorker()(b); const e = new Error('x'); e.status = 500; throw e; };
    await assert.rejects(evaluar(items, tituloRoto, { now: NOW }), /x/);
});

test('resumenFinal: cuenta lo que sobrevive a las exclusiones', () => {
    const data = {
        lista: { ids: ['MLU1', 'MLU2', 'MLU3'] },
        excluir: { medicos: { ids: ['MLU2'] }, recientes: { ids: [] }, gana_precio: { ids: ['MLU3'] }, sin_competencia: { ids: [] } },
    };
    const items = [book('MLU1'), book('MLU2'), book('MLU3')];
    assert.deepEqual(resumenFinal(items, data), {
        lista: 3, elegibles: 1,
        excluidos: { fuera_de_stock: 0, medicos: 1, recientes: 0, gana_precio: 1, sin_competencia: 0 },
    });
    assert.deepEqual(resumenFinal(items, { lista: { ids: [] } }), { lista: 0, elegibles: 0, excluidos: null });
});

test('el workflow es solo manual, solo lee y no imprime datos ni la clave', () => {
    const wf = readFileSync('.github/workflows/liquidacion-lista.yml', 'utf8');
    assert.match(wf, /^on:\n  workflow_dispatch:\n/m);
    assert.doesNotMatch(wf, /pull_request|push:|schedule:/);
    assert.match(wf, /SYNC_SECRET: \$\{\{ secrets\.SYNC_SECRET \}\}/);
    assert.doesNotMatch(wf, /echo[^\n]*SYNC_SECRET|set -x/);
    // Solo consulta el Worker (status y query); nunca sync, reidentify ni escrituras en ML.
    assert.doesNotMatch(wf, /\/sales\/(sync|reidentify)|api\.mercadolibre|-X (POST|PUT|DELETE)/);
    // Sube a una rama nueva, nunca a main.
    assert.match(wf, /git push origin "\$branch"/);
    assert.doesNotMatch(wf, /git push[^\n]*main/);
    assert.match(wf, /liquidacion\/lista-/);
});

test('el script no imprime títulos, ISBN ni ventas, y no nombra al vendedor', () => {
    const src = readFileSync('scripts/liquidacion/armar-lista.mjs', 'utf8');
    const logs = src.match(/console\.(log|error|warn|info)\([^\n]*/g) ?? [];
    for (const line of logs) assert.doesNotMatch(line, /title|titulo|isbn|ultima_venta|item\./i, line);
    assert.doesNotMatch(src, /440298103/);
    assert.match(src, /\/sales\/query/);
    assert.doesNotMatch(src, /\/sales\/sync|\/sales\/reidentify/);
});
