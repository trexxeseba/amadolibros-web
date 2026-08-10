import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRestockEmail,
  createStockWaitlistProcessor,
} from '../stock-waitlist-notifier.js';

const NOW = new Date('2026-08-10T15:00:00.000Z');
const ENV_BASE = {
  RESEND_API_KEY: 're_test',
  SALES_NOTIFICATION_FROM: 'Amado Libros <web@notificaciones.amadolibros.com>',
  CANONICAL_ORIGIN: 'https://www.amadolibros.com',
};

function row(patch = {}) {
  return {
    id: 'wait-1', product_id: 'MLU1', product_title: 'Libro esperado',
    email: 'cliente@example.com', status: 'waiting',
    source_url: 'https://www.amadolibros.com/libro/MLU1/libro-esperado',
    customer_notification_status: 'pending', customer_notification_attempts: 0,
    last_notification_attempt_at: null, restocked_at: null, notified_at: null,
    ...patch,
  };
}

function dbMock(initialRows) {
  const rows = initialRows.map(value => ({ ...value }));
  return {
    rows,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() {
              if (!sql.startsWith('SELECT id,product_id')) throw new Error(`SQL all inesperado: ${sql}`);
              return { results: rows.filter(item => item.status === 'waiting' && ['pending', 'failed', 'sending'].includes(item.customer_notification_status)) };
            },
            async run() {
              if (sql.startsWith("UPDATE stock_waitlist SET customer_notification_status='sending'")) {
                const [attemptAt, restockedAt, updatedAt, id, staleBefore] = args;
                const item = rows.find(value => value.id === id);
                const reclaimable = item && item.status === 'waiting' && (
                  ['pending', 'failed'].includes(item.customer_notification_status) ||
                  (item.customer_notification_status === 'sending' && (!item.last_notification_attempt_at || item.last_notification_attempt_at < staleBefore))
                );
                if (!reclaimable) return { meta: { changes: 0 } };
                item.customer_notification_status = 'sending';
                item.customer_notification_attempts++;
                item.last_notification_attempt_at = attemptAt;
                item.restocked_at ||= restockedAt;
                item.updated_at = updatedAt;
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith("UPDATE stock_waitlist SET status='notified'")) {
                const [providerId, notifiedAt, updatedAt, id] = args;
                const item = rows.find(value => value.id === id && value.customer_notification_status === 'sending');
                if (!item) return { meta: { changes: 0 } };
                item.status = 'notified'; item.customer_notification_status = 'sent';
                item.customer_notification_id = providerId; item.notified_at = notifiedAt; item.updated_at = updatedAt;
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith("UPDATE stock_waitlist SET customer_notification_status='failed'")) {
                const [error, updatedAt, id] = args;
                const item = rows.find(value => value.id === id && value.customer_notification_status === 'sending');
                if (!item) return { meta: { changes: 0 } };
                item.customer_notification_status = 'failed'; item.customer_notification_error = error; item.updated_at = updatedAt;
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

const CATALOG = { items: [
  { id: 'MLU1', title: 'Libro esperado', status: 'active', available_quantity: 1, price: 2000 },
  { id: 'MLU2', title: 'Sigue agotado', status: 'active', available_quantity: 0, price: 1500 },
] };

test('restock-email: usa stock y precio reales con urgencia honesta', () => {
  const email = buildRestockEmail({
    row: row(), product: CATALOG.items[0],
    url: 'https://www.amadolibros.com/libro/MLU1/libro-esperado',
  });
  assert.match(email.subject, /compralo antes de que se agote/);
  assert.match(email.text, /Hay 1 ejemplar disponible/);
  assert.match(email.text, /Precio vigente: \$2\.000/);
  assert.match(email.text, /Por transferencia: \$1\.760 \(12% menos\)/);
  assert.match(email.html, />Comprar ahora</);
});

test('restock: sólo avisa títulos realmente activos y marca notified', async () => {
  const db = dbMock([row(), row({ id: 'wait-2', product_id: 'MLU2' })]);
  const requests = [];
  const processor = createStockWaitlistProcessor({
    getNow: () => NOW,
    sleep: async () => {},
    fetchFn: async (_url, init) => {
      requests.push({ headers: init.headers, body: JSON.parse(init.body) });
      return Response.json({ id: 'resend-1' });
    },
  });
  const result = await processor({ ...ENV_BASE, ORDERS_DB: db }, CATALOG);
  assert.deepEqual(result, { status: 'ok', examined: 2, matched: 1, sent: 1, failed: 0, truncated: false });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body.to, ['cliente@example.com']);
  assert.equal(requests[0].headers['Idempotency-Key'], 'stock-restocked/wait-1');
  assert.equal(db.rows[0].status, 'notified');
  assert.equal(db.rows[0].customer_notification_status, 'sent');
  assert.equal(db.rows[1].status, 'waiting');

  await processor({ ...ENV_BASE, ORDERS_DB: db }, CATALOG);
  assert.equal(requests.length, 1, 'una solicitud notificada no se vuelve a enviar');
});

test('restock: fallo de Resend queda reintentable y no marca notified', async () => {
  const db = dbMock([row()]);
  let calls = 0;
  const processor = createStockWaitlistProcessor({
    getNow: () => NOW,
    sleep: async () => {},
    fetchFn: async () => { calls++; return new Response('{}', { status: 503 }); },
  });
  const result = await processor({ ...ENV_BASE, ORDERS_DB: db }, CATALOG);
  assert.equal(calls, 3);
  assert.equal(result.status, 'partial');
  assert.equal(result.failed, 1);
  assert.equal(db.rows[0].status, 'waiting');
  assert.equal(db.rows[0].customer_notification_status, 'failed');
  assert.equal(db.rows[0].customer_notification_error, 'RESEND_HTTP_503');
});

test('restock: sin D1 o configuración no inventa éxito', async () => {
  const processor = createStockWaitlistProcessor();
  assert.equal((await processor(ENV_BASE, CATALOG)).reason, 'orders_db_missing');
  assert.equal((await processor({ ORDERS_DB: dbMock([]) }, CATALOG)).reason, 'email_config_missing');
});
