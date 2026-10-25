import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { createSessionToken, deriveSessionSecret } from '../_shared/panel-auth.js';
import { applyOrderAction, availableActions, cleanCodes, MAX_BULK } from '../_shared/panel-order-actions.js';
import { loadOrdersList } from '../_shared/panel-data.js';
import { onRequest } from '../panel/[[path]].js';

// Pedidos inventados: el repo no lleva datos reales.
const PASSWORD = 'contraseña-larga-del-panel';
const NOW = new Date('2026-10-25T12:00:00.000Z');

function migration(name) {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

/** D1 sobre SQLite en memoria, con batch transaccional como el de D1. */
function d1(db) {
  const prepare = sql => {
    let args = [];
    const statement = {
      bind: (...values) => { args = values; return statement; },
      all: async () => ({ results: db.prepare(sql).all(...args) }),
      first: async () => db.prepare(sql).get(...args) ?? null,
      run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    };
    return statement;
  };
  return {
    prepare,
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const statement of statements) out.push(await statement.run());
        db.exec('COMMIT');
        return out;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

const CODES = {
  pagado: 'AL-260901-AAAAAA',
  despachado: 'AL-260902-BBBBBB',
  abierto: 'AL-260903-CCCCCC',
  cobradoAbierto: 'AL-260904-DDDDDD',
};

function seed() {
  const db = new DatabaseSync(':memory:');
  for (const name of ['0001_orders.sql', '0002_orders_shipping_date_montevideo.sql',
    '0005_orders_delivery_coordination.sql', '0006_orders_buyer_email.sql',
    '0008_orders_ga4_attribution.sql', '0010_orders_paid_amount.sql', '0014_orders_archived.sql']) {
    db.exec(migration(name));
  }
  const insert = db.prepare(`
    INSERT INTO orders (
      id, public_code, idempotency_key, request_fingerprint, status, payment_status,
      buyer_name, buyer_phone, delivery_type, address, locality, department,
      requested_delivery_date, requested_delivery_from, requested_delivery_to,
      products_total_uyu, pickup_discount_uyu, shipping_cost_uyu, payable_total_uyu,
      currency, created_at, expires_at, updated_at, paid_at, fulfilled_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const row = (id, code, status, payment, paidAt, fulfilledAt) => insert.run(
    id, code, `idem-${id}`, '{}', status, payment,
    'Cliente de prueba', '099000000', 'shipping', 'Calle 1', 'Centro', 'Montevideo',
    '2026-09-10', '10:00', '12:00', 1000, 0, 250, 1250, 'UYU',
    '2026-09-01T12:00:00.000Z', '2026-09-01T13:00:00.000Z', '2026-09-01T12:00:00.000Z', paidAt, fulfilledAt,
  );
  row('o1', CODES.pagado, 'paid', 'approved', '2026-09-01T12:05:00.000Z', null);
  row('o2', CODES.despachado, 'fulfilled', 'approved', '2026-09-01T12:05:00.000Z', '2026-09-02T10:00:00.000Z');
  row('o3', CODES.abierto, 'open', 'pending', null, null);
  // Un pago que entró pero el pedido quedó abierto: nunca se cancela desde el panel.
  row('o4', CODES.cobradoAbierto, 'open', 'approved', '2026-09-01T12:05:00.000Z', null);
  return db;
}

const estado = (db, code) => db.prepare('SELECT status, fulfilled_at, cancelled_at, archived_at FROM orders WHERE public_code = ?').get(code);
const eventos = (db, code) => db.prepare(
  'SELECT e.event_type FROM order_events e JOIN orders o ON o.id = e.order_id WHERE o.public_code = ? ORDER BY e.created_at',
).all(code).map(e => e.event_type);

test('despachar un pedido pagado lo marca despachado y deja el evento; repetirlo no hace nada', async () => {
  const db = seed();
  const primero = await applyOrderAction({ db: d1(db), action: 'despachar', codes: [CODES.pagado], now: NOW });
  assert.equal(primero.ok, true);
  assert.equal(primero.changed, 1);
  assert.equal(estado(db, CODES.pagado).status, 'fulfilled');
  assert.equal(estado(db, CODES.pagado).fulfilled_at, NOW.toISOString());
  assert.deepEqual(eventos(db, CODES.pagado), ['panel_fulfilled']);

  const segundo = await applyOrderAction({ db: d1(db), action: 'despachar', codes: [CODES.pagado], now: NOW });
  assert.equal(segundo.ok, false);
  assert.deepEqual(eventos(db, CODES.pagado), ['panel_fulfilled'], 'sin evento duplicado');
});

test('deshacer vuelve un despachado a pagado sin despachar', async () => {
  const db = seed();
  const result = await applyOrderAction({ db: d1(db), action: 'deshacer', codes: [CODES.despachado], now: NOW });
  assert.equal(result.ok, true);
  assert.deepEqual({ ...estado(db, CODES.despachado) }, { status: 'paid', fulfilled_at: null, cancelled_at: null, archived_at: null });
});

test('cancelar sólo toca pedidos sin cobrar; uno con pago aprobado queda igual', async () => {
  const db = seed();
  const result = await applyOrderAction({ db: d1(db), action: 'cancelar', codes: [CODES.abierto, CODES.cobradoAbierto, CODES.pagado], now: NOW });
  assert.equal(result.changed, 1);
  assert.equal(result.skipped, 2);
  assert.equal(estado(db, CODES.abierto).status, 'cancelled');
  assert.equal(estado(db, CODES.cobradoAbierto).status, 'open');
  assert.equal(estado(db, CODES.pagado).status, 'paid');
  assert.deepEqual(eventos(db, CODES.cobradoAbierto), []);
});

test('archivar saca el pedido de las listas sin borrarlo, y desarchivar lo devuelve', async () => {
  const db = seed();
  await applyOrderAction({ db: d1(db), action: 'archivar', codes: [CODES.pagado], now: NOW });
  const porDespachar = await loadOrdersList(d1(db), 'por-despachar');
  assert.equal(porDespachar.rows.length, 0);
  assert.equal(porDespachar.counts.archivados, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 4, 'no se borró nada');

  await applyOrderAction({ db: d1(db), action: 'desarchivar', codes: [CODES.pagado], now: NOW });
  assert.equal((await loadOrdersList(d1(db), 'por-despachar')).rows.length, 1);
});

test('las acciones ofrecidas dependen del estado del pedido', () => {
  assert.deepEqual(availableActions({ status: 'paid', payment_status: 'approved', fulfilled_at: null }), ['despachar', 'archivar']);
  assert.deepEqual(availableActions({ status: 'fulfilled', payment_status: 'approved' }), ['deshacer', 'archivar']);
  assert.deepEqual(availableActions({ status: 'open', payment_status: 'pending' }), ['cancelar', 'archivar']);
  assert.deepEqual(availableActions({ status: 'open', payment_status: 'approved' }), ['archivar']);
  assert.deepEqual(availableActions({ status: 'cancelled', payment_status: 'pending', archived_at: 'x' }), ['desarchivar']);
});

test('los códigos se limpian: inválidos fuera, sin repetir y con tope', () => {
  assert.deepEqual(cleanCodes([' al-260901-aaaaaa ', 'AL-260901-AAAAAA', "x'; DROP", '']), ['AL-260901-AAAAAA']);
  const muchos = Array.from({ length: MAX_BULK + 10 }, (_, i) => `AL-260901-A${String(i).padStart(5, '0')}`);
  assert.equal(cleanCodes(muchos).length, MAX_BULK);
});

async function cookie() {
  return `amado_panel_session=${await createSessionToken(await deriveSessionSecret(PASSWORD))}`;
}

function env(db) {
  return { APP_ENV: 'test', PANEL_PASSWORD: PASSWORD, TURNSTILE_SECRET_KEY: 'x', STOCK_WAITLIST_TURNSTILE_SITE_KEY: 'x', ORDERS_DB: d1(db) };
}

function post(path, fields, headers = {}) {
  const body = new URLSearchParams();
  for (const [key, value] of fields) body.append(key, value);
  return new Request(`https://www.amadolibros.com${path}`, { method: 'POST', headers, body });
}

test('la ficha muestra los botones arriba y el POST desde el tablero despacha y vuelve', async () => {
  const db = seed();
  const ficha = await (await onRequest({
    request: new Request(`https://www.amadolibros.com/panel/pedido/${CODES.pagado}`, { headers: { cookie: await cookie() } }),
    env: env(db),
  })).text();
  assert.match(ficha, /class="acciones-pedido"/);
  assert.match(ficha, /Marcar como despachado/);
  assert.ok(ficha.indexOf('acciones-pedido') < ficha.indexOf('Qué va en la caja'), 'las acciones van arriba');

  const response = await onRequest({
    request: post(`/panel/pedido/${CODES.pagado}/accion`, [['accion', 'despachar'], ['volver', 'tablero']],
      { cookie: await cookie(), origin: 'https://www.amadolibros.com' }),
    env: env(db),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/panel#pendientes');
  assert.equal(estado(db, CODES.pagado).status, 'fulfilled');
});

test('lista de pedidos: pestañas con cantidades y acción en lote sobre los tildados', async () => {
  const db = seed();
  const html = await (await onRequest({
    request: new Request('https://www.amadolibros.com/panel/pedidos?estado=sin-pagar', { headers: { cookie: await cookie() } }),
    env: env(db),
  })).text();
  assert.match(html, /Por despachar<b>1<\/b>/);
  // El abierto con pago aprobado no cuenta como «sin pagar».
  assert.match(html, /Sin pagar<b>1<\/b>/);
  assert.match(html, new RegExp(`value="${CODES.abierto}"`));

  const lote = await onRequest({
    request: post('/panel/pedidos', [['estado', 'todos'], ['accion', 'archivar'], ['codigo', CODES.pagado], ['codigo', CODES.despachado]],
      { cookie: await cookie(), origin: 'https://www.amadolibros.com' }),
    env: env(db),
  });
  assert.equal(lote.status, 200);
  assert.match(await lote.text(), /2 pedidos archivados/);
  assert.ok(estado(db, CODES.pagado).archived_at);
  assert.ok(estado(db, CODES.despachado).archived_at);
});

test('sin sesión o desde otro sitio no se cambia ningún pedido', async () => {
  const db = seed();
  await onRequest({ request: post(`/panel/pedido/${CODES.pagado}/accion`, [['accion', 'despachar']]), env: env(db) });
  const ajeno = await onRequest({
    request: post('/panel/pedidos', [['accion', 'archivar'], ['codigo', CODES.pagado]], { cookie: await cookie(), origin: 'https://otro.example' }),
    env: env(db),
  });
  assert.equal(ajeno.status, 403);
  assert.deepEqual({ ...estado(db, CODES.pagado) }, { status: 'paid', fulfilled_at: null, cancelled_at: null, archived_at: null });
});
