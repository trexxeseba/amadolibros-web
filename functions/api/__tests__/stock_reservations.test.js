// Reservas de stock entre compradores de la web.
//
// Corre el alta de pedidos y la validación del carrito reales contra el
// esquema real de la base (todas las migraciones sobre SQLite en memoria).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createOrdersHandler } from '../_orders_handler.js';
import { createCartValidationHandler } from '../_cart_validation_handler.js';
import { heldMessage, ownPaymentMessage, stockWindows, reduceAvailability, PENDING_HOLD_HOURS } from '../../_shared/stock-reservations.js';
import { createPreferenceHandler } from '../_mp_handler.js';
import { createMpWebhookHandler } from '../_mp_webhook_handler.js';
import { createHmac } from 'node:crypto';
import { confirmTransfer, transferBlockedReason } from '../../_shared/panel-transfer.js';

const HOST = 'https://www.amadolibros.com';
const MIGRATIONS = new URL('../../../migrations/', import.meta.url);
const ANA = { name: 'Ana', phone: '099111111', email: 'ana@example.test' };
const BRUNO = { name: 'Bruno', phone: '099222222', email: 'bruno@example.test' };

function world({ stock = 1, realClock = false } = {}) {
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
    created: 0, gate: null,
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
  // Doble de Mercado Pago para el link de pago: un link vencido deja de servir.
  const preferences = createPreferenceHandler({
    mpClient: {
      createPreference: async () => {
        state.created++;
        const id = 'pref-' + state.created;
        if (state.gate) await state.gate;
        return { ok: true, id, checkout_url: 'https://mp.example/' + id };
      },
      getPreference: async id => ({ ok: true, id, checkout_url: 'https://mp.example/' + id }),
      searchPreferenceByRef: async () => ({ ok: false, code: 'NOT_FOUND' }),
    },
  });
  const orders = createOrdersHandler({ fetchCatalog: async () => state.catalog, getNow: () => state.now, verifyTurnstileToken: async () => ({ ok: true }) });
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
    // Frena la creación del link en Mercado Pago hasta llamar a release().
    hold() {
      let release;
      state.gate = new Promise(resolve => { release = resolve; });
      return () => { state.gate = null; release(); };
    },
    async untilGenerating(code) {
      for (let i = 0; i < 200; i++) {
        if (String(sqlite.prepare('SELECT payment_preference_id p FROM orders WHERE public_code=?').get(code)?.p || '').startsWith('creating:')) return;
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      throw new Error('el link no empezó a generarse');
    },
    later(minutes) { state.now = new Date(state.now.getTime() + minutes * 60000); },
    set(code, fields) {
      const keys = Object.keys(fields);
      sqlite.prepare(`UPDATE orders SET ${keys.map(k => k + '=?').join(',')} WHERE public_code=?`).run(...keys.map(k => fields[k]), code);
    },
    count: () => sqlite.prepare('SELECT COUNT(*) n FROM orders').get().n,
    guards: () => sqlite.prepare("SELECT COUNT(*) n FROM order_events WHERE event_type='stock_guard'").get().n,
  };
}

test('último ejemplar: mientras una persona lo está pagando, otra no puede iniciar el mismo pedido', async () => {
  const w = world();
  const first = await w.order(ANA);
  assert.equal(first.status, 201);
  const second = await w.order(BRUNO);
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'STOCK_HELD');
  assert.match(second.body.error, /otra persona está completando la compra de «El libro único»/);
  assert.equal(w.count(), 1, 'no queda un pedido a medias del segundo comprador');
});

test('una reserva no se muestra como agotado: el carrito sigue viendo el libro', async () => {
  const w = world();
  await w.order(ANA);
  const cart = await w.cart();
  assert.equal(cart.body.items[0].status, 'ok');
  assert.equal(cart.body.has_blocking_items, false);
});

test('si el primer comprador no paga, a la hora el ejemplar vuelve a estar disponible', async () => {
  const w = world();
  await w.order(ANA);
  w.later(59);
  assert.equal((await w.order(BRUNO)).status, 409);
  w.later(2);
  assert.equal((await w.order(BRUNO)).status, 201);
});

test('pagado por la web después de la sincronización: figura agotado en el carrito y en el alta', async () => {
  const w = world();
  const first = await w.order(ANA);
  w.set(first.body.order.public_code, { status: 'paid', payment_status: 'approved', paid_at: w.state.now.toISOString() });
  w.later(180);
  const cart = await w.cart();
  assert.equal(cart.body.items[0].status, 'sin_stock');
  assert.equal(cart.body.has_blocking_items, true);
  const second = await w.order(BRUNO);
  assert.equal(second.status, 422);
  assert.equal(second.body.code, 'CART_CHANGED');
  assert.equal(second.body.issues[0].status, 'sin_stock');
});

test('cuando el catálogo se vuelve a sincronizar, manda el stock del catálogo', async () => {
  const w = world({ stock: 2 });
  const first = await w.order(ANA);
  w.set(first.body.order.public_code, { status: 'paid', payment_status: 'approved', paid_at: w.state.now.toISOString() });
  assert.equal((await w.cart(2)).body.items[0].status, 'cantidad_ajustada');
  // Sincronización del día siguiente: el catálogo ya trae lo que quedó en Mercado Libre.
  w.later(14 * 60);
  w.state.catalog = { ...w.state.catalog, updated_at: w.state.now.toISOString() };
  w.later(30);
  assert.equal((await w.cart(2)).body.items[0].status, 'ok');
});

test('una venta pagada minutos antes de terminar la sincronización se sigue descontando', async () => {
  const w = world();
  const first = await w.order(ANA);
  // Pagada 5 minutos antes de la hora que informa el catálogo nuevo.
  const paidAt = w.state.now;
  w.set(first.body.order.public_code, { status: 'paid', payment_status: 'approved', paid_at: paidAt.toISOString() });
  w.state.catalog = { ...w.state.catalog, updated_at: new Date(paidAt.getTime() + 5 * 60000).toISOString() };
  w.later(30);
  assert.equal((await w.cart()).body.items[0].status, 'sin_stock');
});

test('la misma persona puede rehacer su pedido: el nuevo reemplaza al anterior', async () => {
  const w = world();
  const first = await w.order(ANA, { delivery: 'pickup' });
  assert.equal(first.status, 201);
  // Cambia a envío: el navegador genera otra llave y otro pedido.
  const second = await w.order(ANA, { delivery: 'shipping' });
  assert.equal(second.status, 201);
  assert.deepEqual(w.open(), [second.body.order.public_code]);
  assert.equal(w.row(first.body.order.public_code).status, 'cancelled');
  // Otra persona sigue frenada.
  assert.equal((await w.order(BRUNO)).status, 409);
});

test('misma persona: alcanza con que coincida el correo o el teléfono', async () => {
  const samePhone = world();
  await samePhone.order(ANA);
  assert.equal((await samePhone.order({ ...ANA, email: 'otro@example.test' })).status, 201);
  const sameEmail = world();
  await sameEmail.order(ANA);
  assert.equal((await sameEmail.order({ ...ANA, phone: '099333333' })).status, 201);
  const neither = world();
  await neither.order(ANA);
  assert.equal((await neither.order({ ...ANA, email: 'otro@example.test', phone: '099333333' })).status, 409);
});

test('cantidades: se frena lo que supera el stock libre, no todo el libro', async () => {
  const w = world({ stock: 3 });
  assert.equal((await w.order(ANA, { quantity: 2 })).status, 201);
  assert.equal((await w.order(BRUNO, { quantity: 2 })).status, 409);
  assert.equal((await w.order(BRUNO, { quantity: 1 })).status, 201);
});

test('pago pendiente (Abitab, RedPagos): el ejemplar queda tomado aunque el pedido haya vencido', async () => {
  const w = world();
  const first = await w.order(ANA);
  w.set(first.body.order.public_code, { payment_status: 'pending', updated_at: w.state.now.toISOString() });
  w.later(5 * 60);
  assert.equal((await w.cart()).body.items[0].status, 'sin_stock');
  assert.equal((await w.order(BRUNO)).status, 422);
  w.later(PENDING_HOLD_HOURS * 60);
  assert.equal((await w.cart()).body.items[0].status, 'ok');
});

test('pedidos cancelados, rechazados vencidos o devueltos no toman stock', async () => {
  for (const fields of [
    { status: 'cancelled' },
    { cancelled_at: '2026-11-25T15:01:00Z' },
    { status: 'paid', payment_status: 'refunded', paid_at: '2026-11-25T15:01:00Z' },
  ]) {
    const w = world();
    const first = await w.order(ANA);
    w.set(first.body.order.public_code, fields);
    assert.equal((await w.order(BRUNO)).status, 201, JSON.stringify(fields));
  }
});

test('pago rechazado: la reserva sigue hasta que vence el pedido, para que pueda reintentar', async () => {
  const w = world();
  const first = await w.order(ANA);
  w.set(first.body.order.public_code, { payment_status: 'rejected' });
  assert.equal((await w.order(BRUNO)).status, 409);
  w.later(61);
  assert.equal((await w.order(BRUNO)).status, 201);
});

test('dos altas simultáneas del último ejemplar: el candado deja pasar una sola', async () => {
  const w = world();
  const [a, b] = await Promise.all([w.order(ANA), w.order(BRUNO)]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal(w.count(), 1);
  assert.equal(w.guards(), 0, 'el candado nunca deja una fila propia');
  const loser = a.status === 409 ? a : b;
  assert.equal(loser.body.code, 'STOCK_HELD');
});

test('el candado actúa aunque la lectura previa de reservas falle', async () => {
  const w = world();
  await w.order(ANA);
  const db = w.env.ORDERS_DB;
  const original = db.prepare;
  // La consulta previa (la que agrupa por producto) falla; el lote de alta no.
  db.prepare = sql => (sql.includes('GROUP BY oi.product_id') ? { bind: () => ({ all: async () => { throw new Error('D1'); } }) } : original(sql));
  const originalError = console.error; console.error = () => {};
  try {
    const second = await w.order(BRUNO);
    assert.notEqual(second.status, 201);
    assert.equal(w.count(), 1);
  } finally { db.prepare = original; console.error = originalError; }
});

test('las reservas no cambian importes: mismo total con y sin otros pedidos', async () => {
  const alone = world({ stock: 5 });
  const a = await alone.order(BRUNO, { delivery: 'shipping' });
  const busy = world({ stock: 5 });
  await busy.order(ANA, { quantity: 2 });
  const b = await busy.order(BRUNO, { delivery: 'shipping' });
  for (const field of ['products_total_uyu', 'pickup_discount_uyu', 'shipping_cost_uyu', 'payable_total_uyu']) {
    assert.equal(a.body.order[field], b.body.order[field], field);
  }
  assert.equal(b.body.order.payable_total_uyu, 2350);
});

test('otros libros del catálogo no se ven afectados', async () => {
  const w = world();
  await w.order(ANA);
  assert.equal((await w.order(BRUNO, { product: 'MLU2' })).status, 201);
});

test('el carrito sin base de pedidos valida contra el catálogo, como antes', async () => {
  const w = world();
  const first = await w.order(ANA);
  w.set(first.body.order.public_code, { status: 'paid', payment_status: 'approved', paid_at: w.state.now.toISOString() });
  delete w.env.ORDERS_DB;
  assert.equal((await w.cart()).body.items[0].status, 'ok');
});

test('ventanas: sin fecha de catálogo se asume el peor caso', () => {
  const now = new Date('2026-11-25T15:00:00Z');
  assert.equal(stockWindows({ now, catalogUpdatedAt: '2026-11-25T07:20:00Z' }).soldSince, '2026-11-25T07:05:00.000Z');
  assert.equal(stockWindows({ now, catalogUpdatedAt: undefined }).soldSince, '2026-11-24T13:00:00.000Z');
  assert.equal(stockWindows({ now, catalogUpdatedAt: '2027-01-01T00:00:00Z' }).soldSince, '2026-11-24T13:00:00.000Z');
});

test('reduceAvailability no modifica el catálogo original ni baja de cero', () => {
  const items = [{ id: 'A', available_quantity: 1 }, { id: 'B', available_quantity: 4 }];
  const reduced = reduceAvailability(items, new Map([['A', 3]]));
  assert.equal(reduced[0].available_quantity, 0);
  assert.equal(items[0].available_quantity, 1);
  assert.equal(reduced[1], items[1]);
});

test('mensaje al cliente: en positivo, sin emojis ni "sólo" o "únicamente"', () => {
  for (const message of [heldMessage(['Uno']), heldMessage(['Uno', 'Dos', 'Tres']), heldMessage([])]) {
    assert.equal(/\p{Extended_Pictographic}/u.test(message), false);
    assert.equal(/s[oó]lo|únicamente/i.test(message), false);
    assert.match(message, /vuelve a estar disponible/);
  }
  assert.match(heldMessage(['Uno', 'Dos', 'Tres']), /«Uno», «Dos» y «Tres»/);
});

// ── Hallazgo de la revisión del 25/11: dos pedidos de la misma persona ───────
//
// Antes: la misma persona podía tener dos pedidos abiertos por el último
// ejemplar, y los dos se podían cobrar.

const key = () => randomUUID();

test('misma persona, último ejemplar: nunca quedan dos pedidos abiertos', async () => {
  const w = world();
  const first = await w.order(ANA);
  const second = await w.order(ANA);
  const third = await w.order(ANA);
  assert.deepEqual([first.status, second.status, third.status], [201, 201, 201]);
  assert.deepEqual(w.open(), [third.body.order.public_code]);
  assert.equal(w.openUnits(), 1);
  const replaced = w.events('superseded');
  assert.equal(replaced.length, 2);
});

test('misma persona, último ejemplar: el pedido reemplazado no puede pedir link de pago', async () => {
  const w = world({ realClock: true });
  const k1 = key();
  const first = await w.order(ANA, { key: k1 });
  const k2 = key();
  const second = await w.order(ANA, { key: k2 });
  const oldLink = await w.payLink(first.body.order.public_code, k1);
  assert.equal(oldLink.status, 410);
  assert.equal(oldLink.body.code, 'ORDER_CANCELLED');
  assert.equal((await w.payLink(second.body.order.public_code, k2)).status, 200);
  assert.equal(w.state.created, 1);
});

test('misma persona con link de pago ya creado: no se cancela el pedido anterior y el nuevo no se crea', async () => {
  const w = world({ realClock: true });
  const k1 = key();
  const first = await w.order(ANA, { key: k1 });
  const link = await w.payLink(first.body.order.public_code, k1);
  assert.equal(link.status, 200);
  const second = await w.order(ANA);
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'OWN_PAYMENT_IN_PROGRESS');
  assert.equal(w.count(), 1);
  assert.deepEqual(w.open(), [first.body.order.public_code]);
  assert.equal(w.events('superseded').length, 0);
  // El pedido anterior sigue pagable, con el mismo link, y no se creó otro.
  const again = await w.payLink(first.body.order.public_code, k1);
  assert.deepEqual([again.status, again.body.checkout_url], [200, link.body.checkout_url]);
  assert.equal(w.state.created, 1);
});

test('misma persona con el link en generación: no se cancela el pedido anterior', async () => {
  const w = world();
  const first = await w.order(ANA);
  w.set(first.body.order.public_code, { payment_preference_id: 'creating:1700000000:x' });
  const second = await w.order(ANA);
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'OWN_PAYMENT_IN_PROGRESS');
  assert.equal(w.row(first.body.order.public_code).status, 'open');
  assert.equal(w.count(), 1);
});

// Fallo reproducido por la revisión: mientras se genera el link del pedido
// viejo, el nuevo lo cancelaba; después la operación anterior terminaba y
// devolvía igualmente su link. Quedaban dos links para un ejemplar.
test('mientras se genera el link del pedido viejo, el pedido nuevo no lo cancela y no quedan dos links', async () => {
  const w = world({ realClock: true });
  const k1 = key();
  const first = await w.order(ANA, { key: k1 });
  const release = w.hold();
  const generating = w.payLink(first.body.order.public_code, k1);
  await w.untilGenerating(first.body.order.public_code);
  const second = await w.order(ANA);
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'OWN_PAYMENT_IN_PROGRESS');
  assert.equal(w.row(first.body.order.public_code).status, 'open');
  release();
  const link = await generating;
  assert.equal(link.status, 200);
  assert.deepEqual(w.open(), [first.body.order.public_code]);
  assert.equal(w.state.created, 1);
  assert.equal(w.openUnits(), 1);
});

test('si cancelan el pedido mientras se genera su link, el link no se entrega ni se guarda', async () => {
  const w = world({ realClock: true });
  const k1 = key();
  const first = await w.order(ANA, { key: k1 });
  const release = w.hold();
  const generating = w.payLink(first.body.order.public_code, k1);
  await w.untilGenerating(first.body.order.public_code);
  // Cualquier otra vía que cancele el pedido (por ejemplo desde el panel).
  w.set(first.body.order.public_code, { status: 'cancelled', cancelled_at: w.state.now.toISOString() });
  release();
  const link = await generating;
  assert.equal(link.status, 410);
  assert.equal(link.body.code, 'ORDER_CANCELLED');
  assert.equal(link.body.checkout_url, undefined);
  assert.equal(w.row(first.body.order.public_code).payment_preference_id?.startsWith('creating:'), true);
  assert.equal(w.events('preference_created').length, 0);
});

test('pedido nuevo y link del anterior en el mismo instante: nunca hay link y pedido nuevo a la vez', async () => {
  for (let i = 0; i < 25; i++) {
    const w = world({ realClock: true });
    const k1 = key();
    const first = await w.order(ANA, { key: k1 });
    const release = w.hold();
    const [link, second] = await Promise.all([
      w.payLink(first.body.order.public_code, k1),
      (async () => { for (let n = 0; n < i % 4; n++) await Promise.resolve(); const r = await w.order(ANA); release(); return r; })(),
    ]);
    release();
    assert.equal(link.status === 200 && second.status === 201, false, `iteración ${i}: dos cobros posibles`);
    assert.equal(w.openUnits(), 1, `iteración ${i}: stock comprometido`);
    const withLink = w.sqlite.prepare("SELECT COUNT(*) n FROM orders WHERE status='open' AND payment_preference_id LIKE 'pref-%'").get().n;
    assert.ok(withLink <= 1);
  }
});

test('el link empieza a generarse justo entre la lectura y el alta: el lote no cancela el pedido anterior', async () => {
  const w = world({ realClock: true });
  const first = await w.order(ANA);
  const realBatch = w.db.batch;
  let injected = false;
  w.db.batch = async list => {
    if (!injected) {
      injected = true;
      w.set(first.body.order.public_code, { payment_preference_id: 'creating:1700000000:x' });
    }
    return realBatch(list);
  };
  const second = await w.order(ANA);
  w.db.batch = realBatch;
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'OWN_PAYMENT_IN_PROGRESS');
  assert.equal(w.row(first.body.order.public_code).status, 'open');
  assert.equal(w.count(), 1);
  assert.equal(w.events('superseded').length, 0);
});

test('con dos pedidos propios, sólo se reemplaza el que no tiene nada en marcha', async () => {
  const w = world({ stock: 2, realClock: true });
  const k1 = key();
  const paying = await w.order(ANA, { key: k1 });
  await w.payLink(paying.body.order.public_code, k1);
  const idle = await w.order(ANA);
  assert.equal(idle.status, 201);
  assert.equal(w.open().length, 2);
  // Pide una unidad más: 3 contra 2 de stock. Se reemplaza el que no tiene link.
  const next = await w.order(ANA);
  assert.equal(next.status, 201);
  assert.equal(w.row(paying.body.order.public_code).status, 'open');
  assert.equal(w.row(idle.body.order.public_code).status, 'cancelled');
  assert.equal(w.openUnits(), 2);
});

test('el pedido anterior con link vence solo a la hora y entonces el pedido nuevo entra', async () => {
  const w = world();
  const first = await w.order(ANA);
  w.set(first.body.order.public_code, { payment_preference_id: 'pref-1' });
  assert.equal((await w.order(ANA)).status, 409);
  w.later(61);
  const second = await w.order(ANA);
  assert.equal(second.status, 201);
});

test('misma persona en el mismo instante por el último ejemplar: queda un solo pedido abierto', async () => {
  const w = world();
  const results = await Promise.all([w.order(ANA), w.order(ANA), w.order(ANA, { delivery: 'shipping' })]);
  assert.ok(results.every(r => r.status === 201 || r.status === 409 || r.status === 422));
  assert.equal(w.open().length, 1);
  assert.equal(w.openUnits(), 1);
});

test('si el stock alcanza para los dos pedidos de la misma persona, no se reemplaza nada', async () => {
  const w = world({ stock: 2, realClock: true });
  const k1 = key();
  const first = await w.order(ANA, { key: k1 });
  await w.payLink(first.body.order.public_code, k1);
  const second = await w.order(ANA);
  assert.equal(second.status, 201);
  assert.equal(w.open().length, 2);
  assert.equal(w.events('superseded').length, 0);
  // El tercero: 3 unidades contra 2 de stock. El primero tiene link y no se
  // cancela; el segundo, sin nada en marcha, es el que se reemplaza.
  const third = await w.order(ANA);
  assert.equal(third.status, 201);
  assert.equal(w.openUnits(), 2);
  assert.equal(w.row(first.body.order.public_code).status, 'open');
});

test('el candado cuenta los pedidos de la misma persona: 2 unidades propias y 1 ajena con stock 2', async () => {
  const w = world({ stock: 2 });
  assert.equal((await w.order(ANA)).status, 201);
  assert.equal((await w.order(BRUNO)).status, 201);
  // Ana pide otra: reemplaza su pedido anterior, no le saca la unidad a Bruno.
  const again = await w.order(ANA);
  assert.equal(again.status, 201);
  assert.equal(w.openUnits(), 2);
  // Si Ana pide 2, no alcanza: la unidad de Bruno está reservada.
  assert.equal((await w.order(ANA, { quantity: 2 })).status, 409);
  assert.equal(w.openUnits(), 2);
});

test('un pedido propio con pago pendiente en un local de cobranza no se reemplaza: el libro figura agotado', async () => {
  const w = world();
  const first = await w.order(ANA);
  w.set(first.body.order.public_code, { payment_status: 'pending', updated_at: w.state.now.toISOString() });
  const second = await w.order(ANA);
  assert.equal(second.status, 422);
  assert.equal(w.row(first.body.order.public_code).status, 'open');
  assert.equal(w.count(), 1);
});

test('un pedido propio ya pagado no se reemplaza ni se cancela', async () => {
  const w = world();
  const first = await w.order(ANA);
  w.set(first.body.order.public_code, { status: 'paid', payment_status: 'approved', paid_at: w.state.now.toISOString() });
  assert.equal((await w.order(ANA)).status, 422);
  assert.equal(w.row(first.body.order.public_code).status, 'paid');
});

test('el pedido reemplazado no se puede confirmar por transferencia', async () => {
  const w = world();
  const first = await w.order(ANA);
  await w.order(ANA);
  const old = w.row(first.body.order.public_code);
  assert.equal(transferBlockedReason(old), 'El pedido está cancelado.');
  const result = await confirmTransfer({ db: w.db, order: old, now: w.state.now }).catch(error => ({ ok: false, error }));
  assert.notEqual(w.row(first.body.order.public_code).status, 'paid');
  assert.ok(result);
});

test('si el alta nueva falla, el pedido anterior sin nada en marcha queda abierto', async () => {
  const w = world({ realClock: true });
  const k1 = key();
  const first = await w.order(ANA, { key: k1 });
  const realBatch = w.db.batch;
  w.db.batch = async () => { throw new Error('D1_ERROR'); };
  const second = await w.order(ANA);
  w.db.batch = realBatch;
  assert.equal(second.status, 500);
  assert.deepEqual(w.open(), [first.body.order.public_code]);
  assert.equal((await w.payLink(first.body.order.public_code, k1)).status, 200);
});

test('reemplazar pedidos propios no toca importes ni pedidos de otras personas', async () => {
  const w = world({ stock: 2 });
  const bruno = await w.order(BRUNO);
  const first = await w.order(ANA);
  const before = w.row(bruno.body.order.public_code);
  const second = await w.order(ANA, { quantity: 1 });
  assert.equal(second.status, 201);
  assert.deepEqual(w.row(bruno.body.order.public_code), before);
  assert.equal(second.body.order.payable_total_uyu, first.body.order.payable_total_uyu);
});

test('mensaje de pago propio en curso: en positivo, sin emojis ni "sólo" o "únicamente"', () => {
  const message = ownPaymentMessage();
  assert.equal(/\p{Extended_Pictographic}/u.test(message), false);
  assert.equal(/s[oó]lo|únicamente/i.test(message), false);
  assert.match(message, /WhatsApp/);
  assert.match(message, /pedido en curso/);
});

// ── Pago recibido y escenarios de cobro (sin Mercado Pago real) ─────────────
// Usa el webhook real contra la base real; solo se simula la respuesta de la
// API de Mercado Pago (getPayment) y los envíos de correo.
function webhookWorld(w, amount, { status = 'approved', paymentId = '9001', dateApproved = '2026-11-25T15:01:00Z' } = {}) {
  const mail = { sale: 0, customer: 0, ga4: 0 };
  const handler = createMpWebhookHandler({
    mpClient: {
      getPayment: async () => ({ ok: true, id: paymentId, status, collector_id: 440298103, currency_id: 'UYU', transaction_amount: amount, external_reference: w.currentCode, live_mode: true, date_approved: dateApproved }),
      getMerchantOrder: async () => ({ ok: false }),
    },
    getNow: () => w.state.now,
    saleNotifier: async () => { mail.sale++; return { sent: 1 }; },
    orderEmails: { sendPaidCustomer: async () => { mail.customer++; return { sent: 1 }; } },
    purchaseAnalytics: { sendPurchase: async ({ order }) => { mail.ga4++; mail.paidAt = order.paid_at; return { sent: 1 }; } },
    metaPurchase: { sendPurchase: async () => ({ sent: 0 }) },
  });
  const send = async () => {
    const ts = '1700000000', rid = 'req-' + Math.random();
    const v1 = createHmac('sha256', w.env.MP_WEBHOOK_SECRET).update('id:' + paymentId + ';request-id:' + rid + ';ts:' + ts + ';').digest('hex');
    const request = new Request(HOST + '/api/webhooks/mercadopago?data.id=' + paymentId + '&type=payment', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': 'ts=' + ts + ',v1=' + v1, 'x-request-id': rid }, body: JSON.stringify({ type: 'payment', action: 'payment.updated', data: { id: paymentId } }) });
    return (await handler({ request, env: w.env })).status;
  };
  return { send, mail };
}

test('pago aprobado después de que el pedido fue cancelado: queda pagado una sola vez, con su importe y sin duplicados', async () => {
  const w = world({ realClock: true });
  const k = key();
  const first = await w.order(ANA, { key: k });
  const code = first.body.order.public_code;
  w.currentCode = code;
  assert.equal((await w.payLink(code, k)).status, 200);
  w.set(code, { status: 'cancelled', cancelled_at: w.state.now.toISOString() });
  const amount = w.row(code).payable_total_uyu;
  const { send, mail } = webhookWorld(w, amount);
  // Mercado Pago reintenta y puede entregar el mismo aviso varias veces a la vez.
  const statuses = await Promise.all([send(), send(), send(), send(), send()]);
  assert.deepEqual([...new Set(statuses)], [200]);
  const row = w.row(code);
  assert.equal(row.payment_status, 'approved');
  assert.equal(row.status, 'paid');
  assert.equal(row.paid_amount_uyu, amount);
  assert.equal(row.payment_id, '9001');
  assert.equal(w.events('payment_approved').length, 1);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM order_events WHERE event_type='ga4_purchase'").get().n, 1);
});

test('pago con importe distinto al del pedido: se ignora y el pedido no queda pagado', async () => {
  const w = world({ realClock: true });
  const k = key();
  const first = await w.order(ANA, { key: k });
  const code = first.body.order.public_code;
  w.currentCode = code;
  const { send } = webhookWorld(w, w.row(code).payable_total_uyu - 1);
  assert.equal(await send(), 200);
  assert.notEqual(w.row(code).status, 'paid');
  assert.equal(w.events('payment_approved').length, 0);
});

test('doble clic en pagar: un solo link y un solo pedido; el pago lo deja pagado una vez', async () => {
  const w = world({ realClock: true });
  const k = key();
  const first = await w.order(ANA, { key: k });
  const code = first.body.order.public_code;
  w.currentCode = code;
  const [a, b, c] = await Promise.all([w.payLink(code, k), w.payLink(code, k), w.payLink(code, k)]);
  // Uno obtiene el link; los otros reciben 'ya se está generando' y pueden reintentar.
  assert.deepEqual([a.status, b.status, c.status].sort(), [200, 409, 409]);
  assert.equal(w.state.created, 1);
  const retry = await w.payLink(code, k);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.checkout_url, [a, b, c].find(r => r.status === 200).body.checkout_url);
  assert.equal(w.state.created, 1);
  assert.equal(w.count(), 1);
  const { send } = webhookWorld(w, w.row(code).payable_total_uyu);
  assert.equal(await send(), 200);
  assert.equal(w.row(code).status, 'paid');
  assert.equal(w.openUnits(), 1); // el pedido pagado sigue comprometiendo su unidad
});

// Mercado Pago devuelve date_approved con zona horaria; las ventanas del
// catálogo se expresan en UTC. Comparar esos textos pierde ventas recientes.
test('zona horaria: un pago histórico con -04:00 descuenta el último ejemplar', async () => {
  const w = world();
  const first = await w.order(ANA);
  w.set(first.body.order.public_code, {
    status: 'paid', payment_status: 'approved', paid_at: '2026-11-25T11:00:00.000-04:00',
  });
  w.state.catalog.updated_at = '2026-11-25T15:05:00.000Z';
  w.later(30);
  assert.equal((await w.cart()).body.items[0].status, 'sin_stock');
  assert.equal((await w.order(BRUNO)).status, 422);
  assert.equal(w.count(), 1);
});

test('zona horaria: un pago anterior a la ventana no descuenta stock por su hora local', async () => {
  const w = world();
  const first = await w.order(ANA);
  w.set(first.body.order.public_code, {
    status: 'paid', payment_status: 'approved', paid_at: '2026-11-25T16:30:00.000+02:00',
  });
  // El pago fue a las 14:30 UTC: queda fuera del margen de 15 minutos.
  w.state.catalog.updated_at = '2026-11-25T15:00:00.000Z';
  w.later(30);
  assert.equal((await w.cart()).body.items[0].status, 'ok');
  assert.equal((await w.order(BRUNO)).status, 201);
});

test('zona horaria: el candado cuenta un pago con offset que llega entre la lectura y el alta', async () => {
  const w = world();
  const first = await w.order(ANA);
  w.set(first.body.order.public_code, { status: 'cancelled' });
  w.state.catalog.updated_at = '2026-11-25T15:05:00.000Z';
  w.later(30);
  const realBatch = w.db.batch;
  let injected = false;
  w.db.batch = async list => {
    if (!injected) {
      injected = true;
      w.set(first.body.order.public_code, {
        status: 'paid', payment_status: 'approved', paid_at: '2026-11-25T11:01:00.000-04:00',
      });
    }
    return realBatch(list);
  };
  const second = await w.order(BRUNO);
  assert.equal(injected, true);
  assert.equal(second.status, 422);
  assert.equal(second.body.code, 'CART_CHANGED');
  assert.equal(w.count(), 1);
  assert.equal(w.guards(), 0);
});

test('zona horaria: webhook guarda el pago en UTC y mantiene el último ejemplar descontado', async () => {
  const w = world();
  const first = await w.order(ANA);
  w.currentCode = first.body.order.public_code;
  w.state.catalog.updated_at = '2026-11-25T15:05:00.000Z';
  w.later(30);
  const { send, mail } = webhookWorld(w, w.row(w.currentCode).payable_total_uyu, {
    dateApproved: '2026-11-25T11:01:00.000-04:00',
  });
  assert.equal(await send(), 200);
  assert.equal(w.row(w.currentCode).paid_at, '2026-11-25T15:01:00.000Z');
  assert.equal(mail.paidAt, '2026-11-25T15:01:00.000Z');
  assert.equal((await w.cart()).body.items[0].status, 'sin_stock');
  assert.equal((await w.order(BRUNO)).status, 422);
});

for (const dateApproved of [null, 'fecha-invalida']) {
  test('zona horaria: fecha de aprobación ' + String(dateApproved) + ' usa la hora de recepción', async () => {
    const w = world();
    const first = await w.order(ANA);
    w.currentCode = first.body.order.public_code;
    const { send, mail } = webhookWorld(w, w.row(w.currentCode).payable_total_uyu, { dateApproved });
    assert.equal(await send(), 200);
    assert.equal(w.row(w.currentCode).paid_at, w.state.now.toISOString());
    assert.equal(mail.paidAt, w.state.now.toISOString());
    assert.equal((await w.cart()).body.items[0].status, 'sin_stock');
  });
}
