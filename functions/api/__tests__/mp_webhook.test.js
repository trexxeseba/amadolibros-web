import { test }  from 'node:test';
import assert     from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createMpWebhookHandler } from '../_mp_webhook_handler.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const TEST_SECRET       = 'test-webhook-secret';
const TEST_TOKEN        = 'TEST-ACCESS-TOKEN';
const TEST_COLLECTOR_ID = 3559407834;
const PROD_COLLECTOR_ID = 440298103;
const NOW         = new Date('2026-07-21T12:00:00.000Z');

const PREVIEW_ENV_CONFIG = {
  APP_ENV:          'preview',
  MP_COLLECTOR_ID:  String(TEST_COLLECTOR_ID),
  CHECKOUT_ENABLED: 'true',
  CANONICAL_ORIGIN: 'https://feature.amadolibros-web.pages.dev',
};

const PRODUCTION_ENV_CONFIG = {
  APP_ENV:          'production',
  MP_COLLECTOR_ID:  String(PROD_COLLECTOR_ID),
  CHECKOUT_ENABLED: 'true',
  CANONICAL_ORIGIN: 'https://www.amadolibros.com',
  ALLOWED_HOSTS:    'amadolibros.com,www.amadolibros.com',
};

function hmac(secret, msg) {
  return createHmac('sha256', secret).update(msg).digest('hex');
}

function buildSig({ secret = TEST_SECRET, ts = '1700000000', queryDataId = '123', requestId = 'req-001' } = {}) {
  const msg = `id:${queryDataId};request-id:${requestId};ts:${ts};`;
  return `ts=${ts},v1=${hmac(secret, msg)}`;
}

function makeReq({
  method     = 'POST',
  host       = 'feature.amadolibros-web.pages.dev',
  queryDataId = '123',
  type       = 'payment',
  bodyDataId  = '123',
  requestId  = 'req-001',
  ts         = '1700000000',
  secret     = TEST_SECRET,
  xSig       = undefined,
  noXSig     = false,
  noXReqId   = false,
  bodyPatch  = {},
} = {}) {
  const sig = xSig ?? buildSig({ secret, ts, queryDataId, requestId });
  const url = `https://${host}/api/webhooks/mercadopago?data.id=${encodeURIComponent(queryDataId)}&type=${type}`;
  const headers = { 'Content-Type': 'application/json' };
  if (!noXSig)   headers['x-signature']   = sig;
  if (!noXReqId) headers['x-request-id']  = requestId;

  const body = JSON.stringify({
    action:       'payment.updated',
    api_version:  'v1',
    data:         { id: bodyDataId },
    date_created: '2026-01-01T00:00:00Z',
    id:           99999,
    live_mode:    false,
    type,
    user_id:      '12345',
    ...bodyPatch,
  });
  return new Request(url, { method, headers, body });
}

function basePayment(patch = {}) {
  return {
    ok:                 true,
    id:                 123,
    status:             'approved',
    live_mode:          false,
    collector_id:       TEST_COLLECTOR_ID,
    currency_id:        'UYU',
    transaction_amount: 3100,
    external_reference: 'AL-TEST',
    order_id:           null,
    date_approved:      '2026-07-21T11:00:00.000Z',
    ...patch,
  };
}

function baseMerchantOrder(patch = {}) {
  return {
    ok:                 true,
    id:                 999,
    preference_id:      'pref-1',
    external_reference: 'AL-TEST',
    payments:           [{ id: 123, status: 'approved' }],
    ...patch,
  };
}

function baseOrder(patch = {}) {
  return {
    id:                     'order-uuid',
    status:                 'open',
    payment_status:         'not_started',
    payable_total_uyu:      3100,
    payment_preference_id:  'pref-1',
    ...patch,
  };
}

function dbMock({ order = baseOrder(), batchError = null } = {}) {
  const batches = [];
  return {
    batches,
    prepare(sql) {
      return {
        bind(..._args) {
          return {
            async first() {
              if (sql.includes('public_code')) return order;
              return null;
            },
            async run() { return { success: true, meta: { changes: 1 } }; },
          };
        },
      };
    },
    async batch(stmts) {
      batches.push(stmts);
      if (batchError) throw batchError;
      return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
}

function env(opts = {}) {
  return {
    ...(opts.config !== undefined ? opts.config : PREVIEW_ENV_CONFIG),
    MP_WEBHOOK_SECRET: TEST_SECRET,
    MP_ACCESS_TOKEN:   TEST_TOKEN,
    ORDERS_DB:         dbMock(opts.db ? opts.db : {}),
    ...opts.extra,
  };
}

function handler({ getPayment = async () => basePayment(), getMerchantOrder = async () => ({ ok: false, code: 'NOT_FOUND' }) } = {}) {
  return createMpWebhookHandler({ mpClient: { getPayment, getMerchantOrder }, getNow: () => NOW });
}

async function call(reqOpts = {}, mpOpts = {}, envOpts = {}) {
  const h   = handler(mpOpts);
  const req = makeReq(reqOpts);
  const e   = env(envOpts);
  const res = await h({ request: req, env: e });
  let data = null;
  try { data = await res.json(); } catch { /* respuestas 503 pueden no tener cuerpo */ }
  return { res, data, db: e.ORDERS_DB };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('wh-01: firma válida con query data.id → 200 ok', async () => {
  const { res, data } = await call();
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
});

test('wh-02: query data.id ausente → 401', async () => {
  const req = makeReq();
  const url = new URL(req.url);
  url.searchParams.delete('data.id');
  const r2 = new Request(url.toString(), req);
  const h  = handler();
  const res = await h({ request: r2, env: env() });
  assert.equal(res.status, 401);
});

test('wh-03: body data.id ausente → 400', async () => {
  const { res } = await call({ bodyPatch: { data: {} } });
  assert.equal(res.status, 400);
});

test('wh-04: query y body data.id distintos → 400', async () => {
  const { res } = await call({ queryDataId: '123', bodyDataId: '999' });
  assert.equal(res.status, 400);
});

test('wh-05: x-request-id ausente → 401', async () => {
  const { res } = await call({ noXReqId: true });
  assert.equal(res.status, 401);
});

test('wh-06: x-signature ausente → 401', async () => {
  const { res } = await call({ noXSig: true });
  assert.equal(res.status, 401);
});

test('wh-07: firma inválida (secret incorrecto) → 401', async () => {
  const { res } = await call({ secret: 'wrong-secret' });
  assert.equal(res.status, 401);
});

test('wh-08: x-signature malformada (sin v1) → 401', async () => {
  const { res } = await call({ xSig: 'ts=1700000000' });
  assert.equal(res.status, 401);
});

test('wh-09: tipo no payment con firma válida → 200 sin procesar', async () => {
  const { res, data, db } = await call({ type: 'merchant_order', bodyPatch: { type: 'merchant_order' } });
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(db.batches.length, 0);
});

test('wh-10: método GET → 405', async () => {
  const url = 'https://feature.amadolibros-web.pages.dev/api/webhooks/mercadopago?data.id=123&type=payment';
  const req = new Request(url, { method: 'GET' });
  const h   = handler();
  const res = await h({ request: req, env: env() });
  assert.equal(res.status, 405);
});

test('wh-11: host no permitido → 400', async () => {
  const { res } = await call({ host: 'malicious.example.com' });
  assert.equal(res.status, 400);
});

test('wh-12: secrets no configurados → 503', async () => {
  const req = makeReq();
  const h   = handler();
  const res = await h({ request: req, env: { ...PREVIEW_ENV_CONFIG, ORDERS_DB: dbMock() } });
  assert.equal(res.status, 503);
});

test('wh-13: getPayment 404 → 503 (imposibilidad de validar, MP debe reintentar — ya no 200 silencioso)', async () => {
  const { res, db } = await call(
    {},
    { getPayment: async () => ({ ok: false, code: 'NOT_FOUND' }) }
  );
  assert.equal(res.status, 503);
  assert.equal(db.batches.length, 0);
});

test('wh-14: getPayment 401 → 503 (MP debe reintentar)', async () => {
  const { res } = await call(
    {},
    { getPayment: async () => ({ ok: false, code: 'MP_AUTH_ERROR' }) }
  );
  assert.equal(res.status, 503);
});

test('wh-15: getPayment 429 → 503', async () => {
  const { res } = await call(
    {},
    { getPayment: async () => ({ ok: false, code: 'MP_RATE_LIMIT' }) }
  );
  assert.equal(res.status, 503);
});

test('wh-16: getPayment timeout → 503', async () => {
  const { res } = await call(
    {},
    { getPayment: async () => ({ ok: false, code: 'MP_TIMEOUT' }) }
  );
  assert.equal(res.status, 503);
});

test('wh-17: live_mode true con identidad verificada (collector/monto/referencia) → procesa el pago', async () => {
  const { res, db } = await call(
    {},
    { getPayment: async () => basePayment({ live_mode: true }) }
  );
  assert.equal(res.status, 200);
  assert.equal(db.batches.length, 1);
});

test('wh-45: collector_id incorrecto con live_mode true → sigue rechazando', async () => {
  const { res, db } = await call(
    {},
    { getPayment: async () => basePayment({ live_mode: true, collector_id: 9999 }) }
  );
  assert.equal(res.status, 200);
  assert.equal(db.batches.length, 0);
});

test('wh-18: collector_id incorrecto → 200 silencio', async () => {
  const { res, db } = await call(
    {},
    { getPayment: async () => basePayment({ collector_id: 9999 }) }
  );
  assert.equal(res.status, 200);
  assert.equal(db.batches.length, 0);
});

test('wh-19: moneda incorrecta → 200 silencio', async () => {
  const { res, db } = await call(
    {},
    { getPayment: async () => basePayment({ currency_id: 'ARS' }) }
  );
  assert.equal(res.status, 200);
  assert.equal(db.batches.length, 0);
});

test('wh-20: external_reference nula → 200 silencio', async () => {
  const { res, db } = await call(
    {},
    { getPayment: async () => basePayment({ external_reference: null }) }
  );
  assert.equal(res.status, 200);
  assert.equal(db.batches.length, 0);
});

test('wh-21: orden no encontrada en D1 → 200 silencio', async () => {
  const { res, db } = await call(
    {},
    {},
    { db: { order: null } }
  );
  assert.equal(res.status, 200);
  assert.equal(db.batches.length, 0);
});

test('wh-22: monto exacto funciona', async () => {
  const { res, data } = await call(
    {},
    { getPayment: async () => basePayment({ transaction_amount: 3100 }) },
    { db: { order: baseOrder({ payable_total_uyu: 3100 }) } }
  );
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
});

test('wh-23: monto distinto → 200 silencio', async () => {
  const { res, db } = await call(
    {},
    { getPayment: async () => basePayment({ transaction_amount: 3101 }) },
    { db: { order: baseOrder({ payable_total_uyu: 3100 }) } }
  );
  assert.equal(res.status, 200);
  assert.equal(db.batches.length, 0);
});

test('wh-24: monto decimal que no coincide exactamente → 200 silencio', async () => {
  const { res, db } = await call(
    {},
    { getPayment: async () => basePayment({ transaction_amount: 3100.5 }) },
    { db: { order: baseOrder({ payable_total_uyu: 3100 }) } }
  );
  assert.equal(res.status, 200);
  assert.equal(db.batches.length, 0);
});

test('wh-25: getMerchantOrder transitorio → 503', async () => {
  const { res } = await call(
    {},
    {
      getPayment:       async () => basePayment({ order_id: 999 }),
      getMerchantOrder: async () => ({ ok: false, code: 'MP_API_ERROR' }),
    }
  );
  assert.equal(res.status, 503);
});

test('wh-25b: getMerchantOrder NOT_FOUND (con order_id presente) → 503, no 200 (imposibilidad de validar)', async () => {
  const { res, db } = await call(
    {},
    {
      getPayment:       async () => basePayment({ order_id: 999 }),
      getMerchantOrder: async () => ({ ok: false, code: 'NOT_FOUND' }),
    }
  );
  assert.equal(res.status, 503);
  assert.equal(db.batches.length, 0);
});

test('wh-26: merchant order sin payment ID → 200 silencio', async () => {
  const { res, db } = await call(
    {},
    {
      getPayment:       async () => basePayment({ order_id: 999 }),
      getMerchantOrder: async () => baseMerchantOrder({ payments: [] }),
    }
  );
  assert.equal(res.status, 200);
  assert.equal(db.batches.length, 0);
});

test('wh-27: preference_id incorrecto → 200 silencio', async () => {
  const { res, db } = await call(
    {},
    {
      getPayment:       async () => basePayment({ order_id: 999 }),
      getMerchantOrder: async () => baseMerchantOrder({ preference_id: 'other-pref' }),
    },
    { db: { order: baseOrder({ payment_preference_id: 'pref-1' }) } }
  );
  assert.equal(res.status, 200);
  assert.equal(db.batches.length, 0);
});

test('wh-28: external_reference incorrecta en merchant order → 200 silencio', async () => {
  const { res, db } = await call(
    {},
    {
      getPayment:       async () => basePayment({ order_id: 999 }),
      getMerchantOrder: async () => baseMerchantOrder({ external_reference: 'AL-OTRO' }),
    }
  );
  assert.equal(res.status, 200);
  assert.equal(db.batches.length, 0);
});

test('wh-29: approved → D1 actualizado, evento insertado', async () => {
  const db_ = dbMock();
  const h   = handler({ getPayment: async () => basePayment({ status: 'approved' }) });
  const res = await h({ request: makeReq(), env: { ...PREVIEW_ENV_CONFIG, MP_WEBHOOK_SECRET: TEST_SECRET, MP_ACCESS_TOKEN: TEST_TOKEN, ORDERS_DB: db_ } });
  assert.equal(res.status, 200);
  assert.equal(db_.batches.length, 1);
  const stmts = db_.batches[0];
  const updateSql = stmts[0].sql ?? stmts[0].stmt?.sql ?? stmts[0]._stmt?.sql;
  assert.ok(stmts[0] !== undefined);
});

test('wh-30: pending → D1 actualizado', async () => {
  const db_ = dbMock({ order: baseOrder({ payment_status: 'not_started' }) });
  const h   = handler({ getPayment: async () => basePayment({ status: 'pending' }) });
  const res = await h({ request: makeReq(), env: { ...PREVIEW_ENV_CONFIG, MP_WEBHOOK_SECRET: TEST_SECRET, MP_ACCESS_TOKEN: TEST_TOKEN, ORDERS_DB: db_ } });
  assert.equal(res.status, 200);
  assert.equal(db_.batches.length, 1);
});

test('wh-31: in_process → normaliza a pending, D1 actualizado', async () => {
  const db_ = dbMock({ order: baseOrder({ payment_status: 'not_started' }) });
  const h   = handler({ getPayment: async () => basePayment({ status: 'in_process' }) });
  const res = await h({ request: makeReq(), env: { ...PREVIEW_ENV_CONFIG, MP_WEBHOOK_SECRET: TEST_SECRET, MP_ACCESS_TOKEN: TEST_TOKEN, ORDERS_DB: db_ } });
  assert.equal(res.status, 200);
  assert.equal(db_.batches.length, 1);
});

test('wh-32: rejected → D1 actualizado', async () => {
  const db_ = dbMock({ order: baseOrder({ payment_status: 'pending' }) });
  const h   = handler({ getPayment: async () => basePayment({ status: 'rejected', date_approved: null }) });
  const res = await h({ request: makeReq(), env: { ...PREVIEW_ENV_CONFIG, MP_WEBHOOK_SECRET: TEST_SECRET, MP_ACCESS_TOKEN: TEST_TOKEN, ORDERS_DB: db_ } });
  assert.equal(res.status, 200);
  assert.equal(db_.batches.length, 1);
});

test('wh-33: cancelled → D1 actualizado', async () => {
  const db_ = dbMock({ order: baseOrder({ payment_status: 'not_started' }) });
  const h   = handler({ getPayment: async () => basePayment({ status: 'cancelled', date_approved: null }) });
  const res = await h({ request: makeReq(), env: { ...PREVIEW_ENV_CONFIG, MP_WEBHOOK_SECRET: TEST_SECRET, MP_ACCESS_TOKEN: TEST_TOKEN, ORDERS_DB: db_ } });
  assert.equal(res.status, 200);
  assert.equal(db_.batches.length, 1);
});

test('wh-34: refunded → D1 actualizado', async () => {
  const db_ = dbMock({ order: baseOrder({ payment_status: 'approved', status: 'paid' }) });
  const h   = handler({ getPayment: async () => basePayment({ status: 'refunded', date_approved: null }) });
  const res = await h({ request: makeReq(), env: { ...PREVIEW_ENV_CONFIG, MP_WEBHOOK_SECRET: TEST_SECRET, MP_ACCESS_TOKEN: TEST_TOKEN, ORDERS_DB: db_ } });
  assert.equal(res.status, 200);
  assert.equal(db_.batches.length, 1);
});

test('wh-35: webhook approved repetido → 200, batch ejecutado (INSERT OR IGNORE en D1)', async () => {
  const db_ = dbMock({ order: baseOrder({ payment_status: 'approved', status: 'paid' }) });
  const h   = handler({ getPayment: async () => basePayment({ status: 'approved' }) });
  const res1 = await h({ request: makeReq(), env: { ...PREVIEW_ENV_CONFIG, MP_WEBHOOK_SECRET: TEST_SECRET, MP_ACCESS_TOKEN: TEST_TOKEN, ORDERS_DB: db_ } });
  const res2 = await h({ request: makeReq(), env: { ...PREVIEW_ENV_CONFIG, MP_WEBHOOK_SECRET: TEST_SECRET, MP_ACCESS_TOKEN: TEST_TOKEN, ORDERS_DB: db_ } });
  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);
});

test('wh-36: rejected seguido de approved con nuevo payment_id → 200 ambos', async () => {
  const db_ = dbMock({ order: baseOrder({ payment_status: 'rejected' }) });
  const h   = handler({ getPayment: async () => basePayment({ id: 456, status: 'approved' }) });
  const req = makeReq({ queryDataId: '456', bodyDataId: '456', secret: TEST_SECRET });
  const sig = buildSig({ queryDataId: '456' });
  const req2 = makeReq({ queryDataId: '456', bodyDataId: '456', xSig: sig });
  const res = await h({ request: req2, env: { ...PREVIEW_ENV_CONFIG, MP_WEBHOOK_SECRET: TEST_SECRET, MP_ACCESS_TOKEN: TEST_TOKEN, ORDERS_DB: db_ } });
  assert.equal(res.status, 200);
  assert.equal(db_.batches.length, 1);
});

test('wh-37: approved no degradado por pending posterior', async () => {
  const db_ = dbMock({ order: baseOrder({ payment_status: 'approved', status: 'paid' }) });
  const h   = handler({ getPayment: async () => basePayment({ id: 789, status: 'pending', date_approved: null }) });
  const sig = buildSig({ queryDataId: '789' });
  const res = await h({ request: makeReq({ queryDataId: '789', bodyDataId: '789', xSig: sig }), env: { ...PREVIEW_ENV_CONFIG, MP_WEBHOOK_SECRET: TEST_SECRET, MP_ACCESS_TOKEN: TEST_TOKEN, ORDERS_DB: db_ } });
  assert.equal(res.status, 200);
  assert.equal(db_.batches.length, 1);
});

test('wh-38: error D1 en batch → 500', async () => {
  const { res } = await call(
    {},
    {},
    { db: { order: baseOrder(), batchError: new Error('D1 error') } }
  );
  assert.equal(res.status, 500);
});

test('wh-39: Cache-Control: no-store siempre presente', async () => {
  const cases = [
    call({ noXSig: true }),
    call(),
  ];
  const results = await Promise.all(cases);
  for (const { res } of results) {
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  }
});

test('wh-40: respuesta no expone token, secret ni SQL', async () => {
  const { data } = await call({ noXSig: true });
  const text = JSON.stringify(data);
  assert.ok(!text.includes(TEST_SECRET));
  assert.ok(!text.includes(TEST_TOKEN));
  assert.ok(!text.toLowerCase().includes('select'));
});

test('wh-41: getMerchantOrder NOT_FOUND (sin order_id) → procesa normalmente', async () => {
  const { res, data } = await call(
    {},
    {
      getPayment:       async () => basePayment({ order_id: null }),
      getMerchantOrder: async () => ({ ok: false, code: 'NOT_FOUND' }),
    }
  );
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
});

test('wh-42: payment_preference_id con prefijo creating: → omite validación de preferencia', async () => {
  const { res, data } = await call(
    {},
    {
      getPayment:       async () => basePayment({ order_id: 999 }),
      getMerchantOrder: async () => baseMerchantOrder({ preference_id: 'other-pref' }),
    },
    { db: { order: baseOrder({ payment_preference_id: 'creating:123:uuid' }) } }
  );
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
});

test('wh-43: authorized → normaliza a pending', async () => {
  const db_ = dbMock({ order: baseOrder() });
  const h   = handler({ getPayment: async () => basePayment({ status: 'authorized', date_approved: null }) });
  const res = await h({ request: makeReq(), env: { ...PREVIEW_ENV_CONFIG, MP_WEBHOOK_SECRET: TEST_SECRET, MP_ACCESS_TOKEN: TEST_TOKEN, ORDERS_DB: db_ } });
  assert.equal(res.status, 200);
  assert.equal(db_.batches.length, 1);
});

test('wh-44: charged_back → normaliza a refunded', async () => {
  const db_ = dbMock({ order: baseOrder({ payment_status: 'approved' }) });
  const h   = handler({ getPayment: async () => basePayment({ status: 'charged_back', date_approved: null }) });
  const res = await h({ request: makeReq(), env: { ...PREVIEW_ENV_CONFIG, MP_WEBHOOK_SECRET: TEST_SECRET, MP_ACCESS_TOKEN: TEST_TOKEN, ORDERS_DB: db_ } });
  assert.equal(res.status, 200);
  assert.equal(db_.batches.length, 1);
});

// ══════════════════════════════════════════════════════════════════════════════
// 2-N-E1 — config centralizada, APP_ENV production, live_mode por ambiente,
// hosts, kill switch
// ══════════════════════════════════════════════════════════════════════════════

function captureWarn(fn) {
  const calls = [];
  const orig  = console.warn;
  console.warn = (...args) => { calls.push(args); };
  return fn().finally(() => { console.warn = orig; }).then(result => ({ result, calls }));
}

// ── Config fail-closed ──────────────────────────────────────────────────────
test('cfg-1: APP_ENV ausente → 503 fail-closed', async () => {
  const { res } = await call({}, {}, { config: { ...PREVIEW_ENV_CONFIG, APP_ENV: undefined } });
  assert.equal(res.status, 503);
});

test('cfg-2: APP_ENV inválido → 503 fail-closed', async () => {
  const { res } = await call({}, {}, { config: { ...PREVIEW_ENV_CONFIG, APP_ENV: 'staging' } });
  assert.equal(res.status, 503);
});

test('cfg-3: MP_COLLECTOR_ID inválido → 503 fail-closed', async () => {
  const { res } = await call({}, {}, { config: { ...PREVIEW_ENV_CONFIG, MP_COLLECTOR_ID: '3559-407834' } });
  assert.equal(res.status, 503);
});

test('cfg-4: Production sin ALLOWED_HOSTS → 503 fail-closed', async () => {
  const { res } = await call({}, {}, { config: { ...PRODUCTION_ENV_CONFIG, ALLOWED_HOSTS: undefined } });
  assert.equal(res.status, 503);
});

// ── APP_ENV=production: collector real, live_mode:true esperado ─────────────
test('prod-1: APP_ENV=production, collector correcto, live_mode:true esperado → procesa sin warning', async () => {
  const db_ = dbMock({ order: baseOrder() });
  const h   = handler({ getPayment: async () => basePayment({ collector_id: PROD_COLLECTOR_ID, live_mode: true }) });
  const req = makeReq({ host: 'www.amadolibros.com' });
  const { result: res, calls } = await captureWarn(() =>
    h({ request: req, env: { ...PRODUCTION_ENV_CONFIG, MP_WEBHOOK_SECRET: TEST_SECRET, MP_ACCESS_TOKEN: TEST_TOKEN, ORDERS_DB: db_ } })
  );
  assert.equal(res.status, 200);
  assert.equal(db_.batches.length, 1, 'debe procesar el pago (live_mode:true es lo esperado en production)');
  assert.equal(calls.length, 0, 'no debe loguear warning cuando live_mode coincide con lo esperado');
});

test('prod-2: APP_ENV=production, live_mode:false inesperado → warning, pero procesa igual', async () => {
  const db_ = dbMock({ order: baseOrder() });
  const h   = handler({ getPayment: async () => basePayment({ collector_id: PROD_COLLECTOR_ID, live_mode: false }) });
  const req = makeReq({ host: 'www.amadolibros.com' });
  const { result: res, calls } = await captureWarn(() =>
    h({ request: req, env: { ...PRODUCTION_ENV_CONFIG, MP_WEBHOOK_SECRET: TEST_SECRET, MP_ACCESS_TOKEN: TEST_TOKEN, ORDERS_DB: db_ } })
  );
  assert.equal(res.status, 200);
  assert.equal(db_.batches.length, 1, 'live_mode inesperado no debe bloquear un pago por lo demás válido');
  assert.equal(calls.length, 1, 'debe loguear exactamente un warning');
  const [msg, meta] = calls[0];
  assert.match(msg, /live_mode/);
  assert.equal(meta.app_env, 'production');
  assert.equal(meta.expected, true);
  assert.equal(meta.observed, false);
});

test('prod-3: APP_ENV=production, collector_id de test → sigue rechazado (200 silencio) sin importar live_mode', async () => {
  const { res, db } = await call(
    { host: 'www.amadolibros.com' },
    { getPayment: async () => basePayment({ collector_id: TEST_COLLECTOR_ID, live_mode: true }) },
    { config: PRODUCTION_ENV_CONFIG }
  );
  assert.equal(res.status, 200);
  assert.equal(db.batches.length, 0);
});

test('warn-1: preview con live_mode:false (esperado) → sin warning', async () => {
  const { result: res, calls } = await captureWarn(() => call({}, { getPayment: async () => basePayment({ live_mode: false }) }).then(r => r.res));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 0);
});

// ── Kill switch no debe afectar al webhook ───────────────────────────────────
test('kill-1: CHECKOUT_ENABLED="false" no bloquea el webhook', async () => {
  const { res, db } = await call({}, {}, { config: { ...PREVIEW_ENV_CONFIG, CHECKOUT_ENABLED: 'false' } });
  assert.equal(res.status, 200);
  assert.equal(db.batches.length, 1);
});

test('kill-2: CHECKOUT_ENABLED ausente no bloquea el webhook', async () => {
  const { res, db } = await call({}, {}, { config: { ...PREVIEW_ENV_CONFIG, CHECKOUT_ENABLED: undefined } });
  assert.equal(res.status, 200);
  assert.equal(db.batches.length, 1);
});

// ── Hosts: legítimos vs engañosos ────────────────────────────────────────────
test('host-1: dominio engañoso tipo prefijo (evilamadolibros-web.pages.dev) → 400', async () => {
  const { res } = await call({ host: 'evilamadolibros-web.pages.dev' });
  assert.equal(res.status, 400);
});

test('host-2: dominio engañoso tipo sufijo (amadolibros-web.pages.dev.evil.com) → 400', async () => {
  const { res } = await call({ host: 'amadolibros-web.pages.dev.evil.com' });
  assert.equal(res.status, 400);
});

test('host-3: Production acepta www.amadolibros.com y amadolibros.com, rechaza otros subdominios', async () => {
  const okReq   = { host: 'www.amadolibros.com' };
  const okReq2  = { host: 'amadolibros.com' };
  const badReq  = { host: 'staging.amadolibros.com' };
  const r1 = await call(okReq,  { getPayment: async () => basePayment({ collector_id: PROD_COLLECTOR_ID }) }, { config: PRODUCTION_ENV_CONFIG });
  const r2 = await call(okReq2, { getPayment: async () => basePayment({ collector_id: PROD_COLLECTOR_ID }) }, { config: PRODUCTION_ENV_CONFIG });
  const r3 = await call(badReq, {}, { config: PRODUCTION_ENV_CONFIG });
  assert.notEqual(r1.res.status, 400);
  assert.notEqual(r2.res.status, 400);
  assert.equal(r3.res.status, 400);
});

// ── El webhook nunca exige encabezado Origin (Mercado Pago no es un navegador) ──
test('origin-1: request sin encabezado Origin funciona normalmente', async () => {
  const req = makeReq();
  assert.equal(req.headers.get('Origin'), null, 'precondición: la request de prueba no manda Origin');
  const { res } = await call();
  assert.equal(res.status, 200);
});
