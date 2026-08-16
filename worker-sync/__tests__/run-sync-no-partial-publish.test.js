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
  assert.deepEqual(receivedOptions, {
    statuses: ['active'],
    enrichDescriptions: true,
    enrichCatalogPictures: true,
  });
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

test('aviso de reposición corre después de publicar y su fallo no revierte el sync', async () => {
  const { env } = fakeEnv();
  const order = [];
  const result = await runSync(env, { source: 'cron' }, {
    getAccessTokenFn: async () => 'token',
    buildCatalogFn: async () => ({
      total: 1,
      updated_at: '2026-08-10T12:00:00.000Z',
      items: [{ id: 'MLU1', status: 'active', available_quantity: 1, price: 1000 }],
    }),
    publishToR2Fn: async () => { order.push('publish'); },
    readPreviousPublicCatalogFn: async () => ({ items: [] }),
    submitIndexNowFn: async () => { order.push('indexnow'); return { status: 'sent' }; },
    processStockWaitlistFn: async () => { order.push('notify'); throw new Error('Resend caído'); },
    notifyHealthcheckFn: noHealthcheck,
  });
  assert.deepEqual(order, ['publish', 'indexnow', 'notify']);
  assert.equal(result.status, 'ok');
  assert.equal(result.stock_notifications.status, 'error');
  assert.match(result.stock_notifications.error, /Resend caído/);
});

test('un fallo inesperado de IndexNow no revierte un catálogo ya publicado', async () => {
  const { env } = fakeEnv();
  const result = await runSync(env, { source: 'cron' }, {
    getAccessTokenFn: async () => 'token',
    buildCatalogFn: async () => ({
      total: 1,
      updated_at: '2026-08-14T12:00:00.000Z',
      items: [itemForSync()],
    }),
    publishToR2Fn: async () => {},
    readPreviousPublicCatalogFn: async () => ({ items: [] }),
    submitIndexNowFn: async () => { throw new Error('IndexNow caído'); },
    processStockWaitlistFn: async () => ({ status: 'ok' }),
    notifyHealthcheckFn: noHealthcheck,
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.indexnow, { status: 'error', reason: 'unexpected-error' });
});

function itemForSync() {
  return {
    id: 'MLU1',
    title: 'Libro',
    status: 'active',
    available_quantity: 1,
    price: 1000,
  };
}

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
