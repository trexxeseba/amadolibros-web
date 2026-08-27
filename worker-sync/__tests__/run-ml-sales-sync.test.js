import test from 'node:test';
import assert from 'node:assert/strict';
import { runMlSalesSync, salesSyncWindow } from '../radar-data-worker.js';

test('salesSyncWindow hace backfill 90d sin cobertura previa', () => {
  const now = new Date('2026-08-27T12:00:00Z');
  const result = salesSyncWindow(now, null, {});
  assert.equal(result.mode, 'backfill');
  assert.equal(result.days, 90);
  assert.equal(result.to, '2026-08-27T12:00:00.000Z');
  assert.equal(result.from, '2026-05-29T12:00:00.000Z');
});

test('salesSyncWindow usa mantenimiento corto tras backfill exitoso', () => {
  const now = new Date('2026-08-27T12:00:00Z');
  const result = salesSyncWindow(now, { coverage_from: '2026-05-29', coverage_to: '2026-08-26', last_status: 'ok' }, { ML_SALES_MAINTENANCE_DAYS: '5' });
  assert.equal(result.mode, 'maintenance');
  assert.equal(result.days, 5);
  assert.equal(result.from, '2026-08-22T12:00:00.000Z');
});

test('runMlSalesSync apagado por defecto no toca OAuth ni ML', async () => {
  let called = false;
  const result = await runMlSalesSync({}, { source: 'cron' }, {
    getAccessTokenFn: async () => { called = true; return 'token'; },
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'ml_sales_sync_disabled');
  assert.equal(called, false);
});

test('runMlSalesSync hace backfill paid por date_closed, persiste y guarda cobertura', async () => {
  const writes = [];
  const states = [];
  const env = { ML_SALES_SYNC_ENABLED: 'true', USER_ID: '440298103' };
  const nowValues = [new Date('2026-08-27T12:00:00Z'), new Date('2026-08-27T12:00:01Z')];
  const result = await runMlSalesSync(env, { source: 'manual-await' }, {
    getMlSalesSyncStateFn: async () => null,
    getAccessTokenFn: async () => 'token',
    fetchSellerOrdersFn: async (_token, options) => {
      assert.equal(options.sellerId, '440298103');
      assert.equal(options.status, 'paid');
      assert.equal(options.dateField, 'closed');
      return { orders: [{ id: 1 }], pages: 1 };
    },
    normalizeMlOrderItemsFn: (_orders, { observedAt }) => [{ order_id: '1', item_id: 'MLU1', quantity: 2, unit_price: 100, observed_at: observedAt }],
    upsertMlOrderItemsFn: async (_env, rows) => { writes.push(...rows); return { written: rows.length }; },
    writeMlSalesSyncStateFn: async (_env, state) => { states.push(state); },
    now: () => nowValues.shift() || new Date('2026-08-27T12:00:01Z'),
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.mode, 'backfill');
  assert.equal(result.query_status, 'paid');
  assert.equal(result.query_date_field, 'closed');
  assert.equal(result.fetched_orders, 1);
  assert.equal(result.rows_upserted, 1);
  assert.equal(writes[0].item_id, 'MLU1');
  assert.equal(states[0].status, 'ok');
  assert.equal(states[0].coverageFrom, '2026-05-29T12:00:00.000Z');
});

test('mantenimiento consulta date_last_updated sin filtro de estado y preserva coverage_from', async () => {
  const states = [];
  const requests = [];
  const env = { ML_SALES_SYNC_ENABLED: 'true', USER_ID: '440298103', ML_SALES_MAINTENANCE_DAYS: '7' };
  const result = await runMlSalesSync(env, {}, {
    getMlSalesSyncStateFn: async () => ({ coverage_from: '2026-05-01T00:00:00Z', coverage_to: '2026-08-20T00:00:00Z', last_status: 'ok' }),
    getAccessTokenFn: async () => 'token',
    fetchSellerOrdersFn: async (_token, options) => { requests.push(options); return { orders: [], pages: 1 }; },
    normalizeMlOrderItemsFn: () => [],
    upsertMlOrderItemsFn: async () => ({ written: 0 }),
    writeMlSalesSyncStateFn: async (_env, state) => states.push(state),
    now: () => new Date('2026-08-27T12:00:00Z'),
  });
  assert.equal(result.mode, 'maintenance');
  assert.equal(result.query_status, null);
  assert.equal(result.query_date_field, 'last_updated');
  assert.equal(requests[0].status, null);
  assert.equal(requests[0].dateField, 'last_updated');
  assert.equal(states[0].coverageFrom, '2026-05-01T00:00:00Z');
  assert.equal(states[0].coverageTo, '2026-08-27T12:00:00.000Z');
});

test('runMlSalesSync registra error sin exponer token', async () => {
  const states = [];
  const result = await runMlSalesSync({ ML_SALES_SYNC_ENABLED: 'true', USER_ID: '440298103' }, {}, {
    getMlSalesSyncStateFn: async () => null,
    getAccessTokenFn: async () => 'SUPER-SECRET-TOKEN',
    fetchSellerOrdersFn: async () => { throw new Error('ML HTTP 500'); },
    writeMlSalesSyncStateFn: async (_env, state) => states.push(state),
    now: () => new Date('2026-08-27T12:00:00Z'),
  });
  assert.equal(result.status, 'error');
  assert.match(result.error, /ML HTTP 500/);
  assert.equal(JSON.stringify(result).includes('SUPER-SECRET-TOKEN'), false);
  assert.equal(states[0].status, 'error');
});
