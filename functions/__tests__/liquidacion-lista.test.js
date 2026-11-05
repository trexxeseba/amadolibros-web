import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
    candidatos, vendidoEn, coberturaSuficiente, nuncaVendido, evaluar, workerQuery, tipoDeConsulta, claveTitulo,
    SIN_VENTA_DIAS, MIN_PUBLICADO_DIAS, ISBN_BATCH, TITULO_CLAVE_MAX, MAX_ERRORES_TITULO,
} from '../../scripts/liquidacion/armar-lista.mjs';
import { resumenFinal, escenarioParcial } from '../../scripts/liquidacion/resumen.mjs';

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
    assert.equal(vendidoEn({ ultima_venta: iso(365) }, NOW), true);
    assert.equal(vendidoEn({ ultima_venta: iso(366) }, NOW), false);
    assert.equal(vendidoEn({ ultima_venta: null }, NOW), false);
    assert.equal(vendidoEn({}, NOW), false);
    assert.equal(SIN_VENTA_DIAS, 365, 'Seba fijó el último año el 5/11/2026');
});

test('cobertura: el histórico tiene que cubrir toda la ventana de ventas', () => {
    assert.equal(coberturaSuficiente({ cobertura_desde: iso(2000) }, NOW), true);
    assert.equal(coberturaSuficiente({ cobertura_desde: iso(377) }, NOW), true, 'D1 tiene 377 días y alcanza para un año');
    assert.equal(coberturaSuficiente({ cobertura_desde: iso(300) }, NOW), false);
    assert.equal(coberturaSuficiente({ cobertura_desde: null }, NOW), false);
});

/** Worker falso: ventas por ISBN y por título. */
function fakeWorker({ porIsbn = {}, porTitulo = {}, cobertura = iso(5000), calls = [] } = {}) {
    return Object.assign(async body => {
        calls.push(body);
        if (body.isbns) {
            return { resultados: body.isbns.map(isbn => ({ isbn, ultima_venta: porIsbn[isbn] ?? null, cobertura_desde: cobertura })) };
        }
        // Como el Worker real: un patrón LIKE de más de 50 caracteres es un 500.
        if (`%${body.titulo}%`.length > 50) { const e = new Error('internal_error'); e.status = 500; throw e; }
        const key = Object.keys(porTitulo).find(k => claveTitulo(k) === body.titulo);
        if (key !== undefined && porTitulo[key] === 400) { const e = new Error('corto'); e.status = 400; throw e; }
        const last = key === undefined ? null : porTitulo[key];
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

test('workerQuery: reintenta los 5xx y, si sigue fallando, dice qué consulta falló y el código, sin datos', async () => {
    let n = 0;
    const fetchFn = async () => { n++; return new Response(JSON.stringify({ error: 'internal_error', titulo: 'secreto' }), { status: 500 }); };
    const query = workerQuery({ worker: 'https://w.example', secret: 'x', fetchFn, sleep: async () => {} });
    await assert.rejects(query({ titulo: 'Un libro cualquiera' }), error => {
        assert.equal(error.status, 500);
        assert.equal(error.tipo, 'titulo');
        assert.match(error.message, /500 en la consulta titulo \(internal_error\)/);
        assert.doesNotMatch(error.message, /secreto|cualquiera/);
        return true;
    });
    assert.equal(n, 5);
});

test('workerQuery: un reintento exitoso alcanza', async () => {
    let n = 0;
    const fetchFn = async () => (++n < 3 ? new Response('{}', { status: 502 }) : new Response(JSON.stringify({ resultados: [] }), { status: 200 }));
    const query = workerQuery({ worker: 'https://w.example', secret: 'x', fetchFn, sleep: async () => {} });
    assert.deepEqual(await query({ isbns: ['9780306406157'] }), { resultados: [] });
    assert.equal(n, 3);
});

test('tipoDeConsulta distingue sonda, lote y título', () => {
    assert.equal(tipoDeConsulta({ titulo: 'x' }), 'titulo');
    assert.equal(tipoDeConsulta({ isbns: ['1'] }), 'isbn_uno');
    assert.equal(tipoDeConsulta({ isbns: ['1', '2'] }), 'isbn_lote');
});

test('claveTitulo: normaliza como el Worker y recorta para no pasar el límite de LIKE de D1', () => {
    assert.equal(claveTitulo('Ficciones — Edición Ilustrada, ¡Nueva!'), 'ficcionesedicionilustradanueva');
    const larga = claveTitulo('Cien años de soledad edición conmemorativa de la Real Academia Española con prólogo de Gabriel García Márquez');
    assert.equal(larga.length, TITULO_CLAVE_MAX);
    assert.ok(`%${larga}%`.length <= 50);
    assert.equal(claveTitulo(null), '');
});

test('evaluar: un título largo no rompe la consulta y su venta reciente lo saca', async () => {
    const titulo = 'Cien años de soledad edición conmemorativa de la Real Academia Española con prólogo de García Márquez';
    const items = [
        book('MLU1', { isbn: ISBN[0], sold_quantity: 0, title: titulo }),
        book('MLU2', { isbn: ISBN[1], sold_quantity: 0, title: 'Otro libro con un título extremadamente largo para probar el límite de D1' }),
    ];
    const worker = fakeWorker({ cobertura: iso(300), porTitulo: { [titulo]: iso(15) } });
    const { ids, conteos } = await evaluar(items, worker, { now: NOW });
    assert.deepEqual(ids, ['MLU2']);
    assert.equal(conteos.vendido_por_titulo, 1);
    assert.equal(conteos.titulo_con_error, 0);
    assert.ok(worker.calls.filter(c => c.titulo !== undefined).every(c => c.titulo.length <= TITULO_CLAVE_MAX));
});

test('evaluar: un título con error del Worker deja afuera a ese libro, pero muchos errores abortan', async () => {
    const mk = n => Array.from({ length: n }, (_, i) => book(`MLU${i + 1}`, { isbn: ISBN[i % ISBN.length], sold_quantity: 0, title: `Libro número ${i + 1} de prueba` }));
    const falla = async body => {
        if (body.isbns) return fakeWorker()(body);
        const e = new Error('el Worker respondió 500'); e.status = 500; throw e;
    };
    const pocos = await evaluar(mk(MAX_ERRORES_TITULO), falla, { now: NOW });
    assert.deepEqual(pocos.ids, []);
    assert.equal(pocos.conteos.titulo_con_error, MAX_ERRORES_TITULO);
    await assert.rejects(evaluar(mk(MAX_ERRORES_TITULO + 1), falla, { now: NOW }), /500/);
});

test('evaluar: un título demasiado corto no se consulta', async () => {
    const worker = fakeWorker();
    const { ids, conteos } = await evaluar([book('MLU1', { isbn: ISBN[0], sold_quantity: 0, title: 'Of!' })], worker, { now: NOW });
    assert.deepEqual(ids, []);
    assert.equal(conteos.titulo_no_verificable, 1);
    assert.equal(worker.calls.filter(c => c.titulo !== undefined).length, 0);
});

test('evaluar informa los libros sin venta en lo que D1 cubre, aunque no alcance para probar 730 días', async () => {
    const items = [
        book('MLU1', { isbn: ISBN[0] }),
        book('MLU2', { isbn: ISBN[1] }),
    ];
    const worker = fakeWorker({ cobertura: iso(300), porIsbn: { [ISBN[1]]: iso(30) } });
    const { ids, sinVentaEnD1, conteos } = await evaluar(items, worker, { now: NOW });
    assert.deepEqual(ids, []);
    assert.deepEqual(sinVentaEnD1, ['MLU1']);
    assert.equal(conteos.no_verificable_por_cobertura, 1);
});

test('escenarioParcial: cuenta lo que sobrevive a las exclusiones si se aceptara el histórico parcial', () => {
    const data = {
        excluir: { medicos: { ids: ['MLU2'] }, recientes: { ids: [] }, gana_precio: { ids: ['MLU3'] }, sin_competencia: { ids: ['MLU4'] } },
    };
    const items = ['MLU1', 'MLU2', 'MLU3', 'MLU4', 'MLU5'].map(id => book(id));
    assert.deepEqual(escenarioParcial(items, data, ['MLU1', 'MLU2', 'MLU3', 'MLU4', 'MLU5']), {
        sin_venta_en_d1: 5, elegibles: 2,
        excluidos: { fuera_de_stock: 0, medicos: 1, recientes: 0, gana_precio: 1, sin_competencia: 1 },
    });
    assert.deepEqual(escenarioParcial(items, data, []), { sin_venta_en_d1: 0, elegibles: 0, excluidos: null });
});

test('el workflow guarda un artefacto y el escenario parcial queda fuera del repo', () => {
    const wf = readFileSync('.github/workflows/liquidacion-lista.yml', 'utf8');
    assert.match(wf, /actions\/upload-artifact@v4/);
    assert.match(wf, /--parcial-out "\$RUNNER_TEMP\/parcial\.json"/);
    assert.match(wf, /--parcial "\$RUNNER_TEMP\/parcial\.json"/);
    assert.doesNotMatch(wf, /git add[^\n]*parcial/);
});
