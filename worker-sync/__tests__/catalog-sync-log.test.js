// INFORME-ANALITICO: resumen de lo que cambió en cada sync del catálogo.
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCatalogDiff, recordCatalogSyncLog } from '../catalog-sync-log.js';
import { runSync } from '../index.js';

const item = (id, patch = {}) => ({ id, title: `Libro ${id}`, price: 1000, status: 'active', available_quantity: 1, ...patch });

test('cuenta altas, bajas, subas, bajas de precio y cambios de stock', () => {
  const previous = { items: [item('A'), item('B'), item('C', { price: 500 }), item('D'), item('E', { available_quantity: 0 })] };
  const next = { items: [item('B', { price: 1200 }), item('C', { price: 400 }), item('D', { available_quantity: 0 }), item('E'), item('F')] };
  const diff = buildCatalogDiff(previous, next);
  assert.equal(diff.baseline, true);
  assert.equal(diff.total_items, 5);
  assert.equal(diff.available_items, 4);
  assert.equal(diff.previous_total, 5);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.price_up, 1);
  assert.equal(diff.price_down, 1);
  assert.equal(diff.out_of_stock, 1);
  assert.equal(diff.back_in_stock, 1);
  assert.deepEqual(diff.samples.added.map(s => s.id), ['F']);
  assert.deepEqual(diff.samples.removed.map(s => s.id), ['A']);
  // El cambio más grande primero.
  assert.deepEqual(diff.samples.price_changes.map(s => [s.id, s.from, s.to]), [['B', 1000, 1200], ['C', 500, 400]]);
});

test('sin catálogo anterior no finge que todo es nuevo', () => {
  const diff = buildCatalogDiff(null, { items: [item('A'), item('B')] });
  assert.equal(diff.baseline, false);
  assert.equal(diff.added, 0);
  assert.equal(diff.previous_total, null);
  assert.equal(diff.total_items, 2);
});

test('los ejemplos quedan acotados aunque cambie medio catálogo', () => {
  const next = { items: Array.from({ length: 50 }, (_, i) => item(`N${i}`)) };
  const diff = buildCatalogDiff({ items: [] }, next);
  assert.equal(diff.added, 50);
  assert.equal(diff.samples.added.length, 10);
});

test('guarda una fila por corrida y sin base no hace nada', async () => {
  const calls = [];
  const env = { ORDERS_DB: { prepare: sql => ({ bind: (...params) => ({ run: async () => { calls.push({ sql, params }); } }) }) } };
  const diff = buildCatalogDiff({ items: [item('A')] }, { items: [item('A', { price: 900 })] });
  assert.deepEqual(await recordCatalogSyncLog(env, diff, '2026-10-05T07:20:00.000Z'), { status: 'recorded' });
  assert.match(calls[0].sql, /INSERT OR IGNORE INTO catalog_sync_log/);
  assert.equal(calls[0].params[0], 'sync:2026-10-05T07:20:00.000Z');
  assert.equal(calls[0].params[8], 1, 'price_down');
  assert.deepEqual(await recordCatalogSyncLog({}, diff, 'x'), { status: 'skipped', reason: 'no-db' });
});

test('si anotar el resumen falla, el sync publicado sigue siendo un éxito', async () => {
  const result = await runSync({}, { source: 'test' }, {
    getAccessTokenFn: async () => 'token',
    buildCatalogFn: async () => ({ total: 1, updated_at: 'x', items: [item('A')] }),
    publishToR2Fn: async () => {},
    notifyHealthcheckFn: async () => {},
    processStockWaitlistFn: async () => ({ status: 'ok' }),
    readPreviousPublicCatalogFn: async () => ({ items: [] }),
    submitIndexNowFn: async () => ({ status: 'skipped' }),
    syncCoverMirrorFn: async () => ({ status: 'skipped' }),
    recordCatalogSyncLogFn: async () => { throw new Error('no such table: catalog_sync_log'); },
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.catalog_sync_log.status, 'error');
  assert.match(result.catalog_sync_log.error, /no such table/);
});
