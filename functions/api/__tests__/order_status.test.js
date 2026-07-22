import { test } from 'node:test';
import assert    from 'node:assert/strict';
import { createOrderStatusHandler } from '../_order_status_handler.js';

const ALLOWED_HOST = 'feature.amadolibros-web.pages.dev';

function dbMock({ order = null } = {}) {
  return {
    prepare(sql) {
      return {
        bind(..._args) {
          return {
            async first() { return order; },
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

function env(order = { payment_status: 'approved', status: 'paid' }) {
  return { ORDERS_DB: dbMock({ order }) };
}

async function call(reqOpts = {}, order = { payment_status: 'approved', status: 'paid' }) {
  const h   = createOrderStatusHandler();
  const req = makeReq(reqOpts);
  const res = await h({ request: req, env: env(order) });
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
  const res = await h({ request: req, env: { ORDERS_DB: dbMock({ order: null }) } });
  assert.equal(res.status, 404);
});

test('os-06: host no permitido → 400', async () => {
  const { res } = await call({ host: 'evil.example.com', body: { public_code: 'AL-001', idempotency_key: 'k' } });
  assert.equal(res.status, 400);
});

test('os-07: respuesta solo expone payment_status y status', async () => {
  const { res, data } = await call({ body: { public_code: 'AL-001', idempotency_key: 'key-1' } });
  assert.equal(res.status, 200);
  const keys = Object.keys(data);
  assert.ok(keys.includes('payment_status'));
  assert.ok(keys.includes('status'));
  assert.ok(!keys.includes('id'));
  assert.ok(!keys.includes('payment_id'));
  assert.ok(!keys.includes('buyer_name'));
  assert.ok(!keys.includes('payable_total_uyu'));
  assert.equal(keys.length, 2);
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
  const res = await h({ request: req, env: {} });
  assert.equal(res.status, 503);
});

test('os-12: Content-Type incorrecto → 415', async () => {
  const { res } = await call({ ct: 'text/plain', body: '{}' });
  assert.equal(res.status, 415);
});
