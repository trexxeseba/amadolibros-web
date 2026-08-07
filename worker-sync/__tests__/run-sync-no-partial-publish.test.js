import test from 'node:test';
import assert from 'node:assert/strict';
import { runSync } from '../index.js';

function fakeEnv({ putThrows = false } = {}) {
  const puts = [];
  const deletes = [];
  return {
    puts,
    deletes,
    env: {
      AMADO_KV: {
        async put(key, value) {
          puts.push({ key, value });
          if (putThrows) throw new Error('KV indisponible');
        },
        async delete(key) { deletes.push(key); },
      },
    },
  };
}

const noHealthcheck = async () => {};

test('si falla la descarga, publishToR2 se llama cero veces y registra error', async () => {
  const { env, puts } = fakeEnv();
  let publishCalls = 0;
  const result = await runSync(env, { source: 'manual-await' }, {
    getAccessTokenFn: async () => 'token',
    buildCatalogFn: async () => { throw new Error('descarga interrumpida'); },
    publishToR2Fn: async () => { publishCalls++; },
    notifyHealthcheckFn: noHealthcheck,
  });

  assert.equal(result.status, 'error');
  assert.match(result.error, /descarga interrumpida/);
  assert.equal(publishCalls, 0);
  assert.ok(puts.some(entry => entry.key === 'sync:last_error'));
});
test('runSync conserva el filtro público statuses active', async () => {
  const { env } = fakeEnv();
  let receivedOptions;
  const result = await runSync(env, { source: 'manual-await' }, {
    getAccessTokenFn: async () => 'token',
    buildCatalogFn: async (_env, _token, options) => {
      receivedOptions = options;
      return { total: 1, updated_at: '2026-08-07T12:00:00.000Z', items: [{}] };
    },
    publishToR2Fn: async () => {},
    notifyHealthcheckFn: noHealthcheck,
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(receivedOptions, { statuses: ['active'] });
});

test('un sync exitoso publica una vez y registra sync:last_ok', async () => {
  const { env, puts, deletes } = fakeEnv();
  let publishCalls = 0;
  const result = await runSync(env, { source: 'cron' }, {
    getAccessTokenFn: async () => 'token',
    buildCatalogFn: async () => ({
      total: 2,
      updated_at: '2026-08-07T12:00:00.000Z',
      items: [{}, {}],
    }),
    publishToR2Fn: async () => { publishCalls++; },
    notifyHealthcheckFn: noHealthcheck,
  });

  assert.equal(result.status, 'ok');
  assert.equal(publishCalls, 1);
  assert.ok(puts.some(entry => entry.key === 'sync:last_ok'));
  assert.deepEqual(deletes, ['sync:last_error']);
});

test('si falla autenticación tampoco intenta publicar', async () => {
  const { env } = fakeEnv();
  let buildCalls = 0;
  let publishCalls = 0;
  const result = await runSync(env, { source: 'cron' }, {
    getAccessTokenFn: async () => { throw new Error('auth falló'); },
    buildCatalogFn: async () => { buildCalls++; },
    publishToR2Fn: async () => { publishCalls++; },
    notifyHealthcheckFn: noHealthcheck,
  });

  assert.equal(result.status, 'error');
  assert.equal(buildCalls, 0);
  assert.equal(publishCalls, 0);
});

test('un fallo de KV no impide devolver el error de descarga', async () => {
  const { env, puts } = fakeEnv({ putThrows: true });
  const result = await runSync(env, { source: 'manual-await' }, {
    getAccessTokenFn: async () => 'token',
    buildCatalogFn: async () => { throw new Error('error original'); },
    publishToR2Fn: async () => {},
    notifyHealthcheckFn: noHealthcheck,
  });

  assert.equal(result.status, 'error');
  assert.equal(result.error, 'error original');
  assert.ok(puts.some(entry => entry.key === 'sync:last_error'));
});

test('si falla publishToR2 el resultado final conserva ese error', async () => {
  const { env } = fakeEnv();
  const result = await runSync(env, { source: 'manual-await' }, {
    getAccessTokenFn: async () => 'token',
    buildCatalogFn: async () => ({ total: 1, updated_at: '2026-08-07T12:00:00.000Z' }),
    publishToR2Fn: async () => { throw new Error('R2 no publicó'); },
    notifyHealthcheckFn: noHealthcheck,
  });

  assert.equal(result.status, 'error');
  assert.equal(result.error, 'R2 no publicó');
});
