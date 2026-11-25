import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMoneyProbe, handleMoneyRoute } from '../money-probe.js';

test('probe only issues GETs, returns codes and no money data', async () => {
  const methods = new Set();
  const fetcher = async (url, init) => {
    methods.add(init.method);
    if (url.endsWith('/users/me')) return Response.json({ id: 7 });
    if (url.includes('/orders/search')) return Response.json({ results: [{ shipping: { id: 11 }, payments: [{ id: 22, total_paid_amount: 9999 }] }] });
    if (url.includes('/billing/')) return Response.json({ error: 'forbidden', message: 'no scope' }, { status: 403 });
    return Response.json({ amount: 12345 });
  };
  const out = await createMoneyProbe({ fetcher, tokenProvider: async () => 't' })({});
  assert.deepEqual([...methods], ['GET']);
  assert.equal(out.resultados.facturacion_periodos.http, 403);
  assert.equal(out.resultados.facturacion_periodos.ok, false);
  assert.equal(out.resultados.saldo_cuenta_mp.ok, true);
  assert.equal(JSON.stringify(out).includes('12345'), false);
  assert.equal(JSON.stringify(out).includes('9999'), false);
});

test('route rejects non-GET and unknown paths', async () => {
  const r = await handleMoneyRoute(new Request('https://w.test/money/probe', { method: 'POST' }), {}, async () => ({}));
  assert.equal(r.status, 404);
});
