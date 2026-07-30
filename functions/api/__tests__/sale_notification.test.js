import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSaleEmail,
  createSaleNotificationSender,
} from '../_sale_notification.js';

const NOW = new Date('2026-07-30T02:00:00.000Z');

function baseOrder(patch = {}) {
  return {
    id: 'order-uuid',
    public_code: 'AL-260729-TEST',
    buyer_name: 'Ana <Pérez>',
    buyer_phone: '099 123 456',
    delivery_type: 'shipping',
    address: 'Rincón 608',
    locality: 'Ciudad Vieja',
    department: 'Montevideo',
    requested_delivery_date: '2026-07-31',
    requested_delivery_from: '10:00',
    requested_delivery_to: '13:00',
    delivery_notes: 'Tocar timbre',
    products_total_uyu: 3000,
    pickup_discount_uyu: 0,
    shipping_cost_uyu: 250,
    payable_total_uyu: 3250,
    currency: 'UYU',
    ...patch,
  };
}

function baseItems() {
  return [
    {
      title: 'Libro <especial>',
      quantity: 2,
      unit_price_uyu: 1000,
      line_total_uyu: 2000,
    },
    {
      title: 'Segundo libro',
      quantity: 1,
      unit_price_uyu: 1000,
      line_total_uyu: 1000,
    },
  ];
}

function baseEnv(patch = {}) {
  return {
    RESEND_API_KEY: 're_test_secret',
    SALES_NOTIFICATION_FROM: 'Amado Libros <ventas@amadolibros.com>',
    SALES_NOTIFICATION_TO: 'operaciones@amadolibros.com',
    ...patch,
  };
}

function memoryDb({ items = baseItems() } = {}) {
  const events = new Map();

  return {
    events,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (sql.startsWith('INSERT OR IGNORE INTO order_events')) {
                const [id, orderId, payload, createdAt] = args;
                if (events.has(id)) return { success: true, meta: { changes: 0 } };
                events.set(id, {
                  id,
                  order_id: orderId,
                  event_type: 'sale_notification',
                  payload_json: payload,
                  created_at: createdAt,
                });
                return { success: true, meta: { changes: 1 } };
              }

              if (sql.startsWith('UPDATE order_events SET payload_json=')) {
                const [nextPayload, id, expectedPayload] = args;
                const current = events.get(id);
                if (!current || current.payload_json !== expectedPayload) {
                  return { success: true, meta: { changes: 0 } };
                }
                current.payload_json = nextPayload;
                return { success: true, meta: { changes: 1 } };
              }

              throw new Error(`SQL run inesperado: ${sql}`);
            },
            async first() {
              if (sql.startsWith('SELECT payload_json FROM order_events')) {
                const event = events.get(args[0]);
                return event ? { payload_json: event.payload_json } : null;
              }
              throw new Error(`SQL first inesperado: ${sql}`);
            },
            async all() {
              if (sql.startsWith('SELECT title,quantity')) return { results: items };
              throw new Error(`SQL all inesperado: ${sql}`);
            },
          };
        },
      };
    },
  };
}

function eventState(db, orderId = 'order-uuid') {
  const event = db.events.get(`sale-email:${orderId}`);
  return event ? JSON.parse(event.payload_json) : null;
}

test('sale-email-1: arma asunto, texto y HTML con datos de venta y escape seguro', () => {
  const email = buildSaleEmail({
    order: baseOrder(),
    items: baseItems(),
    payment: { id: 123 },
  });

  assert.equal(email.subject, 'Nueva venta web — AL-260729-TEST');
  assert.match(email.text, /Ana <Pérez>/);
  assert.match(email.text, /2 × Libro <especial>/);
  assert.match(email.text, /Total pagado: \$3\.250 UYU/);
  assert.match(email.text, /Rincón 608/);
  assert.match(email.html, /Ana &lt;Pérez&gt;/);
  assert.match(email.html, /Libro &lt;especial&gt;/);
  assert.ok(!email.html.includes('Ana <Pérez>'));
});

test('sale-email-2: envía por Resend con clave idempotente y marca D1 como sent', async () => {
  const db = memoryDb();
  const requests = [];
  const sender = createSaleNotificationSender({
    fetchFn: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ id: 'email-provider-1' });
    },
    sleep: async () => {},
  });

  const result = await sender({
    db,
    env: baseEnv(),
    order: baseOrder(),
    payment: { id: 123 },
    now: NOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.providerId, 'email-provider-1');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.resend.com/emails');
  assert.equal(requests[0].options.headers['Idempotency-Key'], 'sale-notification/order-uuid');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer re_test_secret');

  const body = JSON.parse(requests[0].options.body);
  assert.deepEqual(body.to, ['operaciones@amadolibros.com']);
  assert.equal(body.subject, 'Nueva venta web — AL-260729-TEST');

  const state = eventState(db);
  assert.equal(state.status, 'sent');
  assert.equal(state.provider, 'resend');
  assert.equal(state.provider_id, 'email-provider-1');
});

test('sale-email-3: un webhook repetido no vuelve a enviar si D1 ya dice sent', async () => {
  const db = memoryDb();
  let requests = 0;
  const sender = createSaleNotificationSender({
    fetchFn: async () => {
      requests += 1;
      return Response.json({ id: 'email-provider-1' });
    },
    sleep: async () => {},
  });
  const args = {
    db,
    env: baseEnv(),
    order: baseOrder(),
    payment: { id: 123 },
    now: NOW,
  };

  const first = await sender(args);
  const second = await sender(args);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'already_sent');
  assert.equal(requests, 1);
});

test('sale-email-4: fallo transitorio reintenta, deja constancia y permite un webhook posterior', async () => {
  const db = memoryDb();
  let requests = 0;
  const sender = createSaleNotificationSender({
    fetchFn: async () => {
      requests += 1;
      if (requests <= 3) return Response.json({ message: 'temporary' }, { status: 500 });
      return Response.json({ id: 'email-provider-retry' });
    },
    sleep: async () => {},
  });
  const args = {
    db,
    env: baseEnv(),
    order: baseOrder(),
    payment: { id: 123 },
    now: NOW,
  };

  const originalError = console.error;
  console.error = () => {};
  try {
    const failed = await sender(args);
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'RESEND_HTTP_500');
    assert.equal(eventState(db).status, 'failed');
    assert.equal(eventState(db).failure_code, 'RESEND_HTTP_500');

    const retried = await sender({ ...args, now: new Date(NOW.getTime() + 60_000) });
    assert.equal(retried.ok, true);
    assert.equal(eventState(db).status, 'sent');
    assert.equal(eventState(db).attempt, 2);
    assert.equal(requests, 4);
  } finally {
    console.error = originalError;
  }
});

test('sale-email-5: sin configuración no llama a Resend ni crea un evento engañoso', async () => {
  const db = memoryDb();
  let requests = 0;
  const sender = createSaleNotificationSender({
    fetchFn: async () => {
      requests += 1;
      return Response.json({ id: 'unexpected' });
    },
  });

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await sender({
      db,
      env: {},
      order: baseOrder(),
      payment: { id: 123 },
      now: NOW,
    });

    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.equal(result.code, 'EMAIL_CONFIG_MISSING');
    assert.equal(requests, 0);
    assert.equal(db.events.size, 0);
  } finally {
    console.warn = originalWarn;
  }
});
