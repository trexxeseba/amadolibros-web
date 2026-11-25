import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workerTokenSource } from '../src/token.mjs';
import { createMlClient } from '../src/ml-client.mjs';

const d1 = rows => async () => ({ ok: true, json: async () => ({ success: true, result: [{ results: rows() }] }) });

test('token del Worker: una sola espera compartida y error fatal sin colgarse', async () => {
  let lecturas = 0;
  const leer = d1(() => [{ access_token: 'T1', access_expires_at: Date.now() - 1 }]);
  const src = workerTokenSource({ accountId: 'a', apiTokens: ['t'], fetcher: async (...x) => { lecturas++; return leer(...x); }, sleep: async () => {}, maxWaitMs: 0 });
  const r = await Promise.allSettled([src.getToken(), src.getToken(), src.getToken()]);
  assert.ok(r.every(x => x.status === 'rejected' && x.reason.code === 'token_worker_vencido'));
  assert.equal(lecturas, 1);
  // Después del fallo, no vuelve a leer ni a esperar.
  await assert.rejects(src.getToken(), { code: 'token_worker_vencido' });
  assert.equal(lecturas, 1);
});

test('token del Worker rechazado (401) no se reutiliza', async () => {
  const src = workerTokenSource({ accountId: 'a', apiTokens: ['t'], fetcher: d1(() => [{ access_token: 'T1', access_expires_at: Date.now() + 3600e3 }]), sleep: async () => {}, maxWaitMs: 0 });
  assert.equal(await src.getToken(), 'T1');
  src.invalidate();
  await assert.rejects(src.getToken(), { code: 'token_worker_rechazado' });
});

test('cliente: error de token se informa una vez y no se reintenta', async () => {
  const src = { name: 'x', getToken: async () => { throw Object.assign(new Error('token_worker_vencido'), { code: 'token_worker_vencido' }); }, invalidate() {} };
  let llamadas = 0;
  const ml = createMlClient(src, { fetcher: async () => { llamadas++; return { ok: true, json: async () => ({}) }; }, sleep: async () => {} });
  await assert.rejects(ml.get('/x'), { code: 'token_worker_vencido' });
  assert.equal(llamadas, 0); assert.equal(ml.stats.tokenFatal, 'token_worker_vencido');
});

test('cliente: 401 refresca una vez aunque antes hubo un 429', async () => {
  const seq = [429, 401, 200]; let inval = 0;
  const src = { name: 'x', getToken: async () => 'T', invalidate() { inval++; } };
  const ml = createMlClient(src, { fetcher: async () => { const s = seq.shift(); return { ok: s === 200, status: s, headers: { get: () => null }, json: async () => ({ ok: 1 }) }; }, sleep: async () => {} });
  assert.deepEqual(await ml.get('/x'), { ok: 1 }); assert.equal(inval, 1);
});
