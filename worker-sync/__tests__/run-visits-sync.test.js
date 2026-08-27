import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lastNCalendarDates,
  readCatalogItemIdsFromR2,
  runVisitsSync,
} from '../index.js';

test('lastNCalendarDates: aplica el lag y devuelve fechas consecutivas oldest→newest', () => {
  const referenceDate = new Date('2026-08-27T10:00:00.000Z');
  assert.deepEqual(lastNCalendarDates(referenceDate, 3, 1), ['2026-08-24']);
  assert.deepEqual(lastNCalendarDates(referenceDate, 3, 3), ['2026-08-22', '2026-08-23', '2026-08-24']);
});

test('readCatalogItemIdsFromR2: sin CATALOG_R2 o sin catalog.json devuelve []', async () => {
  assert.deepEqual(await readCatalogItemIdsFromR2({}), []);
  assert.deepEqual(await readCatalogItemIdsFromR2({ CATALOG_R2: { async get() { return null; } } }), []);
});

test('readCatalogItemIdsFromR2: extrae los id del catálogo publicado', async () => {
  const env = {
    CATALOG_R2: {
      async get() {
        return { async text() { return JSON.stringify({ items: [{ id: 'MLU1' }, { id: 'MLU2' }, {}] }); } };
      },
    },
  };
  assert.deepEqual(await readCatalogItemIdsFromR2(env), ['MLU1', 'MLU2']);
});

test('runVisitsSync: apagado por defecto no llama a ninguna dependencia', async () => {
  let called = false;
  const result = await runVisitsSync({}, { source: 'cron' }, {
    getAccessTokenFn: async () => { called = true; return 'token'; },
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'visits_sync_disabled');
  assert.equal(called, false);
});

test('runVisitsSync: habilitado, agrupa en lotes de VISITS_BATCH_SIZE por cada fecha del backfill', async () => {
  const env = { VISITS_SYNC_ENABLED: 'true', VISITS_BATCH_SIZE: '2', VISITS_AVAILABILITY_LAG_DAYS: '3', VISITS_BACKFILL_DAYS: '2' };
  const batches = [];
  const upserts = [];

  const result = await runVisitsSync(env, { source: 'cron' }, {
    getAccessTokenFn: async () => 'token',
    readCatalogItemIdsFn: async () => ['MLU1', 'MLU2', 'MLU3'],
    fetchVisitsRangeFn: async (ids, token, { dateFrom, dateTo }) => {
      batches.push({ ids: [...ids], dateFrom, dateTo });
      return ids.map(id => ({ item_id: id, total_visits: 7 }));
    },
    upsertDailyVisitsFn: async (_env, rows) => { upserts.push(...rows); return { status: 'ok', written: rows.length }; },
    now: () => new Date('2026-08-27T07:20:00.000Z'),
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.items_considered, 3);
  assert.equal(result.batch_size, 2);
  assert.deepEqual(result.dates, ['2026-08-23', '2026-08-24']);
  // 2 fechas × 2 lotes (tamaño 2 y 1) = 4 lotes.
  assert.equal(result.request_batches, 4);
  assert.equal(result.failed_batches, 0);
  assert.equal(result.rows_upserted, 6);
  assert.deepEqual(batches.map(b => b.ids), [['MLU1', 'MLU2'], ['MLU3'], ['MLU1', 'MLU2'], ['MLU3']]);
  assert.ok(upserts.every(row => row.source === 'items_visits_range'));
  assert.ok(upserts.every(row => row.observed_at === '2026-08-27T07:20:00.000Z'));
});

test('runVisitsSync: un lote fallido no aborta el resto — queda reportado como partial', async () => {
  const env = { VISITS_SYNC_ENABLED: 'true', VISITS_BATCH_SIZE: '1', VISITS_BACKFILL_DAYS: '1' };
  let calls = 0;

  const result = await runVisitsSync(env, { source: 'cron' }, {
    getAccessTokenFn: async () => 'token',
    readCatalogItemIdsFn: async () => ['MLU1', 'MLU2'],
    fetchVisitsRangeFn: async ids => {
      calls++;
      if (ids[0] === 'MLU1') throw new Error('ML caído para este lote');
      return ids.map(id => ({ item_id: id, total_visits: 3 }));
    },
    upsertDailyVisitsFn: async () => ({ status: 'ok', written: 1 }),
  });

  assert.equal(calls, 2);
  assert.equal(result.status, 'partial');
  assert.equal(result.failed_batches, 1);
  assert.equal(result.rows_upserted, 1);
});

test('runVisitsSync: sin items en catalog.json devuelve error explícito, no inventa datos', async () => {
  const env = { VISITS_SYNC_ENABLED: 'true' };
  const result = await runVisitsSync(env, { source: 'cron' }, {
    getAccessTokenFn: async () => 'token',
    readCatalogItemIdsFn: async () => [],
  });
  assert.equal(result.status, 'error');
  assert.match(result.error, /catalog\.json sin items/);
});

test('runVisitsSync: un fallo de autenticación no intenta pedir visitas', async () => {
  const env = { VISITS_SYNC_ENABLED: 'true' };
  let fetchCalled = false;
  const result = await runVisitsSync(env, { source: 'cron' }, {
    getAccessTokenFn: async () => { throw new Error('auth falló'); },
    readCatalogItemIdsFn: async () => { fetchCalled = true; return ['MLU1']; },
  });
  assert.equal(result.status, 'error');
  assert.match(result.error, /auth falló/);
  assert.equal(fetchCalled, false);
});
