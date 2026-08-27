import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getMlSalesWindows,
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

test('getMlSalesWindows devuelve 7/30/90 + última venta y cobertura', async () => {
  const { db } = fakeDb({
    summaryRow: {
      units_7: 2, orders_7: 2, revenue_7: 250,
      units_30: 5, orders_30: 4, revenue_30: 700,
      units_90: 9, orders_90: 7, revenue_90: 1400,
      last_sale_at: '2026-08-26T10:00:00Z', observed_rows: 7,
    },
    stateRow: { coverage_from: '2026-05-29', coverage_to: '2026-08-27', last_sync_at: '2026-08-27T12:00:00Z', last_status: 'ok' },
  });
  const result = await getMlSalesWindows({ ORDERS_DB: db }, 'MLU1', { asOf: '2026-08-27T12:00:00Z' });
  assert.deepEqual(result.windows['7'], { units: 2, orders: 2, revenue: 250 });
  assert.equal(result.windows['90'].units, 9);
  assert.equal(result.last_sale_at, '2026-08-26T10:00:00Z');
  assert.equal(result.coverage.from, '2026-05-29');
});

test('getMlSalesWindows sin observaciones ni cobertura devuelve null, no inventa cero', async () => {
  const { db } = fakeDb({
    summaryRow: { units_7: null, orders_7: 0, revenue_7: null, units_30: null, orders_30: 0, revenue_30: null, units_90: null, orders_90: 0, revenue_90: null, last_sale_at: null, observed_rows: 0 },
    stateRow: null,
  });
  const result = await getMlSalesWindows({ ORDERS_DB: db }, 'MLU1');
  assert.deepEqual(result.windows['7'], { units: null, orders: null, revenue: null });
  assert.equal(result.last_sale_at, null);
});

test('getMlSalesWindows con backfill observado puede representar cero ventas', async () => {
  const { db } = fakeDb({
    summaryRow: { units_7: null, orders_7: 0, revenue_7: null, units_30: null, orders_30: 0, revenue_30: null, units_90: null, orders_90: 0, revenue_90: null, last_sale_at: null, observed_rows: 0 },
    stateRow: { coverage_from: '2026-05-29', coverage_to: '2026-08-27', last_sync_at: '2026-08-27', last_status: 'ok' },
  });
  const result = await getMlSalesWindows({ ORDERS_DB: db }, 'MLU1');
  assert.deepEqual(result.windows['90'], { units: 0, orders: 0, revenue: 0 });
});
