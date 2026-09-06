import test from 'node:test';
import assert from 'node:assert/strict';
import { getDailyVisits, getVisitWindows, upsertDailyVisits } from '../visits-store.js';

function fakeOrdersDb() {
  const rows = new Map(); // key: item_id|visit_date
  return {
    rows,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (sql.startsWith('INSERT INTO item_daily_visits')) {
                const [item_id, visit_date, visits, source, observed_at] = args;
                rows.set(`${item_id}|${visit_date}`, { item_id, visit_date, visits, source, observed_at });
                return { meta: { changes: 1 } };
              }
              throw new Error(`SQL run inesperado: ${sql}`);
            },
            async all() {
              if (sql.startsWith('SELECT visit_date, visits, source, observed_at FROM item_daily_visits')) {
                const [itemId, ...rest] = args;
                let results = [...rows.values()].filter(row => row.item_id === itemId);
                // El resto de los binds corresponde a from/to en el mismo orden que las
                // condiciones agregadas dinámicamente — replicamos ese orden acá.
                const conditions = sql.match(/WHERE (.+) ORDER BY/)[1];
                let cursor = 0;
                if (conditions.includes('visit_date >= ?')) {
                  const from = rest[cursor++];
                  results = results.filter(row => row.visit_date >= from);
                }
                if (conditions.includes('visit_date <= ?')) {
                  const to = rest[cursor++];
                  results = results.filter(row => row.visit_date <= to);
                }
                results.sort((a, b) => a.visit_date.localeCompare(b.visit_date));
                return { results };
              }
              throw new Error(`SQL all inesperado: ${sql}`);
            },
          };
        },
      };
    },
  };
}

test('upsertDailyVisits: sin ORDERS_DB devuelve skipped sin lanzar', async () => {
  const result = await upsertDailyVisits({}, [{ item_id: 'MLU1', visit_date: '2026-08-24', visits: 5, source: 'x', observed_at: 'now' }]);
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'orders_db_missing');
});

test('upsertDailyVisits: idempotente — misma (item_id, visit_date) actualiza en vez de duplicar', async () => {
  const db = fakeOrdersDb();
  const env = { ORDERS_DB: db };
  await upsertDailyVisits(env, [{ item_id: 'MLU1', visit_date: '2026-08-24', visits: 5, source: 'items_visits_range', observed_at: '2026-08-25T07:00:00.000Z' }]);
  await upsertDailyVisits(env, [{ item_id: 'MLU1', visit_date: '2026-08-24', visits: 8, source: 'items_visits_range', observed_at: '2026-08-26T07:00:00.000Z' }]);

  assert.equal(db.rows.size, 1);
  const row = db.rows.get('MLU1|2026-08-24');
  assert.equal(row.visits, 8);
  assert.equal(row.observed_at, '2026-08-26T07:00:00.000Z');
});

test('getDailyVisits: filtra por item_id y rango, ordenado ascendente', async () => {
  const db = fakeOrdersDb();
  const env = { ORDERS_DB: db };
  await upsertDailyVisits(env, [
    { item_id: 'MLU1', visit_date: '2026-08-20', visits: 1, source: 's', observed_at: 'now' },
    { item_id: 'MLU1', visit_date: '2026-08-22', visits: 3, source: 's', observed_at: 'now' },
    { item_id: 'MLU1', visit_date: '2026-08-25', visits: 2, source: 's', observed_at: 'now' },
    { item_id: 'MLU2', visit_date: '2026-08-22', visits: 9, source: 's', observed_at: 'now' },
  ]);

  const all = await getDailyVisits(env, 'MLU1');
  assert.deepEqual(all.map(row => row.visit_date), ['2026-08-20', '2026-08-22', '2026-08-25']);

  const ranged = await getDailyVisits(env, 'MLU1', { from: '2026-08-21', to: '2026-08-24' });
  assert.deepEqual(ranged.map(row => row.visit_date), ['2026-08-22']);
});

test('getVisitWindows: sin ninguna fila en la ventana, visits es null (nunca 0 inventado)', async () => {
  const db = fakeOrdersDb();
  const env = { ORDERS_DB: db };
  const summary = await getVisitWindows(env, 'MLU1', { asOf: '2026-08-27' });
  assert.deepEqual(summary.windows[7], { visits: null, days_with_data: 0, window_days: 7, data_through: null });
  assert.deepEqual(summary.windows[30], { visits: null, days_with_data: 0, window_days: 30, data_through: null });
  assert.deepEqual(summary.windows[90], { visits: null, days_with_data: 0, window_days: 90, data_through: null });
});

test('getVisitWindows: suma sólo los días observados y marca cobertura parcial', async () => {
  const db = fakeOrdersDb();
  const env = { ORDERS_DB: db };
  // Sólo 3 de los últimos 7 días tienen dato — simula un sync recién prendido.
  await upsertDailyVisits(env, [
    { item_id: 'MLU1', visit_date: '2026-08-23', visits: 10, source: 's', observed_at: 'now' },
    { item_id: 'MLU1', visit_date: '2026-08-24', visits: 5, source: 's', observed_at: 'now' },
    { item_id: 'MLU1', visit_date: '2026-08-25', visits: 7, source: 's', observed_at: 'now' },
  ]);

  const summary = await getVisitWindows(env, 'MLU1', { asOf: '2026-08-27', windows: [7] });
  assert.deepEqual(summary.windows[7], { visits: 22, days_with_data: 3, window_days: 7, data_through: '2026-08-25' });
});

test('getVisitWindows: respeta ventanas personalizadas', async () => {
  const db = fakeOrdersDb();
  const env = { ORDERS_DB: db };
  await upsertDailyVisits(env, [
    { item_id: 'MLU1', visit_date: '2026-08-27', visits: 4, source: 's', observed_at: 'now' },
  ]);
  const summary = await getVisitWindows(env, 'MLU1', { asOf: '2026-08-27', windows: [1, 3] });
  assert.deepEqual(Object.keys(summary.windows), ['1', '3']);
  assert.equal(summary.windows[1].visits, 4);
  assert.equal(summary.windows[3].visits, 4);
});
