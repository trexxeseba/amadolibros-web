import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTransferOptionsHandler,
  TRANSFER_ACCOUNTS,
} from '../_transfer_options_handler.js';

const NOW = new Date('2026-08-09T15:00:00.000Z');
const CONFIG = {
  APP_ENV: 'preview',
  MP_COLLECTOR_ID: '3559407834',
  CHECKOUT_ENABLED: 'true',
  CANONICAL_ORIGIN: 'https://feature.amadolibros-web.pages.dev',
};

function openOrder(patch = {}) {
  return {
    id: 'order-uuid',
    public_code: 'AL-260809-TEST',
    status: 'open',
    payment_status: 'not_started',
    expires_at: '2026-08-09T17:00:00.000Z',
    products_total_uyu: 2000,
    pickup_discount_uyu: 150,
    shipping_cost_uyu: 0,
    payable_total_uyu: 1850,
    currency: 'UYU',
    buyer_name: 'Ana Pérez',
    buyer_phone: '099123456',
    buyer_email: 'ana@example.com',
    delivery_type: 'pickup',
    address: null,
    locality: null,
    department: null,
    ...patch,
  };
}

function dbMock(order = openOrder(), { error = null } = {}) {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              if (error) throw error;
              return order;
            },
          };
        },
      };
    },
  };
}

function request(body = { public_code: 'AL-260809-TEST', idempotency_key: 'idem-1' }, patch = {}) {
  return new Request(`https://${patch.host || 'feature.amadolibros-web.pages.dev'}/api/transfer-options`, {
    method: patch.method || 'POST',
    headers: { 'Content-Type': patch.contentType || 'application/json' },
    body: (patch.method || 'POST') === 'GET' ? undefined :
      (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

async function call({ body, order, requestPatch, envPatch, dbOptions, orderEmails } = {}) {
  const handler = createTransferOptionsHandler({
    getNow: () => NOW,
    orderEmails: orderEmails || { sendTransferNotifications: async () => ({}) },
  });
  const response = await handler({
    request: request(body, requestPatch),
    env: { ...CONFIG, ORDERS_DB: dbMock(order === undefined ? openOrder() : order, dbOptions), ...envPatch },
  });
  let data;
  try { data = await response.json(); } catch { data = null; }
  return { response, data };
}

test('transfer: orden autenticada devuelve cinco caminos y BROU primero', async () => {
  const { response, data } = await call();
  assert.equal(response.status, 200);
  assert.equal(data.accounts.length, 5);
  assert.equal(data.accounts[0].id, 'brou');
  assert.equal(data.accounts[1].id, 'brou-cash');
  assert.equal(data.accounts[4].id, 'prex');
  assert.equal(data.accounts[4].account_number, '57211');
  assert.equal(Object.hasOwn(data.accounts[4], 'document_number'), false);
  assert.deepEqual(
    data.accounts.map(account => [account.id, account.holder, account.account_number]),
    [
      ['brou', 'Victor Lopez Molea', '00065582200001'],
      ['brou-cash', 'Victor Lopez Molea', '1960816881'],
      ['itau', 'Visconti Espinosa', '8969114'],
      ['oca-blue', 'Lopez Molea', '2373466'],
      ['prex', 'Lopez Molea', '57211'],
    ],
  );
});

test('transfer: 12% se aplica a libros, no al ahorro de retiro', async () => {
  const { data } = await call();
  assert.equal(data.payment.products_total_uyu, 2000);
  assert.equal(data.payment.transfer_products_total_uyu, 1760);
  assert.equal(data.payment.transfer_discount_uyu, 240);
  assert.equal(data.payment.transfer_total_uyu, 1610);
  assert.equal(data.payment.list_total_uyu, 1850);
});

test('transfer: agenda confirmación al cliente y aviso interno con el total exacto', async () => {
  const calls = [];
  const { response } = await call({
    orderEmails: {
      sendTransferNotifications: async args => { calls.push(args); return {}; },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].order.buyer_email, 'ana@example.com');
  assert.equal(calls[0].payment.method, 'bank_transfer');
  assert.equal(calls[0].payment.transfer_discount_uyu, 240);
  assert.equal(calls[0].payment.total_uyu, 1610);
});

test('transfer: costo de envío no recibe 12% de descuento', async () => {
  const { data } = await call({
    order: openOrder({
      products_total_uyu: 1000,
      pickup_discount_uyu: 0,
      shipping_cost_uyu: 250,
      payable_total_uyu: 1250,
    }),
  });
  assert.equal(data.payment.transfer_discount_uyu, 120);
  assert.equal(data.payment.transfer_total_uyu, 1130);
});

test('transfer: las cuentas no se entregan sin el par código + idempotency', async () => {
  assert.equal((await call({ body: { idempotency_key: 'idem-1' } })).response.status, 400);
  assert.equal((await call({ body: { public_code: 'AL-260809-TEST' } })).response.status, 400);
  assert.equal((await call({ order: null })).response.status, 404);
});

test('transfer: orden vencida o pagada no expone cuentas', async () => {
  assert.equal((await call({ order: openOrder({ expires_at: '2026-08-09T14:00:00.000Z' }) })).response.status, 410);
  assert.equal((await call({ order: openOrder({ status: 'paid', payment_status: 'approved' }) })).response.status, 409);
});

test('transfer: host ajeno y checkout apagado fallan cerrado', async () => {
  assert.equal((await call({ requestPatch: { host: 'evil.example.com' } })).response.status, 400);
  assert.equal((await call({ envPatch: { CHECKOUT_ENABLED: 'false' } })).response.status, 503);
});

test('transfer: respuestas son no-store y noindex', async () => {
  const { response } = await call();
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
});

test('transfer: sólo conserva las cuentas de destino; no devuelve bancos de origen ni enlaces', async () => {
  assert.equal(TRANSFER_ACCOUNTS.length, 5);
  const { data } = await call();
  assert.equal(Object.hasOwn(data, 'payer_channels'), false);
  assert.equal(JSON.stringify(data).includes('https://'), false);
});
