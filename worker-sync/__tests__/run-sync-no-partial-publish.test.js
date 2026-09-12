import test from 'node:test';
import assert from 'node:assert/strict';
import {
  configuredCoverMirrorBatchSize,
  runCoverMirror,
  runSync,
} from '../index.js';
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

test('el lote del cron respeta COVER_MIRROR_BATCH_SIZE y sus límites seguros', () => {
  assert.equal(configuredCoverMirrorBatchSize({ COVER_MIRROR_BATCH_SIZE: '100' }), 100);
  assert.equal(configuredCoverMirrorBatchSize({ COVER_MIRROR_BATCH_SIZE: '5000' }), 1000);
  assert.equal(configuredCoverMirrorBatchSize({ COVER_MIRROR_BATCH_SIZE: 'no-numero' }), 250);
});

test('runSync invalida el backfill viejo y persiste el resultado del catálogo nuevo', async () => {
  const { env, puts, deletes } = fakeEnv();
  env.COVER_R2 = {};
  const catalog = {
    total: 1,
    updated_at: '2026-08-16T12:00:00.000Z',
    items: [itemForSync()],
  };
  const result = await runSync(env, { source: 'manual-await' }, {
    getAccessTokenFn: async () => 'token',
    buildCatalogFn: async () => catalog,
    publishToR2Fn: async () => {},
    readPreviousPublicCatalogFn: async () => ({ items: [] }),
    submitIndexNowFn: async () => ({ status: 'disabled' }),
    processStockWaitlistFn: async () => ({ status: 'ok' }),
    syncCoverMirrorFn: async () => ({ status: 'completed', attempted: 1, failed: 0, pending: 0, valid_copies: 1 }),
    notifyHealthcheckFn: noHealthcheck,
  });

  assert.equal(result.status, 'ok');
  assert.ok(deletes.includes('cover-mirror:backfill_complete'));
  const marker = puts.find(entry => entry.key === 'cover-mirror:backfill_complete');
  assert.equal(JSON.parse(marker.value).catalog_version, catalog.updated_at);
  assert.ok(puts.some(entry => entry.key === 'cover-mirror:last_result'));
});

test('el cron sólo salta mantenimiento cuando la marca coincide con el catálogo actual', async () => {
  const store = new Map();
  const catalog = { updated_at: '2026-08-16T12:00:00.000Z', items: [] };
  const env = {
    CATALOG_R2: {
      async get() { return { async text() { return JSON.stringify(catalog); } }; },
    },
    AMADO_KV: {
      async get(key) { return store.get(key) || null; },
      async put(key, value) { store.set(key, value); },
      async delete(key) { store.delete(key); },
    },
  };
  store.set('cover-mirror:backfill_complete', JSON.stringify({
    completed: true,
    source_policy_version: 1,
    catalog_version: catalog.updated_at,
  }));
  let calls = 0;
  const syncCoverMirrorFn = async () => {
    calls++;
    return { status: 'completed', pending: 0 };
  };

  const skipped = await runCoverMirror(env, { maintenanceMinute: 25 }, { syncCoverMirrorFn });
  assert.equal(skipped.status, 'skipped');
  assert.equal(calls, 0);

  store.set('cover-mirror:backfill_complete', JSON.stringify({
    completed: true,
    source_policy_version: 1,
    catalog_version: '2026-08-15T00:00:00.000Z',
  }));
  const executed = await runCoverMirror(env, { maintenanceMinute: 25 }, { syncCoverMirrorFn });
  assert.equal(executed.status, 'completed');
  assert.equal(calls, 1);
});

test('el cron recorre bloques pausados con sus galerías completas y persiste el cursor', async () => {
  const store=new Map(); const seen=[];
  const payloads={
    'catalog.json':{updated_at:'v1',items:[]},
    'catalog/manifest.json':{current:{block_count:2,block_prefix:'catalog/v1'}},
    'catalog/v1/block-000.json':{items:[{id:'MLU100001',status:'paused',pictures:['a','b']}]},
    'catalog/v1/block-001.json':{items:[{id:'MLU100002',status:'paused',pictures:['c','d','e']}]},
  };
  const env={CATALOG_R2:{async get(key){return payloads[key]?{text:async()=>JSON.stringify(payloads[key])}:null;}},
    AMADO_KV:{get:async key=>store.get(key)||null,put:async(key,value)=>store.set(key,value),delete:async key=>store.delete(key)}};
  const syncCoverMirrorFn=async(_env,catalog,options)=>{seen.push(catalog.items);assert.equal(options.includePaused,true);return {status:'completed',pending:0,source_discovery_pending:0};};
  const one=await runCoverMirror(env,{}, {syncCoverMirrorFn});
  assert.equal(one.paused_progress.remaining,1); assert.equal(one.pending,1);
  const two=await runCoverMirror(env,{}, {syncCoverMirrorFn});
  assert.equal(two.paused_progress.remaining,0);assert.equal(two.pending,0);
  assert.deepEqual(seen.map(items=>items[0].pictures.length),[2,3]);
});
