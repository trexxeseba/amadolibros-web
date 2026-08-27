import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getMlSalesWindows,
  mlSalesWindowComplete,
  upsertMlOrderItems,
  writeMlSalesSyncState,
} from '../ml-sales-store.js';

function fakeDb({ summaryRow = null, stateRow = null, rawRows = [] } = {}) {
  const prepared = [];
  const batches = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        bindings: [],
        bind(...args) { this.bindings = args; return this; },
        async run() { return { success: true }; },
        async first() {
          if (sql.includes('FROM ml_sales_sync_state')) return stateRow;
          if (sql.includes('FROM ml_order_items')) return summaryRow;
          return null;
        },
        async all() { return { results: rawRows }; },
      };
      prepared.push(statement);
      return statement;
    },
    async batch(statements) { batches.push(statements); return statements.map(() => ({ success: true })); },
  };
  return { db, prepared, batches };
}

function emptySummary() {
  return {
    units_7: null, orders_7: 0, revenue_7: null, rows_7: 0,
    units_30: null, orders_30: 0, revenue_30: null, rows_30: 0,
    units_90: null, orders_90: 0, revenue_90: null, rows_90: 0,
    last_sale_at: null, observed_rows: 0,
  };
}

test('upsertMlOrderItems usa clave idempotente SQL y batch D1', async () => {
  const { db, batches } = fakeDb();
  const rows = [
    { order_id: '1', item_id: 'MLU1', quantity: 2, unit_price: 100, gross_price: 120, currency_id: 'UYU', order_status: 'paid', date_created: 'a', date_closed: 'b', date_last_updated: 'c', commercial_date: 'b', observed_at: 'd' },
    { order_id: '2', item_id: 'MLU2', quantity: 1, unit_price: 200, gross_price: null, currency_id: 'UYU', order_status: 'paid', date_created: 'a', date_closed: 'b', date_last_updated: null, commercial_date: 'b', observed_at: 'd' },
  ];
  const result = await upsertMlOrderItems({ ORDERS_DB: db }, rows);
  assert.equal(result.written, 2);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
  assert.match(batches[0][0].sql, /ON CONFLICT\(order_id, item_id\) DO UPDATE/);
  assert.deepEqual(batches[0][0].bindings.slice(0, 4), ['1', 'MLU1', 2, 100]);
});

test('writeMlSalesSyncState persiste cobertura sin datos personales', async () => {
  const { db, prepared } = fakeDb();
  await writeMlSalesSyncState({ ORDERS_DB: db }, {
    coverageFrom: '2026-06-01', coverageTo: '2026-08-27', lastSyncAt: '2026-08-27T12:00:00Z',
    status: 'ok', orderCount: 10, itemRows: 12,
  });
  const stmt = prepared.at(-1);
  assert.match(stmt.sql, /ml_sales_sync_state/);
  assert.deepEqual(stmt.bindings, ['2026-06-01', '2026-08-27', '2026-08-27T12:00:00Z', 'ok', 10, 12, null]);
});

test('mlSalesWindowComplete exige inicio suficiente, sync ok y frescura del mismo día', () => {
  const state = {
    coverage_from: '2026-05-29T12:00:00Z',
    coverage_to: '2026-08-27T10:00:00Z',
    last_status: 'ok',
  };
  assert.equal(mlSalesWindowComplete(state, '2026-08-27T12:00:00Z', 90), true);
  assert.equal(mlSalesWindowComplete({ ...state, coverage_from: '2026-06-01T00:00:00Z' }, '2026-08-27T12:00:00Z', 90), false);
  assert.equal(mlSalesWindowComplete({ ...state, last_status: 'error' }, '2026-08-27T12:00:00Z', 7), false);
  assert.equal(mlSalesWindowComplete({ ...state, coverage_to: '2026-08-26T23:59:59Z' }, '2026-08-27T12:00:00Z', 7), false);
});

test('getMlSalesWindows devuelve 7/30/90 + última venta + complete', async () => {
  const { db } = fakeDb({
    summaryRow: {
      units_7: 2, orders_7: 2, revenue_7: 250, rows_7: 2,
      units_30: 5, orders_30: 4, revenue_30: 700, rows_30: 4,
      units_90: 9, orders_90: 7, revenue_90: 1400, rows_90: 7,
      last_sale_at: '2026-08-26T10:00:00Z', observed_rows: 7,
    },
    stateRow: { coverage_from: '2026-05-29T12:00:00Z', coverage_to: '2026-08-27T10:00:00Z', last_sync_at: '2026-08-27T10:00:00Z', last_status: 'ok' },
  });
  const result = await getMlSalesWindows({ ORDERS_DB: db }, 'MLU1', { asOf: '2026-08-27T12:00:00Z' });
  assert.deepEqual(result.windows['7'], {
    units: 2, orders: 2, revenue: 250, complete: true, observed_sale_rows: 2,
    data_through: '2026-08-27T10:00:00Z',
  });
  assert.equal(result.windows['90'].units, 9);
  assert.equal(result.windows['90'].complete, true);
  assert.equal(result.last_sale_at, '2026-08-26T10:00:00Z');
  assert.equal(result.coverage.from, '2026-05-29T12:00:00Z');
});

test('sin observaciones ni cobertura devuelve null, no inventa cero', async () => {
  const { db } = fakeDb({ summaryRow: emptySummary(), stateRow: null });
  const result = await getMlSalesWindows({ ORDERS_DB: db }, 'MLU1', { asOf: '2026-08-27T12:00:00Z' });
  assert.deepEqual(result.windows['7'], {
    units: null, orders: null, revenue: null, complete: false, observed_sale_rows: 0, data_through: null,
  });
  assert.equal(result.last_sale_at, null);
});

test('backfill completo puede representar cero ventas de forma legítima', async () => {
  const { db } = fakeDb({
    summaryRow: emptySummary(),
    stateRow: { coverage_from: '2026-05-29T12:00:00Z', coverage_to: '2026-08-27T10:00:00Z', last_sync_at: '2026-08-27T10:00:00Z', last_status: 'ok' },
  });
  const result = await getMlSalesWindows({ ORDERS_DB: db }, 'MLU1', { asOf: '2026-08-27T12:00:00Z' });
  assert.deepEqual(result.windows['90'], {
    units: 0, orders: 0, revenue: 0, complete: true, observed_sale_rows: 0,
    data_through: '2026-08-27T10:00:00Z',
  });
});

test('cobertura de 30d no inventa cero en la ventana 90d', async () => {
  const { db } = fakeDb({
    summaryRow: emptySummary(),
    stateRow: { coverage_from: '2026-07-28T12:00:00Z', coverage_to: '2026-08-27T10:00:00Z', last_sync_at: '2026-08-27T10:00:00Z', last_status: 'ok' },
  });
  const result = await getMlSalesWindows({ ORDERS_DB: db }, 'MLU1', { asOf: '2026-08-27T12:00:00Z' });
  assert.equal(result.windows['7'].complete, true);
  assert.equal(result.windows['7'].units, 0);
  assert.equal(result.windows['30'].complete, true);
  assert.equal(result.windows['90'].complete, false);
  assert.equal(result.windows['90'].units, null);
});

test('ventana parcial conserva ventas observadas pero las marca complete=false', async () => {
  const row = emptySummary();
  Object.assign(row, { units_90: 2, orders_90: 2, revenue_90: 500, rows_90: 2, observed_rows: 2, last_sale_at: '2026-08-10T00:00:00Z' });
  const { db } = fakeDb({
    summaryRow: row,
    stateRow: { coverage_from: '2026-07-28T12:00:00Z', coverage_to: '2026-08-27T10:00:00Z', last_sync_at: '2026-08-27T10:00:00Z', last_status: 'ok' },
  });
  const result = await getMlSalesWindows({ ORDERS_DB: db }, 'MLU1', { asOf: '2026-08-27T12:00:00Z' });
  assert.deepEqual(result.windows['90'], {
    units: 2, orders: 2, revenue: 500, complete: false, observed_sale_rows: 2,
    data_through: '2026-08-27T10:00:00Z',
  });
});
