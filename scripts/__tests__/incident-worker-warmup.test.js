import test from 'node:test';
import assert from 'node:assert/strict';
import { withWarmup, WARMUP_ATTEMPTS } from '../incident-worker-warmup.mjs';

// Devuelve un fetch falso que contesta los status de la lista, en orden, y que
// anota cuántas veces lo llamaron y cuánto se durmió entre pedidos.
function guion(...status) {
    const llamadas = [];
    const siestas = [];
    const request = async (...args) => {
        llamadas.push(args);
        const code = status.shift() ?? 200;
        return { status: code, ok: code >= 200 && code < 300 };
    };
    return { request, llamadas, siestas, sleep: async ms => { siestas.push(ms); } };
}

test('un 403 de arranque se reintenta hasta que la versión nueva llega', async () => {
    const g = guion(403, 403, 200);
    const request = withWarmup(g.request, { sleep: g.sleep, delayMs: 5 });
    const response = await request('/ready');
    assert.equal(response.status, 200);
    assert.equal(g.llamadas.length, 3);
    assert.deepEqual(g.siestas, [5, 5]);
});

test('después del primer 200 un 403 es una falla y no se reintenta', async () => {
    const g = guion(200, 403);
    const request = withWarmup(g.request, { sleep: g.sleep, delayMs: 5 });
    assert.equal((await request('/ready')).status, 200);
    const response = await request('/manifest');
    assert.equal(response.status, 403);
    assert.equal(g.llamadas.length, 2, 'no debe reintentar una vez arrancado');
    assert.deepEqual(g.siestas, []);
});

test('el presupuesto de reintentos es uno solo para todo el chequeo', async () => {
    const g = guion(...Array(40).fill(403));
    const request = withWarmup(g.request, { attempts: 3, sleep: g.sleep, delayMs: 5 });
    assert.equal((await request('/ready')).status, 403);
    assert.equal(g.llamadas.length, 4, '3 reintentos y el pedido original');
    // El segundo pedido ya no tiene presupuesto: contesta el 403 en el acto.
    assert.equal((await request('/manifest')).status, 403);
    assert.equal(g.llamadas.length, 5);
    assert.deepEqual(g.siestas, [5, 5, 5]);
});

test('sólo reintenta el 403; otra falla se propaga tal cual', async () => {
    const g = guion(500, 200);
    const request = withWarmup(g.request, { sleep: g.sleep, delayMs: 5 });
    const response = await request('/manifest');
    assert.equal(response.status, 500);
    assert.equal(g.llamadas.length, 1);
});

test('pasa los argumentos del pedido sin tocarlos', async () => {
    const g = guion(403, 200);
    const request = withWarmup(g.request, { sleep: g.sleep, delayMs: 5 });
    await request('/prepare', { method: 'POST', headers: { 'if-match': 'W/"x"' } });
    assert.deepEqual(g.llamadas, [
        ['/prepare', { method: 'POST', headers: { 'if-match': 'W/"x"' } }],
        ['/prepare', { method: 'POST', headers: { 'if-match': 'W/"x"' } }],
    ]);
});

test('el presupuesto por defecto cubre la ventana de propagación observada', () => {
    assert.ok(WARMUP_ATTEMPTS >= 6, 'menos margen que el arranque medido en CI');
});
