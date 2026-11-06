import test from 'node:test';
import assert from 'node:assert/strict';
import { crearCliente } from '../src/ml.mjs';
import { escribirPrecio } from '../src/escritura.mjs';
import { mlFalso, it } from './ml-falso.mjs';

const fuente = { getToken: async () => 'tok', invalidate() {} };
const cli = f => crearCliente(fuente, { fetcher: f.fetcher, sleep: async () => {} });
const opts = { sleep: async () => {} };
const bajar = o => async () => ({ accion: 'bajar', objetivo: 1683, ...o });

test('aplica y verifica el precio efectivo', async () => {
  const f = mlFalso({ items: { MLU1: it('MLU1', 2000) } });
  const r = await escribirPrecio(cli(f), 'MLU1', 1683, bajar(), opts);
  assert.equal(r.resultado, 'aplicada'); assert.equal(f.llamadas.filter(l => l.startsWith('PUT')).length, 1);
});
test('si al releer cambió el objetivo, no escribe', async () => {
  const f = mlFalso({ items: { MLU1: it('MLU1', 2000) } });
  const r = await escribirPrecio(cli(f), 'MLU1', 1683, bajar({ objetivo: 1600 }), opts);
  assert.equal(r.resultado, 'cancelada_recalculo'); assert.equal(f.llamadas.filter(l => l.startsWith('PUT')).length, 0);
});
test('timeout de escritura: consulta antes de reintentar y no repite si ya quedó', async () => {
  const items = { MLU1: it('MLU1', 2000) };
  const f = mlFalso({ items, putFalla: (id, b) => { items[id].price = b.price; throw Object.assign(new Error('t'), { name: 'TimeoutError' }); } });
  const r = await escribirPrecio(cli(f), 'MLU1', 1683, bajar(), opts);
  assert.equal(r.resultado, 'aplicada'); assert.equal(f.llamadas.filter(l => l.startsWith('PUT')).length, 1);
});
test('409: relee y recalcula, no repite a ciegas', async () => {
  let n = 0;
  const f = mlFalso({ items: { MLU1: it('MLU1', 2000) }, putFalla: () => (n++ === 0 ? new Response('{"error":"conflict"}', { status: 409 }) : null) });
  let decisiones = 0;
  const r = await escribirPrecio(cli(f), 'MLU1', 1683, async () => { decisiones++; return { accion: 'bajar', objetivo: 1683 }; }, opts);
  assert.equal(r.resultado, 'aplicada'); assert.equal(decisiones, 2);
});
test('400 se rechaza sin reintentar', async () => {
  const f = mlFalso({ items: { MLU1: it('MLU1', 2000) }, putFalla: () => new Response('{"message":"Cannot modify price on items with dynamic pricing"}', { status: 400 }) });
  const r = await escribirPrecio(cli(f), 'MLU1', 1683, bajar(), opts);
  assert.equal(r.resultado, 'rechazada'); assert.equal(f.llamadas.filter(l => l.startsWith('PUT')).length, 1);
});
test('ML acepta y no aplica: precio inesperado', async () => {
  const f = mlFalso({ items: { MLU1: it('MLU1', 2000) }, putFalla: () => new Response('{}', { status: 200 }) });
  const r = await escribirPrecio(cli(f), 'MLU1', 1683, bajar(), opts);
  assert.equal(r.resultado, 'precio_inesperado');
});
