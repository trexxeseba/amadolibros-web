import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCustomerOrderEmail,
  buildInternalTransferEmail,
  createOrderEmailService,
} from '../_order_email.js';

const NOW = new Date('2026-08-10T15:00:00.000Z');
const ORDER = {
  id: 'order-1', public_code: 'AL-260810-TEST', buyer_name: 'Ana <Pérez>',
  buyer_phone: '099123456', buyer_email: 'ana@example.com', delivery_type: 'pickup',
  address: null, locality: null, department: null,
  products_total_uyu: 2000, pickup_discount_uyu: 150, shipping_cost_uyu: 0,
  payable_total_uyu: 1850,
};
const ITEMS = [{ title: 'Libro <especial>', quantity: 1, unit_price_uyu: 2000, line_total_uyu: 2000 }];
const ENV = {
  RESEND_API_KEY: 're_test',
  SALES_NOTIFICATION_FROM: 'Amado Libros <web@notificaciones.amadolibros.com>',
  SALES_NOTIFICATION_TO: 'ventas@example.com,admin@example.com',
};

function dbMock() {
  const events = new Map();
  return {
    events,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (sql.startsWith('INSERT OR IGNORE INTO order_events')) {
                const [id, orderId, eventType, payload, createdAt] = args;
                if (events.has(id)) return { meta: { changes: 0 } };
                events.set(id, { id, orderId, eventType, payload_json: payload, createdAt });
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith('UPDATE order_events SET payload_json')) {
                const [next, id, previous] = args;
                const row = events.get(id);
                if (!row || row.payload_json !== previous) return { meta: { changes: 0 } };
                row.payload_json = next;
                return { meta: { changes: 1 } };
              }
              throw new Error(`SQL run no esperado: ${sql}`);
            },
            async first() {
              if (sql.startsWith('SELECT payload_json FROM order_events')) {
                const row = events.get(args[0]);
                return row ? { payload_json: row.payload_json } : null;
              }
              throw new Error(`SQL first no esperado: ${sql}`);
            },
            async all() {
              if (sql.startsWith('SELECT title,quantity')) return { results: ITEMS };
              throw new Error(`SQL all no esperado: ${sql}`);
            },
          };
        },
      };
    },
  };
}

test('order-email: cliente distingue transferencia pendiente de pago aprobado', () => {
  const transfer = buildCustomerOrderEmail({
    order: ORDER, items: ITEMS,
    payment: { method: 'bank_transfer', transfer_discount_uyu: 240, total_uyu: 1610 },
  });
  assert.match(transfer.subject, /pendiente de transferencia/);
  assert.match(transfer.text, /Total a transferir: \$1\.610 UYU/);
  assert.match(transfer.text, /pendiente hasta que Amado Libros confirme/);
  assert.doesNotMatch(transfer.text, /pago fue aprobado/);

  const paid = buildCustomerOrderEmail({
    order: ORDER, items: ITEMS,
    payment: { method: 'mercado_pago', total_uyu: 1850 },
  });
  assert.match(paid.subject, /Pago confirmado/);
  assert.match(paid.text, /Total pagado: \$1\.850 UYU/);
  assert.match(paid.text, /pago con Mercado Pago fue aprobado/);
});

test('order-email: HTML escapa datos del cliente y del libro', () => {
  const email = buildCustomerOrderEmail({
    order: ORDER, items: ITEMS,
    payment: { method: 'mercado_pago', total_uyu: 1850 },
  });
  assert.match(email.html, /Ana &lt;Pérez&gt;/);
  assert.match(email.html, /Libro &lt;especial&gt;/);
  assert.doesNotMatch(email.html, /Ana <Pérez>/);
});

test('order-email: transferencia manda al cliente y a Amado una sola vez', async () => {
  const db = dbMock();
  const requests = [];
  const service = createOrderEmailService({
    sleep: async () => {},
    fetchFn: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json({ id: `resend-${requests.length}` });
    },
  });
  const args = {
    db, env: ENV, order: ORDER,
    payment: { method: 'bank_transfer', transfer_discount_uyu: 240, total_uyu: 1610 },
    now: NOW,
  };
  await service.sendTransferNotifications(args);
  await service.sendTransferNotifications(args);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].to, ['ana@example.com']);
  assert.deepEqual(requests[1].to, ['ventas@example.com', 'admin@example.com']);
  assert.equal(db.events.size, 2);
  for (const row of db.events.values()) assert.equal(JSON.parse(row.payload_json).status, 'sent');
});

test('order-email: aviso interno deja claro que la transferencia está pendiente', () => {
  const email = buildInternalTransferEmail({
    order: ORDER, items: ITEMS,
    payment: { method: 'bank_transfer', transfer_discount_uyu: 240, total_uyu: 1610 },
  });
  assert.match(email.subject, /pendiente/);
  assert.match(email.text, /ESTADO: pendiente de comprobante/);
  assert.match(email.text, /Correo: ana@example\.com/);
});
