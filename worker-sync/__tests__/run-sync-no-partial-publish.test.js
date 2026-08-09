import test from 'node:test';
import assert from 'node:assert/strict';
import { runSync } from '../index.js';
import { buildCatalog } from '../meli-catalog.js';

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

test('si un lote de detalles agota sus reintentos, el catálogo real aborta y no publica parcialmente', async () => {
  const { env, puts } = fakeEnv();
  env.USER_ID = '123';
  env.MIN_ACTIVE_ITEMS = '1';

  const ids = Array.from({ length: 40 }, (_, index) => `MLU${index + 1}`);
  let detailAttempts = 0;
  const fetchFn = async url => {
    if (String(url).includes('/items/search')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        async json() { return { results: ids, scroll_id: null }; },
      };
    }

    detailAttempts++;
    return {
      ok: false,
      status: 503,
      headers: { get: () => null },
      async json() { return {}; },
    };
  };

  let publishCalls = 0;
  const result = await runSync(env, { source: 'manual-await' }, {
    getAccessTokenFn: async () => 'token',
    buildCatalogFn: (buildEnv, token, options) => buildCatalog(buildEnv, token, {
      ...options,
      mlGetDeps: {
        fetchFn,
        sleepFn: async () => {},
        random: () => 0,
        maxRetries: 2,
      },
    }),
    publishToR2Fn: async () => { publishCalls++; },
    notifyHealthcheckFn: noHealthcheck,
  });

  assert.equal(detailAttempts, 3);
  assert.equal(result.status, 'error');
  assert.match(result.error, /Error definitivo en batch 1\/2/);
  assert.match(result.error, /Agotados 2 reintentos/);
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
  assert.deepEqual(receivedOptions.statuses, ['active']);
  assert.equal(receivedOptions.telemetry.schema_version, 1);
  assert.equal(receivedOptions.telemetry.rate_limit_429_count, 0);
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
  assert.ok(puts.some(entry => entry.key === 'sync:last_rate_limit:v1'));
  assert.deepEqual(deletes, ['sync:last_error', 'sync:last_error_detail:v1']);
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

test('429 fatal en scan persiste fase, página y Retry-After sin guardar query ni scroll', async () => {
  const { env, puts } = fakeEnv();
  env.USER_ID = '123';
  env.MIN_ACTIVE_ITEMS = '1';
  const fetchFn = async () => ({
    ok: false,
    status: 429,
    headers: { get: name => name.toLowerCase() === 'retry-after' ? '60' : null },
    async json() { return {}; },
  });

  const result = await runSync(env, { source: 'manual-await' }, {
    getAccessTokenFn: async () => 'token',
    buildCatalogFn: (buildEnv, token, options) => buildCatalog(buildEnv, token, {
      ...options,
      mlGetDeps: {
        fetchFn,
        sleepFn: async () => {},
        random: () => 0,
        maxRetries: 1,
      },
    }),
    publishToR2Fn: async () => { throw new Error('no debe publicar'); },
    notifyHealthcheckFn: noHealthcheck,
  });

  assert.equal(result.status, 'error');
  const summaryEntry = puts.find(entry => entry.key === 'sync:last_rate_limit:v1');
  const detailEntry = puts.find(entry => entry.key === 'sync:last_error_detail:v1');
  assert.ok(summaryEntry);
  assert.ok(detailEntry);
  const summary = JSON.parse(summaryEntry.value);
  const detail = JSON.parse(detailEntry.value);
  assert.equal(summary.rate_limit_429_count, 2);
  assert.equal(summary.rate_limit_by_phase.scan, 2);
  assert.equal(summary.max_retry_after_ms, 60000);
  assert.equal(summary.max_applied_delay_ms, 30000);
  assert.equal(detail.last_retry_event.phase, 'scan');
  assert.equal(detail.last_retry_event.catalog_status, 'active');
  assert.equal(detail.last_retry_event.page, 1);
  assert.equal(detail.last_retry_event.status, 429);
  assert.equal(detail.last_retry_event.stop_reason, 'max_retries');
  const serialized = summaryEntry.value + detailEntry.value;
  assert.equal(serialized.includes('scroll_id'), false);
  assert.equal(serialized.includes('?'), false);
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
