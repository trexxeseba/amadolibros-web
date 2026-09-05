import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchOpenRadarAlerts,
  getWaitlistCounts,
  persistRadarAlerts,
  radarAlertId,
  summarizeRadarAlerts,
} from '../radar-store.js';

function fakeOrdersDb({ waitlistRows = [] } = {}) {
  const alerts = new Map();
  const waitlist = waitlistRows.map(row => ({ ...row }));
  return {
    alerts,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() {
              if (sql.startsWith('SELECT product_id, COUNT(*)')) {
                const counts = new Map();
                for (const row of waitlist) {
                  if (row.status !== 'waiting') continue;
                  counts.set(row.product_id, (counts.get(row.product_id) || 0) + 1);
                }
                return {
                  results: [...counts.entries()].map(([product_id, waiting_count]) => ({ product_id, waiting_count })),
                };
              }
              if (sql.startsWith("SELECT id FROM radar_alerts WHERE status = 'open'")) {
                return { results: [...alerts.values()].filter(row => row.status === 'open').map(row => ({ id: row.id })) };
              }
              if (sql.startsWith('SELECT id, alert_type')) {
                return { results: [...alerts.values()].filter(row => row.status === 'open') };
              }
              throw new Error(`SQL all inesperado: ${sql}`);
            },
            async run() {
              if (sql.startsWith('INSERT INTO radar_alerts')) {
                const [
                  id, alert_type, item_id, isbn, title, severity,
                  score, score_version, reasons_json, metrics_json,
                  first_seen_at, last_seen_at,
                ] = args;
                const existing = alerts.get(id);
                alerts.set(id, {
                  id, alert_type, item_id, isbn, title, severity, status: 'open',
                  score, score_version, reasons_json, metrics_json,
                  first_seen_at: existing ? existing.first_seen_at : first_seen_at,
                  last_seen_at,
                  resolved_at: null,
                });
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith("UPDATE radar_alerts SET status = 'resolved'")) {
                const [resolvedAt, id] = args;
                const row = alerts.get(id);
                if (!row || row.status !== 'open') return { meta: { changes: 0 } };
                row.status = 'resolved';
                row.resolved_at = resolvedAt;
                return { meta: { changes: 1 } };
              }
              throw new Error(`SQL run inesperado: ${sql}`);
            },
          };
        },
      };
    },
  };
}

function alert(overrides = {}) {
  return {
    alert_type: 'AGOTADO',
    item_id: 'MLU1',
    isbn: null,
    title: 'Libro esperado',
    severity: 'high',
    score: 50,
    score_version: 'replenishment_score_v1',
    reasons: ['Sin stock disponible.'],
    metrics: { available_quantity: 0 },
    ...overrides,
  };
}

test('persistRadarAlerts: sin ORDERS_DB devuelve skipped sin lanzar', async () => {
  const result = await persistRadarAlerts({}, [alert()]);
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'orders_db_missing');
});

test('persistRadarAlerts: crea una fila por alert_type+item_id', async () => {
  const db = fakeOrdersDb();
  const env = { ORDERS_DB: db };
  const result = await persistRadarAlerts(env, [alert()], { now: '2026-08-27T07:20:00.000Z' });
  assert.equal(result.status, 'ok');
  assert.equal(result.open, 1);
  const id = radarAlertId('AGOTADO', 'MLU1');
  assert.ok(db.alerts.has(id));
  assert.equal(db.alerts.get(id).first_seen_at, '2026-08-27T07:20:00.000Z');
});

test('persistRadarAlerts: la misma alerta en corridas sucesivas no duplica fila y conserva first_seen_at', async () => {
  const db = fakeOrdersDb();
  const env = { ORDERS_DB: db };
  await persistRadarAlerts(env, [alert()], { now: '2026-08-27T07:15:00.000Z' });
  await persistRadarAlerts(env, [alert({ severity: 'medium', score: 45 })], { now: '2026-09-26T07:15:00.000Z' });

  assert.equal(db.alerts.size, 1);
  const row = db.alerts.get(radarAlertId('AGOTADO', 'MLU1'));
  assert.equal(row.first_seen_at, '2026-08-27T07:15:00.000Z');
  assert.equal(row.last_seen_at, '2026-09-26T07:15:00.000Z');
  assert.equal(row.severity, 'medium');
  assert.equal(row.status, 'open');
});

test('persistRadarAlerts: si la condición desaparece, la alerta pasa a resolved', async () => {
  const db = fakeOrdersDb();
  const env = { ORDERS_DB: db };
  await persistRadarAlerts(env, [alert()], { now: '2026-08-27T07:15:00.000Z' });
  const result = await persistRadarAlerts(env, [], { now: '2026-08-28T07:15:00.000Z' });

  assert.equal(result.resolved, 1);
  const row = db.alerts.get(radarAlertId('AGOTADO', 'MLU1'));
  assert.equal(row.status, 'resolved');
  assert.equal(row.resolved_at, '2026-08-28T07:15:00.000Z');
});

test('persistRadarAlerts: si vuelve a aparecer, se reabre conservando first_seen_at original', async () => {
  const db = fakeOrdersDb();
  const env = { ORDERS_DB: db };
  await persistRadarAlerts(env, [alert()], { now: '2026-08-27T07:15:00.000Z' });
  await persistRadarAlerts(env, [], { now: '2026-08-28T07:15:00.000Z' });
  await persistRadarAlerts(env, [alert()], { now: '2026-08-30T07:15:00.000Z' });

  const row = db.alerts.get(radarAlertId('AGOTADO', 'MLU1'));
  assert.equal(row.status, 'open');
  assert.equal(row.resolved_at, null);
  assert.equal(row.first_seen_at, '2026-08-27T07:15:00.000Z');
  assert.equal(row.last_seen_at, '2026-08-30T07:15:00.000Z');
});

test('persistRadarAlerts: no toca alertas de otros tipos/ítems al resolver', async () => {
  const db = fakeOrdersDb();
  const env = { ORDERS_DB: db };
  await persistRadarAlerts(env, [
    alert({ item_id: 'MLU1' }),
    alert({ alert_type: 'CORREGIR_ISBN', item_id: 'MLU2', score: null, score_version: null }),
  ], { now: '2026-08-27T07:15:00.000Z' });

  await persistRadarAlerts(env, [alert({ item_id: 'MLU1' })], { now: '2026-08-28T07:15:00.000Z' });

  assert.equal(db.alerts.get(radarAlertId('AGOTADO', 'MLU1')).status, 'open');
  assert.equal(db.alerts.get(radarAlertId('CORREGIR_ISBN', 'MLU2')).status, 'resolved');
});

test('getWaitlistCounts: agrupa sólo filas waiting por product_id', async () => {
  const db = fakeOrdersDb({
    waitlistRows: [
      { product_id: 'MLU1', status: 'waiting' },
      { product_id: 'MLU1', status: 'waiting' },
      { product_id: 'MLU1', status: 'notified' },
      { product_id: 'MLU2', status: 'waiting' },
    ],
  });
  const counts = await getWaitlistCounts({ ORDERS_DB: db });
  assert.equal(counts.get('MLU1'), 2);
  assert.equal(counts.get('MLU2'), 1);
});

test('getWaitlistCounts: sin ORDERS_DB devuelve un Map vacío', async () => {
  const counts = await getWaitlistCounts({});
  assert.equal(counts.size, 0);
});

test('fetchOpenRadarAlerts: parsea reasons_json y metrics_json de forma segura', async () => {
  const db = fakeOrdersDb();
  const env = { ORDERS_DB: db };
  await persistRadarAlerts(env, [alert()], { now: '2026-08-27T07:15:00.000Z' });

  const [row] = await fetchOpenRadarAlerts(env);
  assert.equal(row.item_id, 'MLU1');
  assert.deepEqual(row.reasons, ['Sin stock disponible.']);
  assert.deepEqual(row.metrics, { available_quantity: 0 });
});

test('summarizeRadarAlerts: agrupa por tipo, cuenta cero para tipos sin alertas, y ordena por score/severity', () => {
  const alerts = [
    { alert_type: 'REPOSICION_URGENTE', item_id: 'MLU2', severity: 'medium', score: 40 },
    { alert_type: 'REPOSICION_URGENTE', item_id: 'MLU1', severity: 'high', score: 90 },
    { alert_type: 'CORREGIR_ISBN', item_id: 'MLU3', severity: 'low', score: null },
  ];
  const summary = summarizeRadarAlerts(alerts, { generatedAt: '2026-08-27T07:20:00.000Z' });

  assert.equal(summary.total_open, 3);
  assert.equal(summary.counts.REPOSICION_URGENTE, 2);
  assert.equal(summary.counts.AGOTADO, 0);
  assert.equal(summary.counts.CLIENTES_ESPERANDO, 0);
  assert.equal(summary.counts.PUBLICACION_PAUSADA, 0);
  assert.equal(summary.counts.CORREGIR_ISBN, 1);
  assert.deepEqual(summary.items.REPOSICION_URGENTE.map(item => item.item_id), ['MLU1', 'MLU2']);
});
