import { test } from 'node:test';
import assert    from 'node:assert/strict';
import { createOrderStatusHandler } from '../_order_status_handler.js';

const ALLOWED_HOST = 'feature.amadolibros-web.pages.dev';

const PREVIEW_CONFIG = {
  APP_ENV:          'preview',
  MP_COLLECTOR_ID:  '3559407834',
  CHECKOUT_ENABLED: 'true',
  CANONICAL_ORIGIN: 'https://feature.amadolibros-web.pages.dev',
};

function dbMock({ order = null, items = [] } = {}) {
  return {
    prepare(sql) {
      return {
        bind(..._args) {
          return {
            async first() { return order; },
            async all() {
              return { results: sql.includes('FROM order_items') ? items : [] };
            },
          };
        },
      };
    },
  };
}

function makeReq({ method = 'POST', host = ALLOWED_HOST, body = undefined, ct = 'application/json' } = {}) {
  const headers = {};
  if (ct) headers['Content-Type'] = ct;
  return new Request(`https://${host}/api/orders/status`, {
    method,
    headers,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
}

function env(order = { id: 'order-1', public_code: 'AL-001', payment_status: 'approved', status: 'paid' }, envPatch = {}, items = []) {
  return { ...PREVIEW_CONFIG, ORDERS_DB: dbMock({ order, items }), ...envPatch };
}

async function call(reqOpts = {}, order = {
  id: 'order-1', public_code: 'AL-001', payment_status: 'approved', status: 'paid',
}, envPatch = {}) {
  const h   = createOrderStatusHandler();
  const req = makeReq(reqOpts);
  const res = await h({ request: req, env: env(order, envPatch) });
  let data;
  try { data = await res.json(); } catch { data = null; }
  return { res, data };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('os-01: par válido → 200 con payment_status y status', async () => {
  const { res, data } = await call({ body: { public_code: 'AL-001', idempotency_key: 'key-1' } });
  assert.equal(res.status, 200);
  assert.equal(data.payment_status, 'approved');
  assert.equal(data.status, 'paid');
});

test('os-02: método GET → 405', async () => {
  const { res } = await call({ method: 'GET', body: undefined });
  assert.equal(res.status, 405);
});

test('os-03: public_code ausente → 400', async () => {
  const { res } = await call({ body: { idempotency_key: 'key-1' } });
  assert.equal(res.status, 400);
});

test('os-04: idempotency_key ausente → 400', async () => {
  const { res } = await call({ body: { public_code: 'AL-001' } });
  assert.equal(res.status, 400);
});

test('os-05: par inválido (no match en D1) → 404', async () => {
  const h   = createOrderStatusHandler();
  const req = makeReq({ body: { public_code: 'AL-999', idempotency_key: 'wrong-key' } });
  const res = await h({ request: req, env: env(null) });
  assert.equal(res.status, 404);
});

test('os-06: host no permitido → 400', async () => {
  const { res } = await call({ host: 'evil.example.com', body: { public_code: 'AL-001', idempotency_key: 'k' } });
  assert.equal(res.status, 400);
});

test('os-07: respuesta expone solo estado y datos comerciales seguros para GA4', async () => {
  const { res, data } = await call({ body: { public_code: 'AL-001', idempotency_key: 'key-1' } });
  assert.equal(res.status, 200);
  const keys = Object.keys(data);
  assert.ok(keys.includes('payment_status'));
  assert.ok(keys.includes('status'));
  assert.ok(!keys.includes('id'));
  assert.ok(!keys.includes('payment_id'));
  assert.ok(!keys.includes('buyer_name'));
  assert.ok(!keys.includes('payable_total_uyu'));
  assert.deepEqual(keys.sort(), ['items', 'order', 'payment_status', 'status']);
  assert.ok(!Object.hasOwn(data.order, 'id'));
  assert.ok(!Object.hasOwn(data.order, 'idempotency_key'));
  assert.ok(!Object.hasOwn(data.order, 'buyer_email'));
});

test('os-07b: devuelve totales e items autenticados para purchase de GA4', async () => {
  const order = {
    id: 'order-1', public_code: 'AL-001', payment_status: 'approved', status: 'paid',
    delivery_type: 'shipping', products_total_uyu: 1100, pickup_discount_uyu: 0,
    shipping_cost_uyu: 190, payable_total_uyu: 1290, currency: 'UYU',
  };
  const items = [{
    product_id: 'MLU123', title: 'Libro', quantity: 1,
    unit_price_uyu: 1100, line_total_uyu: 1100,
  }];
  const h = createOrderStatusHandler();
  const req = makeReq({ body: { public_code: 'AL-001', idempotency_key: 'key-1' } });
  const res = await h({ request: req, env: env(order, {}, items) });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(data.order, {
    public_code: 'AL-001', delivery_type: 'shipping', products_total_uyu: 1100,
    pickup_discount_uyu: 0, shipping_cost_uyu: 190, payable_total_uyu: 1290,
    currency: 'UYU',
  });
  assert.deepEqual(data.items, items);
});

test('os-08: Cache-Control: no-store siempre', async () => {
  const { res }  = await call({ body: { public_code: 'AL-001', idempotency_key: 'k' } });
  const { res: r2 } = await call({ body: { public_code: 'AL-x', idempotency_key: 'y' } }, null);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(r2.headers.get('Cache-Control'), 'no-store');
});

test('os-09: payment_status not_started devuelto correctamente', async () => {
  const { res, data } = await call(
    { body: { public_code: 'AL-001', idempotency_key: 'key-1' } },
    { payment_status: 'not_started', status: 'open' }
  );
  assert.equal(res.status, 200);
  assert.equal(data.payment_status, 'not_started');
  assert.equal(data.status, 'open');
});

test('os-10: payment_status pending devuelto correctamente', async () => {
  const { data } = await call(
    { body: { public_code: 'AL-001', idempotency_key: 'key-1' } },
    { payment_status: 'pending', status: 'open' }
  );
  assert.equal(data.payment_status, 'pending');
});

test('os-11: ORDERS_DB no disponible → 503', async () => {
  const h   = createOrderStatusHandler();
  const req = makeReq({ body: { public_code: 'AL-001', idempotency_key: 'k' } });
  const res = await h({ request: req, env: { ...PREVIEW_CONFIG } });
  assert.equal(res.status, 503);
});

test('os-12: Content-Type incorrecto → 415', async () => {
  const { res } = await call({ ct: 'text/plain', body: '{}' });
  assert.equal(res.status, 415);
});

// ── 2-N-E1: config centralizada, fail-closed, hosts ─────────────────────────

test('os-13: APP_ENV ausente → 503 fail-closed (config inválida)', async () => {
  const { res } = await call(
    { body: { public_code: 'AL-001', idempotency_key: 'key-1' } },
    { payment_status: 'approved', status: 'paid' },
    { APP_ENV: undefined }
  );
  assert.equal(res.status, 503);
});

test('os-14: APP_ENV con valor inválido (ni preview ni production) → 503', async () => {
  const { res } = await call(
    { body: { public_code: 'AL-001', idempotency_key: 'key-1' } },
    { payment_status: 'approved', status: 'paid' },
    { APP_ENV: 'staging' }
  );
  assert.equal(res.status, 503);
});

test('os-15: MP_COLLECTOR_ID no decimal → 503', async () => {
  const { res } = await call(
    { body: { public_code: 'AL-001', idempotency_key: 'key-1' } },
    { payment_status: 'approved', status: 'paid' },
    { MP_COLLECTOR_ID: 'abc' }
  );
  assert.equal(res.status, 503);
});

test('os-16: dominio engañoso tipo prefijo (evilamadolibros-web.pages.dev) → 400', async () => {
  const { res } = await call({ host: 'evilamadolibros-web.pages.dev', body: { public_code: 'AL-001', idempotency_key: 'k' } });
  assert.equal(res.status, 400);
});

test('os-17: dominio engañoso tipo sufijo (amadolibros-web.pages.dev.evil.com) → 400', async () => {
  const { res } = await call({ host: 'amadolibros-web.pages.dev.evil.com', body: { public_code: 'AL-001', idempotency_key: 'k' } });
  assert.equal(res.status, 400);
});

test('os-18: hostname de Preview con hash de deployment válido → 200', async () => {
  const { res } = await call({ host: '61953b88.amadolibros-web.pages.dev', body: { public_code: 'AL-001', idempotency_key: 'key-1' } });
  assert.equal(res.status, 200);
});
