// Reservas de stock entre compradores de la web.
//
// Corre el alta de pedidos y la validación del carrito reales contra el
// esquema real de la base (todas las migraciones sobre SQLite en memoria).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHmac } from 'node:crypto';
import { createMpWebhookHandler } from '../_mp_webhook_handler.js';
import { buildSaleEmail } from '../_sale_notification.js';
import { readdirSync, readFileSync } from 'node:fs';
import { createOrdersHandler } from '../_orders_handler.js';
import { createCartValidationHandler } from '../_cart_validation_handler.js';
import { heldMessage, ownPaymentMessage, stockWindows, reduceAvailability, PENDING_HOLD_HOURS } from '../../_shared/stock-reservations.js';
import { createPreferenceHandler } from '../_mp_handler.js';
import { confirmTransfer, transferBlockedReason } from '../../_shared/panel-transfer.js';

const HOST = 'https://www.amadolibros.com';
const MIGRATIONS = new URL('../../../migrations/', import.meta.url);
const ANA = { name: 'Ana', phone: '099111111', email: 'ana@example.test' };
const BRUNO = { name: 'Bruno', phone: '099222222', email: 'bruno@example.test' };

function world({ stock = 1, realClock = false, preferenceGate = null } = {}) {
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
  const state = {
    expireOk: true, expired: [], created: 0,
    // El link de pago usa el reloj real: las pruebas que lo piden también.
    now: realClock ? new Date() : new Date('2026-11-25T15:00:00Z'),
    catalog: { updated_at: realClock ? new Date(Date.now() - 8 * 3600000).toISOString() : '2026-11-25T07:20:55Z', items: [
      { id: 'MLU1', title: 'El libro único', price: 2350, available_quantity: stock, status: 'active', currency_id: 'UYU' },
      { id: 'MLU2', title: 'Otro libro', price: 1250, available_quantity: 5, status: 'active', currency_id: 'UYU' },
    ] },
  };
  const env = {
    APP_ENV: 'production', MP_COLLECTOR_ID: '440298103', CANONICAL_ORIGIN: HOST,
    ALLOWED_HOSTS: 'amadolibros.com,www.amadolibros.com', CHECKOUT_ENABLED: 'true',
    TURNSTILE_SECRET_KEY: 'x', ORDERS_DB: db, MP_ACCESS_TOKEN: 'token', MP_WEBHOOK_SECRET: 'secreto',
  };
  const expire = async prefId => {
    if (state.expireOk === 'throw') throw new Error('network');
    if (!state.expireOk) return { ok: false, code: 'MP_API_ERROR' };
    state.expired.push(prefId);
    return { ok: true };
  };
  // Doble de Mercado Pago para el link de pago: un link vencido deja de servir.
  const preferences = createPreferenceHandler({
    mpClient: {
      createPreference: async () => { if (preferenceGate) await preferenceGate(); state.created++; return { ok: true, id: 'pref-' + state.created, checkout_url: 'https://mp.example/pref-' + state.created }; },
      getPreference: async id => (state.expired.includes(id) ? { ok: false, code: 'MP_API_ERROR' } : { ok: true, id, checkout_url: 'https://mp.example/' + id }),
      searchPreferenceByRef: async () => ({ ok: false, code: 'NOT_FOUND' }),
    },
  });
  const orders = createOrdersHandler({ fetchCatalog: async () => state.catalog, getNow: () => state.now, verifyTurnstileToken: async () => ({ ok: true }), expirePreference: expire });
  const validate = createCartValidationHandler({ fetchCatalog: async () => state.catalog, getNow: () => state.now });
  const post = async (handler, path, body) => {
    const response = await handler({ request: new Request(HOST + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env });
    return { status: response.status, body: await response.json() };
  };
  return {
    sqlite, state, env, db,
    payLink: (code, key) => post(preferences, '/api/mp/preferences', { public_code: code, idempotency_key: key }),
    row: code => sqlite.prepare('SELECT * FROM orders WHERE public_code=?').get(code),
    open: () => sqlite.prepare("SELECT public_code FROM orders WHERE status='open' ORDER BY created_at, public_code").all().map(r => r.public_code),
    openUnits: (product = 'MLU1') => sqlite.prepare(
      "SELECT COALESCE(SUM(oi.quantity),0) n FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=? AND o.status IN ('open','paid')").get(product).n,
    events: type => sqlite.prepare('SELECT order_id, payload_json FROM order_events WHERE event_type=?').all(type),
    order: (buyer, { quantity = 1, product = 'MLU1', delivery = 'pickup', key = randomUUID() } = {}) => post(orders, '/api/orders', {
      idempotency_key: key, items: [{ product_id: product, quantity }], delivery_type: delivery,
      pickup_ack: delivery === 'pickup' ? true : undefined, buyer, cf_turnstile_response: 't',
      shipping: delivery === 'shipping' ? { address: 'Calle 1', locality: 'Montevideo', department: 'Montevideo' } : undefined,
    }),
    cart: (quantity = 1, product = 'MLU1') => post(validate, '/api/cart/validate', { items: [{ product_id: product, quantity, unit_price_uyu: 2350 }] }),
    later(minutes) { state.now = new Date(state.now.getTime() + minutes * 60000); },
    set(code, fields) {
      const keys = Object.keys(fields);
      sqlite.prepare(`UPDATE orders SET ${keys.map(k => k + '=?').join(',')} WHERE public_code=?`).run(...keys.map(k => fields[k]), code);
    },
    count: () => sqlite.prepare('SELECT COUNT(*) n FROM orders').get().n,
    guards: () => sqlite.prepare("SELECT COUNT(*) n FROM order_events WHERE event_type='stock_guard'").get().n,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function approve(w, code) {
  const row = w.row(code), paymentId = '700001', requestId = 'audit-request', ts = '1800000000';
  const message = `id:${paymentId};request-id:${requestId};ts:${ts};`;
  const sig = createHmac('sha256', w.env.MP_WEBHOOK_SECRET).update(message).digest('hex');
  const notifications = [];
  const handler = createMpWebhookHandler({
    getNow: () => w.state.now,
    mpClient: {
      getPayment: async () => ({ ok:true, id:paymentId, status:'approved', live_mode:true,
        collector_id:Number(w.env.MP_COLLECTOR_ID), currency_id:'UYU',
        transaction_amount:row.payable_total_uyu, external_reference:code,
        date_approved:w.state.now.toISOString(), order_id:null }),
      getMerchantOrder: async () => { throw new Error('UNEXPECTED_CALL'); },
    },
    saleNotifier: async payload => { notifications.push(buildSaleEmail({ ...payload, items:[] })); return {ok:true}; },
    orderEmails: {sendPaidCustomer:async()=>({ok:true})},
    purchaseAnalytics: {sendPurchase:async()=>({ok:true})},
    metaPurchase: {sendPurchase:async()=>({ok:true})},
  });
  const response = await handler({env:w.env,request:new Request(HOST+'/api/webhooks/mercadopago?data.id='+paymentId,{
    method:'POST',headers:{'Content-Type':'application/json','x-request-id':requestId,'x-signature':`ts=${ts},v1=${sig}`},
    body:JSON.stringify({type:'payment',data:{id:paymentId}}),
  })});
  return {response,notifications};
}

test('audit: reemplazar mientras se crea el enlace no libera el ejemplar ni genera otro pedido', async () => {
  const entered=deferred(), release=deferred();
  const w=world({realClock:true,preferenceGate:async()=>{entered.resolve();await release.promise;}});
  const key=randomUUID();
  const first=await w.order(ANA,{key});
  const paying=w.payLink(first.body.order.public_code,key);
  await entered.promise;
  const replacement=await w.order(ANA);
  release.resolve();
  const link=await paying;
  assert.equal(replacement.status,409);
  assert.equal(replacement.body.code,'OWN_PAYMENT_IN_PROGRESS');
  assert.equal(link.status,200);
  assert.equal(w.count(),1);
  assert.equal(w.row(first.body.order.public_code).status,'open');
  assert.equal(w.state.created,1);
});

test('audit: un pago posterior a la cancelación sigue descontando stock pasada una hora', async () => {
  const w=world();
  const first=await w.order(ANA), code=first.body.order.public_code;
  w.set(code,{status:'cancelled',cancelled_at:w.state.now.toISOString()});
  const paid=await approve(w,code);
  assert.equal(paid.response.status,200);
  assert.equal(w.row(code).payment_status,'approved');
  assert.equal((await w.cart()).body.items[0].status,'sin_stock');
  w.later(61);
  assert.equal((await w.order(BRUNO)).status,422);
});

test('audit: el pago tardío queda registrado como excepción y el aviso interno pide revisar el stock', async () => {
  const w=world();
  const first=await w.order(ANA), code=first.body.order.public_code;
  w.set(code,{status:'cancelled',cancelled_at:w.state.now.toISOString()});
  const paid=await approve(w,code);
  assert.equal(w.events('payment_after_cancellation').length,1);
  assert.equal(w.row(code).cancelled_at,null);
  assert.match(paid.notifications[0].text,/cancelado.*revisar.*stock/i);
  await approve(w,code);
  assert.equal(w.events('payment_after_cancellation').length,1);
});

test('audit: los pagos históricos con cancelled_at residual también cuentan como vendidos', async () => {
  const w=world();
  const first=await w.order(ANA), code=first.body.order.public_code;
  w.set(code,{status:'paid',payment_status:'approved',cancelled_at:w.state.now.toISOString(),paid_at:w.state.now.toISOString()});
  assert.equal((await w.cart()).body.items[0].status,'sin_stock');
  assert.equal((await w.order(BRUNO)).status,422);
});

test('audit: la condición atómica protege un enlace que empieza después de revisar el stock', async () => {
  const entered=deferred(), release=deferred();
  const w=world({realClock:true,preferenceGate:async()=>{entered.resolve();await release.promise;}});
  const key=randomUUID(), first=await w.order(ANA,{key});
  const batch=w.db.batch;
  let started=false, paying;
  w.db.batch=async statements=>{
    if (!started && statements.some(s=>s.sql.startsWith('INSERT INTO orders '))) {
      started=true;
      paying=w.payLink(first.body.order.public_code,key);
      await entered.promise;
    }
    return batch(statements);
  };
  const replacement=await w.order(ANA);
  release.resolve();
  assert.equal(started,true);
  assert.equal(replacement.status,409);
  assert.equal(replacement.body.code,'OWN_PAYMENT_IN_PROGRESS');
  assert.equal((await paying).status,200);
  assert.equal(w.count(),1);
  assert.equal(w.row(first.body.order.public_code).status,'open');
});

test('audit: un pedido cancelado durante la llamada a Mercado Pago no entrega el enlace al terminar', async () => {
  const entered=deferred(), release=deferred();
  const w=world({realClock:true,preferenceGate:async()=>{entered.resolve();await release.promise;}});
  const key=randomUUID(), first=await w.order(ANA,{key}), code=first.body.order.public_code;
  const paying=w.payLink(code,key);
  await entered.promise;
  w.set(code,{status:'cancelled',cancelled_at:w.state.now.toISOString()});
  release.resolve();
  const result=await paying;
  assert.equal(result.status,410);
  assert.equal(result.body.code,'ORDER_CANCELLED');
  assert.equal(result.body.checkout_url,undefined);
  assert.ok(w.row(code).payment_preference_id.startsWith('creating:'));
});
