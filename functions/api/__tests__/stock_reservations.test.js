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
import { heldMessage, stockWindows, reduceAvailability, PENDING_HOLD_HOURS } from '../../_shared/stock-reservations.js';

const HOST = 'https://www.amadolibros.com';
const MIGRATIONS = new URL('../../../migrations/', import.meta.url);
const ANA = { name: 'Ana', phone: '099111111', email: 'ana@example.test' };
const BRUNO = { name: 'Bruno', phone: '099222222', email: 'bruno@example.test' };

function world({ stock = 1 } = {}) {
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
    now: new Date('2026-11-25T15:00:00Z'),
    catalog: { updated_at: '2026-11-25T07:20:55Z', items: [
      { id: 'MLU1', title: 'El libro único', price: 2350, available_quantity: stock, status: 'active', currency_id: 'UYU' },
      { id: 'MLU2', title: 'Otro libro', price: 1250, available_quantity: 5, status: 'active', currency_id: 'UYU' },
    ] },
  };
  const env = {
    APP_ENV: 'production', MP_COLLECTOR_ID: '440298103', CANONICAL_ORIGIN: HOST,
    ALLOWED_HOSTS: 'amadolibros.com,www.amadolibros.com', CHECKOUT_ENABLED: 'true',
    TURNSTILE_SECRET_KEY: 'x', ORDERS_DB: db,
  };
  const orders = createOrdersHandler({ fetchCatalog: async () => state.catalog, getNow: () => state.now, verifyTurnstileToken: async () => ({ ok: true }) });
  const validate = createCartValidationHandler({ fetchCatalog: async () => state.catalog, getNow: () => state.now });
  const post = async (handler, path, body) => {
    const response = await handler({ request: new Request(HOST + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env });
    return { status: response.status, body: await response.json() };
  };
  return {
    sqlite, state, env,
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

test('la misma persona puede rehacer su pedido: su pedido anterior no la bloquea', async () => {
  const w = world();
  assert.equal((await w.order(ANA, { delivery: 'pickup' })).status, 201);
  // Cambia a envío: el navegador genera otra llave y otro pedido.
  assert.equal((await w.order(ANA, { delivery: 'shipping' })).status, 201);
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
