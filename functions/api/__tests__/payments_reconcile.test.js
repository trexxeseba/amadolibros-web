// Pagos sin registrar: incidentes y conciliación.
//
// Corre el código real (alta de pedido, aviso de Mercado Pago, conciliación)
// contra el esquema real de la base: todas las migraciones aplicadas sobre
// SQLite en memoria. Mercado Pago y el correo son dobles; no hay red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createOrdersHandler } from '../_orders_handler.js';
import { createMpWebhookHandler, isWebOrderReference } from '../_mp_webhook_handler.js';
import { createPaymentsReconcileHandler, needsProcessing } from '../_payments_reconcile_handler.js';
import { buildIncidentEmail, notifyPendingIncidents, reportIncident } from '../_payment_incidents.js';
import { searchRecentPayments } from '../_mp_client.js';
import { confirmTransfer } from '../../_shared/panel-transfer.js';

const COLLECTOR = 440298103;
const SECRET = 'secreto-de-prueba';
const HOST = 'https://www.amadolibros.com';
const MIGRATIONS = new URL('../../../migrations/', import.meta.url);

function world() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  }
  const clean = list => list.map(v => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));
  const stmt = (sql, params = []) => ({
    sql, params,
    bind: (...p) => stmt(sql, clean(p)),
    first: async () => sqlite.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...params).changes) } }),
  });
  const db = {
    prepare: sql => stmt(sql),
    batch: async list => {
      sqlite.exec('BEGIN');
      try {
        const out = list.map(s => ({ meta: { changes: Number(sqlite.prepare(s.sql).run(...s.params).changes) } }));
        sqlite.exec('COMMIT');
        return out;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const kvStore = new Map();
  const kv = { get: async k => kvStore.get(k) ?? null, put: async (k, v) => { kvStore.set(k, v); } };
  const state = { now: new Date('2026-11-25T15:00:00Z'), payments: new Map(), search: [], searchOk: true, mails: [], resendOk: true, sales: 0, getPaymentCalls: 0 };
  const realFetch = globalThis.fetch;
  const fetchFn = async (url, opts = {}) => {
    if (String(url).includes('api.resend.com')) {
      if (!state.resendOk) return new Response('{}', { status: 500 });
      state.mails.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ id: 'mail' }), { status: 200 });
    }
    throw new Error('salida no simulada: ' + url);
  };
  const env = {
    APP_ENV: 'production', MP_COLLECTOR_ID: String(COLLECTOR), CANONICAL_ORIGIN: HOST,
    ALLOWED_HOSTS: 'amadolibros.com,www.amadolibros.com', CHECKOUT_ENABLED: 'true',
    MP_ACCESS_TOKEN: 'token', MP_WEBHOOK_SECRET: SECRET, TURNSTILE_SECRET_KEY: 'x',
    RESEND_API_KEY: 're_x', SALES_NOTIFICATION_FROM: 'Amado <web@example.test>', SALES_NOTIFICATION_TO: 'equipo@example.test',
    ORDERS_DB: db, AMADO_KV: kv,
  };
  const mpClient = {
    getPayment: async id => { state.getPaymentCalls++; return state.payments.get(String(id)) || { ok: false, code: 'NOT_FOUND' }; },
    getMerchantOrder: async () => ({ ok: false, code: 'NOT_FOUND' }),
    searchRecentPayments: async (_token, { offset = 0, limit = 50 } = {}) => (state.searchOk
      ? { ok: true, total: state.search.length, results: state.search.slice(offset, offset + limit) }
      : { ok: false, code: 'MP_API_ERROR' }),
  };
  const processorDeps = {
    saleNotifier: async () => { state.sales++; },
    orderEmails: { sendPaidCustomer: async () => {} },
    purchaseAnalytics: { sendPurchase: async () => {} },
    metaPurchase: { sendPurchase: async () => {} },
    incidents: { report: args => reportIncident({ ...args, fetchFn }) },
  };
  const orders = createOrdersHandler({
    fetchCatalog: async () => ({ items: [{ id: 'MLU1', title: 'Libro', price: 1500, available_quantity: 5, status: 'active', currency_id: 'UYU' }] }),
    getNow: () => state.now, verifyTurnstileToken: async () => ({ ok: true }),
  });
  const webhook = createMpWebhookHandler({ mpClient, getNow: () => state.now, ...processorDeps });
  const reconcile = createPaymentsReconcileHandler({
    mpClient, getNow: () => state.now, processorDeps,
    notifyPending: args => notifyPendingIncidents({ ...args, fetchFn }),
  });

  const call = async (handler, path, body, headers = {}) => {
    const pending = [];
    const response = await handler({
      request: new Request(HOST + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }),
      env, waitUntil: p => pending.push(p),
    });
    await Promise.all(pending);
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return {
    sqlite, db, env, state, kvStore,
    async order(key = randomUUID()) {
      const r = await call(orders, '/api/orders', {
        idempotency_key: key, items: [{ product_id: 'MLU1', quantity: 1 }], delivery_type: 'pickup', pickup_ack: true,
        buyer: { name: 'Cliente Prueba', phone: '099123456', email: 'cliente@example.test' }, cf_turnstile_response: 't',
      });
      assert.equal(r.status, 201);
      return r.body.order;
    },
    payment(id, patch) {
      const p = { ok: true, id, status: 'approved', live_mode: true, collector_id: COLLECTOR, currency_id: 'UYU', order_id: null,
        date_approved: state.now.toISOString(), status_detail: 'accredited', payment_method_id: 'visa', payment_type_id: 'credit_card', ...patch };
      state.payments.set(String(id), p);
      state.search.unshift({ id: String(id), status: p.status, collector_id: p.collector_id, external_reference: p.external_reference });
      return p;
    },
    notify(id) {
      const rid = randomUUID(); const ts = '1700000000';
      const v1 = createHmac('sha256', SECRET).update(`id:${id};request-id:${rid};ts:${ts};`).digest('hex');
      return call(webhook, `/api/webhooks/mercadopago?data.id=${id}&type=payment`, { type: 'payment', data: { id: String(id) } },
        { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': rid });
    },
    reconcile() { return call(reconcile, '/api/payments/reconcile', {}); },
    later(minutes) { state.now = new Date(state.now.getTime() + minutes * 60000); },
    row: code => sqlite.prepare('SELECT status,payment_status,payment_id,paid_amount_uyu FROM orders WHERE public_code=?').get(code),
    incidents: () => sqlite.prepare('SELECT reason,payment_id,public_code,order_id,mp_amount_uyu,order_amount_uyu,source,notified_at FROM payment_incidents ORDER BY created_at,id').all(),
    events: code => sqlite.prepare('SELECT e.event_type FROM order_events e JOIN orders o ON o.id=e.order_id WHERE o.public_code=? ORDER BY e.created_at,e.event_type').all(code).map(r => r.event_type),
    restore() { globalThis.fetch = realFetch; },
  };
}

// ── Incidentes desde el aviso firmado ───────────────────────────────────────

test('importe distinto: el pedido NO queda pagado, se anota el incidente y sale un correo', async () => {
  const w = world();
  const order = await w.order();
  w.payment(1, { transaction_amount: order.payable_total_uyu - 1, external_reference: order.public_code });
  assert.equal((await w.notify(1)).status, 200);
  assert.equal(w.row(order.public_code).payment_status, 'not_started');
  assert.equal(w.row(order.public_code).status, 'open');
  const [incident] = w.incidents();
  assert.equal(incident.reason, 'importe_distinto');
  assert.equal(incident.mp_amount_uyu, order.payable_total_uyu - 1);
  assert.equal(incident.order_amount_uyu, order.payable_total_uyu);
  assert.equal(incident.source, 'webhook');
  assert.ok(incident.notified_at);
  assert.equal(w.state.mails.length, 1);
  assert.match(w.state.mails[0].subject, /importe distinto/);
  assert.match(w.state.mails[0].text, /NO se marcó como pagado/);
  assert.equal(w.state.sales, 0, 'no sale el correo de venta');
});

test('el mismo aviso repetido no duplica el incidente ni el correo', async () => {
  const w = world();
  const order = await w.order();
  w.payment(1, { transaction_amount: 1, external_reference: order.public_code });
  await w.notify(1); await w.notify(1); await w.notify(1);
  assert.equal(w.incidents().length, 1);
  assert.equal(w.state.mails.length, 1);
});

test('cobro aprobado con un código de pedido que no existe: incidente sin pedido', async () => {
  const w = world();
  w.payment(2, { transaction_amount: 1500, external_reference: 'AL-261125-NOEXIS' });
  assert.equal((await w.notify(2)).status, 200);
  const [incident] = w.incidents();
  assert.equal(incident.reason, 'pedido_inexistente');
  assert.equal(incident.order_id, null);
  assert.equal(w.state.mails.length, 1);
});

test('ventas de Mercado Libre y pagos de otra cuenta no generan incidentes', async () => {
  const w = world();
  w.payment(3, { transaction_amount: 900, external_reference: 'MLU-venta-2000001' });
  w.payment(4, { transaction_amount: 900, external_reference: null });
  w.payment(5, { transaction_amount: 900, external_reference: 'AL-261125-OTRACU', collector_id: 999 });
  for (const id of [3, 4, 5]) assert.equal((await w.notify(id)).status, 200);
  assert.equal(w.incidents().length, 0);
  assert.equal(w.state.mails.length, 0);
});

test('un pago rechazado con importe distinto no es un incidente: no hubo cobro', async () => {
  const w = world();
  const order = await w.order();
  w.payment(6, { status: 'rejected', transaction_amount: 1, external_reference: order.public_code });
  await w.notify(6);
  assert.equal(w.incidents().length, 0);
});

test('segundo cobro aprobado sobre un pedido ya pagado: el pedido no cambia y se avisa', async () => {
  const w = world();
  const order = await w.order();
  w.payment(7, { transaction_amount: order.payable_total_uyu, external_reference: order.public_code });
  await w.notify(7);
  assert.equal(w.row(order.public_code).payment_id, '7');
  w.payment(8, { transaction_amount: order.payable_total_uyu, external_reference: order.public_code });
  await w.notify(8);
  assert.equal(w.row(order.public_code).payment_id, '7', 'el pedido sigue con el primer pago');
  assert.deepEqual(w.incidents().map(i => [i.reason, i.payment_id]), [['pago_duplicado', '8']]);
  assert.match(w.state.mails[0].subject, /cobrado dos veces/);
  assert.equal(w.state.sales, 2, 'el aviso de venta es idempotente en su propio módulo; acá sólo se cuenta la llamada');
});

test('el mismo pago aprobado avisado dos veces no es un duplicado', async () => {
  const w = world();
  const order = await w.order();
  w.payment(9, { transaction_amount: order.payable_total_uyu, external_reference: order.public_code });
  await w.notify(9); await w.notify(9);
  assert.equal(w.incidents().length, 0);
});

test('pedido pagado por transferencia que además recibe un cobro de Mercado Pago: se avisa el doble pago', async () => {
  const w = world();
  const order = await w.order();
  const full = w.sqlite.prepare('SELECT * FROM orders WHERE public_code=?').get(order.public_code);
  assert.equal((await confirmTransfer({ db: w.db, order: full, now: w.state.now })).ok, true);
  w.payment(10, { transaction_amount: order.payable_total_uyu, external_reference: order.public_code });
  await w.notify(10);
  assert.deepEqual(w.incidents().map(i => i.reason), ['pago_duplicado']);
  assert.equal(w.row(order.public_code).payment_id, null, 'sigue figurando como transferencia');
});

test('devolución de un pedido pagado: queda devuelto y se avisa una sola vez', async () => {
  const w = world();
  const order = await w.order();
  w.payment(11, { transaction_amount: order.payable_total_uyu, external_reference: order.public_code });
  await w.notify(11);
  w.payment(11, { status: 'refunded', transaction_amount: order.payable_total_uyu, external_reference: order.public_code });
  await w.notify(11); await w.notify(11);
  assert.equal(w.row(order.public_code).payment_status, 'refunded');
  assert.deepEqual(w.incidents().map(i => i.reason), ['pago_devuelto']);
  assert.equal(w.state.mails.length, 1);
});

test('si el correo del incidente falla, queda pendiente y la conciliación lo reenvía', async () => {
  const w = world();
  const order = await w.order();
  w.state.resendOk = false;
  w.payment(12, { transaction_amount: 1, external_reference: order.public_code });
  await w.notify(12);
  assert.equal(w.incidents()[0].notified_at, null);
  w.state.resendOk = true;
  const run = await w.reconcile();
  assert.equal(run.body.avisos_reenviados, 1);
  assert.ok(w.incidents()[0].notified_at);
  assert.equal(w.state.mails.length, 1);
});

// ── Conciliación ────────────────────────────────────────────────────────────

test('aviso perdido: la conciliación aplica el pago aprobado y válido, con rastro', async () => {
  const w = world();
  const order = await w.order();
  w.payment(20, { transaction_amount: order.payable_total_uyu, external_reference: order.public_code });
  // El aviso nunca llegó: no se llama a notify.
  const run = await w.reconcile();
  assert.equal(run.status, 200);
  assert.deepEqual([run.body.candidatos, run.body.aplicados, run.body.sin_asignar], [1, 1, 0]);
  const row = w.row(order.public_code);
  assert.deepEqual([row.status, row.payment_status, row.payment_id, row.paid_amount_uyu], ['paid', 'approved', '20', order.payable_total_uyu]);
  assert.ok(w.events(order.public_code).includes('payment_reconciled'));
  assert.equal(w.state.sales, 1, 'sale el aviso de venta al equipo');
  assert.equal(w.incidents().length, 0);
});

test('la conciliación NO marca pagado un cobro que no pasa las validaciones', async () => {
  const w = world();
  const order = await w.order();
  w.payment(21, { transaction_amount: order.payable_total_uyu + 300, external_reference: order.public_code });
  const run = await w.reconcile();
  assert.deepEqual([run.body.candidatos, run.body.aplicados, run.body.sin_asignar], [1, 0, 1]);
  assert.equal(w.row(order.public_code).payment_status, 'not_started');
  assert.deepEqual(w.incidents().map(i => [i.reason, i.source]), [['importe_distinto', 'conciliacion']]);
  assert.equal(w.state.sales, 0);
});

test('la conciliación no confía en la búsqueda: vuelve a pedir cada pago a Mercado Pago', async () => {
  const w = world();
  const order = await w.order();
  // La búsqueda dice "aprobado", pero el pago real está rechazado.
  w.payment(22, { status: 'rejected', transaction_amount: order.payable_total_uyu, external_reference: order.public_code });
  w.state.search[0].status = 'approved';
  await w.reconcile();
  assert.equal(w.state.getPaymentCalls, 1);
  assert.equal(w.row(order.public_code).payment_status, 'rejected');
  assert.equal(w.row(order.public_code).status, 'open');
});

test('un pago ya registrado por el aviso no se vuelve a procesar', async () => {
  const w = world();
  const order = await w.order();
  w.payment(23, { transaction_amount: order.payable_total_uyu, external_reference: order.public_code });
  await w.notify(23);
  const before = w.state.getPaymentCalls;
  const run = await w.reconcile();
  assert.equal(run.body.candidatos, 0);
  assert.equal(w.state.getPaymentCalls, before);
  assert.equal(w.state.sales, 1);
});

test('un incidente ya anotado no se reprocesa en cada corrida', async () => {
  const w = world();
  const order = await w.order();
  w.payment(24, { transaction_amount: 1, external_reference: order.public_code });
  await w.reconcile();
  const calls = w.state.getPaymentCalls;
  w.later(10);
  const second = await w.reconcile();
  assert.equal(second.body.candidatos, 0);
  assert.equal(w.state.getPaymentCalls, calls);
  assert.equal(w.incidents().length, 1);
  assert.equal(w.state.mails.length, 1);
});

test('cobro duplicado que sólo ve la conciliación', async () => {
  const w = world();
  const order = await w.order();
  w.payment(25, { transaction_amount: order.payable_total_uyu, external_reference: order.public_code });
  await w.notify(25);
  w.payment(26, { transaction_amount: order.payable_total_uyu, external_reference: order.public_code });
  await w.reconcile();
  assert.deepEqual(w.incidents().map(i => [i.reason, i.payment_id, i.source]), [['pago_duplicado', '26', 'conciliacion']]);
  assert.equal(w.row(order.public_code).payment_id, '25');
});

test('ventas de Mercado Libre en la misma cuenta se ignoran sin consultar nada', async () => {
  const w = world();
  for (let i = 0; i < 120; i++) w.state.search.push({ id: String(5000 + i), status: 'approved', collector_id: COLLECTOR, external_reference: null });
  const run = await w.reconcile();
  assert.equal(run.body.revisados, 120);
  assert.equal(run.body.de_la_web, 0);
  assert.equal(w.state.getPaymentCalls, 0);
});

test('freno de frecuencia: dos llamados seguidos corren una sola vez', async () => {
  const w = world();
  const first = await w.reconcile();
  const second = await w.reconcile();
  assert.equal(first.body.skipped, undefined);
  assert.equal(second.body.skipped, true);
  w.later(5);
  assert.equal((await w.reconcile()).body.skipped, undefined);
});

test('si la búsqueda de Mercado Pago falla, responde 502 y deja el estado anotado', async () => {
  const w = world();
  w.state.searchOk = false;
  const run = await w.reconcile();
  assert.equal(run.status, 502);
  const row = w.sqlite.prepare('SELECT scope,status,finished_at FROM payment_reconcile_runs').get();
  assert.equal(row.status, 'mp_search_failed');
  assert.equal(row.scope, `production:${COLLECTOR}`);
  assert.ok(row.finished_at);
});

test('la respuesta de la conciliación trae sólo cantidades', async () => {
  const w = world();
  const order = await w.order();
  w.payment(27, { transaction_amount: order.payable_total_uyu, external_reference: order.public_code });
  const run = await w.reconcile();
  const text = JSON.stringify(run.body);
  for (const leak of [order.public_code, 'Cliente', 'example.test', '099123456', 'token']) assert.equal(text.includes(leak), false);
  for (const value of Object.values(run.body)) assert.ok(['number', 'boolean', 'string'].includes(typeof value));
});

test('conciliación: sólo POST y host permitido; no depende de KV', async () => {
  const w = world();
  const handler = createPaymentsReconcileHandler({ mpClient: { searchRecentPayments: async () => ({ ok: true, results: [] }) } });
  const get = await handler({ request: new Request(HOST + '/api/payments/reconcile'), env: w.env });
  assert.equal(get.status, 405);
  const otherHost = await handler({ request: new Request('https://evil.example/api/payments/reconcile', { method: 'POST' }), env: w.env });
  assert.equal(otherHost.status, 400);
  const noKv = await handler({ request: new Request(HOST + '/api/payments/reconcile', { method: 'POST' }), env: { ...w.env, AMADO_KV: undefined } });
  assert.equal(noKv.status, 200);
  const again = await handler({ request: new Request(HOST + '/api/payments/reconcile', { method: 'POST' }), env: { ...w.env, AMADO_KV: undefined } });
  assert.equal((await again.json()).skipped, true);
});

// ── Hallazgos de la revisión del 25/11: simultaneidad y caída del freno ─────

const post = (handler, env) => handler({ request: new Request(HOST + '/api/payments/reconcile', { method: 'POST' }), env })
  .then(async r => ({ status: r.status, body: await r.json() }));

function slowSearch(state) {
  let calls = 0;
  return {
    calls: () => calls,
    searchRecentPayments: async (_token, { offset = 0, limit = 50 } = {}) => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 15));
      return { ok: true, results: state.search.slice(offset, offset + limit) };
    },
  };
}

test('llamados simultáneos: de cinco, corre uno solo y Mercado Pago se consulta una vez', async () => {
  const w = world();
  const mp = slowSearch(w.state);
  const handler = createPaymentsReconcileHandler({ mpClient: mp, getNow: () => w.state.now, notifyPending: async () => ({ sent: 0 }) });
  const runs = await Promise.all(Array.from({ length: 5 }, () => post(handler, w.env)));
  assert.equal(runs.filter(r => r.body.skipped === true).length, 4);
  assert.equal(runs.filter(r => r.body.skipped === undefined && r.status === 200).length, 1);
  assert.equal(mp.calls(), 1);
  assert.equal(w.sqlite.prepare('SELECT count(*) n FROM payment_reconcile_runs').get().n, 1);
});

test('llamados simultáneos con un pago por recuperar: el pedido se paga una vez y la venta se avisa una vez', async () => {
  const w = world();
  const order = await w.order();
  w.payment(81, { transaction_amount: order.payable_total_uyu, external_reference: order.public_code });
  w.state.search.push({ id: '81', status: 'approved', collector_id: COLLECTOR, external_reference: order.public_code });
  const runs = await Promise.all([w.reconcile(), w.reconcile(), w.reconcile()]);
  assert.equal(runs.reduce((sum, r) => sum + (r.body.aplicados || 0), 0), 1);
  assert.equal(runs.filter(r => r.body.skipped === true).length, 2);
  assert.equal(w.state.sales, 1);
  assert.equal(w.state.getPaymentCalls, 1);
  assert.equal(w.sqlite.prepare("SELECT count(*) n FROM order_events WHERE event_type='payment_reconciled'").get().n, 1);
});

test('KV caído o ausente no afloja el freno: el turno vive en la base', async () => {
  const w = world();
  const mp = slowSearch(w.state);
  const handler = createPaymentsReconcileHandler({ mpClient: mp, getNow: () => w.state.now, notifyPending: async () => ({ sent: 0 }) });
  const brokenKv = { get: async () => null, put: async () => { throw new Error('KV_WRITE_FAILURE'); } };
  for (const AMADO_KV of [brokenKv, { get: async () => { throw new Error('KV_READ_FAILURE'); }, put: async () => {} }, undefined]) {
    await post(handler, { ...w.env, AMADO_KV });
  }
  assert.equal(mp.calls(), 1);
});

test('si el turno no se puede tomar (base caída), responde 503 y no consulta a Mercado Pago', async () => {
  const w = world();
  const mp = slowSearch(w.state);
  const handler = createPaymentsReconcileHandler({ mpClient: mp, getNow: () => w.state.now, notifyPending: async () => ({ sent: 0 }) });
  const failingDb = { ...w.db, prepare: sql => (sql.includes('payment_reconcile_runs') ? { bind: () => ({ run: async () => { throw new Error('D1_ERROR'); } }) } : w.db.prepare(sql)) };
  for (let i = 0; i < 3; i++) {
    const run = await post(handler, { ...w.env, ORDERS_DB: failingDb });
    assert.equal(run.status, 503);
  }
  assert.equal(mp.calls(), 0);
});

test('si la base no confirma el turno (respuesta sin cantidad de filas), no se corre', async () => {
  const w = world();
  const mp = slowSearch(w.state);
  const handler = createPaymentsReconcileHandler({ mpClient: mp, getNow: () => w.state.now, notifyPending: async () => ({ sent: 0 }) });
  const vagueDb = { ...w.db, prepare: sql => (sql.includes('INSERT INTO payment_reconcile_runs') ? { bind: () => ({ run: async () => ({}) }) } : w.db.prepare(sql)) };
  const run = await post(handler, { ...w.env, ORDERS_DB: vagueDb });
  assert.equal(run.body.skipped, true);
  assert.equal(mp.calls(), 0);
});

test('una corrida en vista previa no le saca el turno a producción', async () => {
  const w = world();
  const mp = slowSearch(w.state);
  const handler = createPaymentsReconcileHandler({ mpClient: mp, getNow: () => w.state.now, notifyPending: async () => ({ sent: 0 }) });
  const previewEnv = { ...w.env, APP_ENV: 'preview', CANONICAL_ORIGIN: 'https://review.amadolibros-web.pages.dev', MP_COLLECTOR_ID: '200' };
  const preview = await handler({ request: new Request('https://review.amadolibros-web.pages.dev/api/payments/reconcile', { method: 'POST' }), env: previewEnv });
  assert.equal(preview.status, 200);
  const prod = await post(handler, w.env);
  assert.equal(prod.body.skipped, undefined);
  assert.equal(mp.calls(), 2);
  assert.deepEqual(w.sqlite.prepare('SELECT scope FROM payment_reconcile_runs ORDER BY scope').all().map(r => r.scope), ['preview:200', `production:${COLLECTOR}`]);
});

test('una corrida que quedó colgada libera el turno al pasar la ventana', async () => {
  const w = world();
  w.sqlite.prepare("INSERT INTO payment_reconcile_runs (scope,started_at,status) VALUES (?,?,'running')").run(`production:${COLLECTOR}`, w.state.now.toISOString());
  assert.equal((await w.reconcile()).body.skipped, true);
  w.later(5);
  assert.equal((await w.reconcile()).body.skipped, undefined);
});

// ── Piezas sueltas ──────────────────────────────────────────────────────────

test('needsProcessing: qué pagos no cierran con la base', () => {
  const approved = { id: '1', status: 'approved' };
  assert.equal(needsProcessing(approved, undefined), true);
  assert.equal(needsProcessing(approved, { payment_status: 'not_started', payment_id: null }), true);
  assert.equal(needsProcessing(approved, { payment_status: 'approved', payment_id: '1' }), false);
  assert.equal(needsProcessing(approved, { payment_status: 'approved', payment_id: '2' }), true);
  const refunded = { id: '1', status: 'refunded' };
  assert.equal(needsProcessing(refunded, undefined), false);
  assert.equal(needsProcessing(refunded, { payment_status: 'approved', payment_id: '1' }), true);
  assert.equal(needsProcessing(refunded, { payment_status: 'refunded', payment_id: '1' }), false);
  assert.equal(needsProcessing(refunded, { payment_status: 'approved', payment_id: '2' }), false);
});

test('isWebOrderReference: sólo códigos de pedido de la web', () => {
  assert.equal(isWebOrderReference('AL-261125-84ZPFQ'), true);
  assert.equal(isWebOrderReference('AL-TEST'), true);
  for (const value of [null, '', 'MLU123', 'al-261125-84zpfq', 'AL-', 'AL-' + 'X'.repeat(30)]) assert.equal(isWebOrderReference(value), false);
});

test('correo de incidente: sin datos del comprador', () => {
  const email = buildIncidentEmail({ reason: 'importe_distinto', payment_id: '99', public_code: 'AL-1', mp_status: 'approved', mp_amount_uyu: 1499, order_amount_uyu: 1500, source: 'conciliacion' });
  assert.match(email.subject, /AL-1/);
  assert.match(email.text, /\$1\.499/);
  assert.match(email.text, /conciliación automática/);
});

test('searchRecentPayments: arma la consulta documentada y acepta las dos formas de respuesta', async () => {
  const urls = [];
  const page = { paging: { total: 1, limit: 50, offset: 0 }, results: [{ id: 7, status: 'approved', collector_id: COLLECTOR, external_reference: 'AL-1', transaction_amount: '24.50' }] };
  const asArray = await searchRecentPayments('t', { fetch: async url => { urls.push(url); return new Response(JSON.stringify([page])); } });
  const asObject = await searchRecentPayments('t', { offset: 50, fetch: async url => { urls.push(url); return new Response(JSON.stringify(page)); } });
  assert.deepEqual(asArray.results, [{ id: '7', status: 'approved', collector_id: COLLECTOR, external_reference: 'AL-1' }]);
  assert.deepEqual(asObject.results, asArray.results);
  const q = new URL(urls[0]).searchParams;
  assert.deepEqual([q.get('sort'), q.get('criteria'), q.get('range'), q.get('begin_date'), q.get('end_date'), q.get('limit'), q.get('offset')],
    ['date_last_updated', 'desc', 'date_last_updated', 'NOW-2DAYS', 'NOW', '50', '0']);
  assert.equal(new URL(urls[1]).searchParams.get('offset'), '50');
  assert.equal((await searchRecentPayments('t', { fetch: async () => new Response('{}', { status: 401 }) })).ok, false);
  assert.equal((await searchRecentPayments('t', { fetch: async () => new Response('{"nada":1}') })).ok, false);
});
