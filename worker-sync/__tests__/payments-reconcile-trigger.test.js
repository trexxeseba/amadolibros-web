import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { triggerPaymentsReconcile } from '../payments-reconcile-trigger.js';

const ENV = { APP_ENV: 'production', CANONICAL_ORIGIN: 'https://www.amadolibros.com' };

test('dispara la conciliación en Pages con un POST vacío, sin credenciales ni datos', async () => {
  const calls = [];
  const result = await triggerPaymentsReconcile(ENV, {
    fetchFn: async (url, opts) => { calls.push({ url, opts }); return new Response('{"ok":true}', { status: 200 }); },
  });
  assert.deepEqual(result, { status: 'ok', http: 200 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.amadolibros.com/api/payments/reconcile');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.body, '{}');
  assert.equal(Object.keys(calls[0].opts.headers).some(h => /authorization|cookie|secret|token/i.test(h)), false);
});

test('fuera de producción o sin origen válido no llama a nada', async () => {
  let called = 0;
  const fetchFn = async () => { called++; return new Response('{}'); };
  assert.deepEqual(await triggerPaymentsReconcile({ ...ENV, APP_ENV: 'preview' }, { fetchFn }), { status: 'skipped' });
  assert.deepEqual(await triggerPaymentsReconcile({ APP_ENV: 'production' }, { fetchFn }), { status: 'skipped' });
  assert.deepEqual(await triggerPaymentsReconcile({ ...ENV, CANONICAL_ORIGIN: 'http://insegura.example' }, { fetchFn }), { status: 'skipped' });
  assert.equal(called, 0);
});

test('una respuesta de error o una caída de red no rompe el cron', async () => {
  assert.deepEqual(await triggerPaymentsReconcile(ENV, { fetchFn: async () => new Response('{}', { status: 502 }) }), { status: 'error', http: 502 });
  const down = await triggerPaymentsReconcile(ENV, { fetchFn: async () => { throw new TypeError('red'); } });
  assert.equal(down.status, 'error');
  assert.equal(down.http, 0);
});

test('el cron de 5 minutos del Worker incluye el disparo', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf("event?.cron === '*/5 * * * *'"));
  assert.ok(block.slice(0, 2500).includes('triggerPaymentsReconcile(env)'));
});
