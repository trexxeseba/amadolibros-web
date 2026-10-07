// «Transferencia recibida»: la marca manual que separa un pedido pagado por
// transferencia de uno abandonado.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionToken, deriveSessionSecret } from '../_shared/panel-auth.js';
import {
  confirmTransfer,
  transferAmountFor,
  transferBlockedReason,
  transferEventId,
} from '../_shared/panel-transfer.js';
import { onRequest } from '../panel/[[path]].js';

const PASSWORD = 'contraseña-larga-del-panel';

function order(patch = {}) {
  return {
    id: 'order-1', public_code: 'AL-261001-ABC123', status: 'open', payment_status: 'not_started',
    buyer_name: 'Ana', buyer_email: 'ana@example.com', buyer_phone: '099 000 000',
    delivery_type: 'shipping', address: 'Calle 1', locality: 'Centro', department: 'Montevideo',
    products_total_uyu: 2000, pickup_discount_uyu: 0, shipping_cost_uyu: 250, payable_total_uyu: 2250,
    payment_provider: null, paid_amount_uyu: null, created_at: '2026-10-01T10:00:00.000Z',
    ...patch,
  };
}

function writableDb({ row = order(), changes = 1, fail = false } = {}) {
  const writes = [];
  let current = { ...row };
  return {
    writes,
    get current() { return current; },
    prepare(sql) {
      let bound = [];
      const st = {
        sql,
        bind: (...params) => { bound = params; st.params = params; return st; },
        all: async () => {
          if (sql.includes('FROM orders') && sql.includes('public_code = ?')) return { results: [current] };
          return { results: [] };
        },
      };
      return st;
    },
    async batch(statements) {
      if (fail) throw new Error('D1 caída');
      writes.push(...statements.map(st => ({ sql: st.sql, params: st.params })));
      if (changes > 0) {
        current = { ...current, status: 'paid', payment_status: 'approved', payment_provider: 'bank_transfer', paid_amount_uyu: statements[0].params[1] };
      }
      return statements.map(() => ({ meta: { changes } }));
    },
  };
}

test('el monto es el total con 12 % menos en libros; el envío queda igual', () => {
  assert.deepEqual(transferAmountFor(order()), { amount: 2010, discount: 240, listTotal: 2250 });
  // Retiro: el descuento por retiro se descuenta después del 12 %.
  const retiro = order({ delivery_type: 'pickup', shipping_cost_uyu: 0, pickup_discount_uyu: 150, payable_total_uyu: 1850 });
  assert.equal(transferAmountFor(retiro).amount, 1610);
});

test('se puede marcar un pedido abierto o vencido; nunca uno cobrado, devuelto o cancelado', () => {
  assert.equal(transferBlockedReason(order()), '');
  assert.equal(transferBlockedReason(order({ status: 'expired' })), '');
  assert.match(transferBlockedReason(order({ status: 'paid', payment_status: 'approved', payment_provider: 'mercadopago' })), /Mercado Pago/);
  assert.match(transferBlockedReason(order({ status: 'paid', payment_status: 'approved', payment_provider: 'bank_transfer' })), /Ya está marcado/);
  assert.match(transferBlockedReason(order({ payment_status: 'refunded' })), /devuelto/);
  assert.match(transferBlockedReason(order({ status: 'cancelled' })), /cancelado/);
});

test('marcar guarda pagado, medio, monto y fecha, y deja el evento con id fijo', async () => {
  const db = writableDb();
  const now = new Date('2026-10-02T15:00:00.000Z');
  const result = await confirmTransfer({ db, order: order({ status: 'expired' }), now });
  assert.equal(result.ok, true);
  assert.match(result.message, /2[.,]010/);

  const [update, insert] = db.writes;
  assert.match(update.sql, /UPDATE orders SET status='paid', payment_status='approved'/);
  // Las mismas condiciones que la regla: un pago de Mercado Pago que llegó
  // en el medio no se pisa.
  assert.match(update.sql, /status IN \('open','expired'\) AND payment_status NOT IN \('approved','refunded'\)/);
  assert.deepEqual(update.params, ['bank_transfer', 2010, now.toISOString(), now.toISOString(), 'order-1']);

  assert.match(insert.sql, /INSERT OR IGNORE INTO order_events/);
  assert.match(insert.sql, /'transfer_confirmed'/);
  assert.equal(insert.params[0], transferEventId('order-1'));
  const payload = JSON.parse(insert.params[2]);
  assert.deepEqual(payload, {
    method: 'bank_transfer', amount_uyu: 2010, transfer_discount_uyu: 240, list_total_uyu: 2250, previous_status: 'expired',
  });
});

test('si el pedido cambió entre la ficha y el clic, no dice que salió bien', async () => {
  const result = await confirmTransfer({ db: writableDb({ changes: 0 }), order: order() });
  assert.equal(result.ok, false);
  assert.match(result.message, /cambió/);
});

test('un pedido ya cobrado no escribe nada', async () => {
  const db = writableDb();
  const result = await confirmTransfer({ db, order: order({ status: 'paid', payment_status: 'approved', payment_provider: 'mercadopago' }) });
  assert.equal(result.ok, false);
  assert.equal(db.writes.length, 0);
});

test('si D1 falla avisa que no se guardó', async () => {
  const result = await confirmTransfer({ db: writableDb({ fail: true }), order: order() });
  assert.equal(result.ok, false);
  assert.match(result.message, /No se pudo guardar/);
});

// ── Desde el panel ──────────────────────────────────────────────────────────

function env(db) {
  return {
    APP_ENV: 'production',
    ALLOWED_HOSTS: 'amadolibros.com,www.amadolibros.com',
    PANEL_PASSWORD: PASSWORD,
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    STOCK_WAITLIST_TURNSTILE_SITE_KEY: '0x4AAAAAAD_sitekey',
    ORDERS_DB: db,
  };
}

async function cookie() {
  return `amado_panel_session=${await createSessionToken(await deriveSessionSecret(PASSWORD))}`;
}

function req(path, { method = 'GET', withCookie = '', origin = '' } = {}) {
  const headers = new Headers({ 'cf-connecting-ip': '203.0.113.9' });
  if (withCookie) headers.set('cookie', withCookie);
  if (origin) headers.set('origin', origin);
  return new Request(`https://www.amadolibros.com${path}`, { method, headers });
}

test('la ficha de un pedido pendiente ofrece el botón con el monto por transferencia', async () => {
  const response = await onRequest({ request: req('/panel/pedido/AL-261001-ABC123', { withCookie: await cookie() }), env: env(writableDb()) });
  const html = await response.text();
  assert.match(html, /¿Llegó la transferencia\?/);
  assert.match(html, /action="\/panel\/pedido\/AL-261001-ABC123\/transferencia"/);
  assert.match(html, /\$ 2[.,]010/);
});

test('la ficha de un pedido ya cobrado no ofrece el botón', async () => {
  const db = writableDb({ row: order({ status: 'paid', payment_status: 'approved', payment_provider: 'mercadopago' }) });
  const html = await (await onRequest({ request: req('/panel/pedido/AL-261001-ABC123', { withCookie: await cookie() }), env: env(db) })).text();
  assert.doesNotMatch(html, /\/transferencia"/);
});

test('el POST marca la transferencia y la ficha vuelve mostrando el cobro', async () => {
  const db = writableDb();
  const response = await onRequest({
    request: req('/panel/pedido/AL-261001-ABC123/transferencia', { method: 'POST', withCookie: await cookie(), origin: 'https://www.amadolibros.com' }),
    env: env(db),
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /marcada como recibida/);
  assert.equal(db.current.payment_status, 'approved');
  assert.doesNotMatch(html, /¿Llegó la transferencia\?/);
});

test('sin sesión, desde otro sitio o con GET no se marca nada', async () => {
  const sinSesion = writableDb();
  await onRequest({ request: req('/panel/pedido/AL-261001-ABC123/transferencia', { method: 'POST' }), env: env(sinSesion) });
  assert.equal(sinSesion.writes.length, 0);

  const otroSitio = writableDb();
  const forbidden = await onRequest({
    request: req('/panel/pedido/AL-261001-ABC123/transferencia', { method: 'POST', withCookie: await cookie(), origin: 'https://evil.example' }),
    env: env(otroSitio),
  });
  assert.equal(forbidden.status, 403);
  assert.equal(otroSitio.writes.length, 0);

  const get = await onRequest({ request: req('/panel/pedido/AL-261001-ABC123/transferencia', { withCookie: await cookie() }), env: env(writableDb()) });
  assert.equal(get.status, 405);
});
