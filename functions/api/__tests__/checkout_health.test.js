import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCheckoutHealthHandler } from '../_checkout_health_handler.js';

const COLLECTOR = 440298103;
const NOW = new Date('2026-11-25T18:00:00Z');

function dbMock({ failOn = null } = {}) {
  const seen = [];
  return {
    seen,
    prepare(sql) {
      seen.push(sql);
      return { async first() { if (failOn && sql.includes(failOn)) throw new Error('no such table'); return null; } };
    },
  };
}

function kvMock(initial = {}) {
  const store = new Map(Object.entries(initial));
  return { store, async get(key) { return store.get(key) ?? null; }, async put(key, value) { store.set(key, value); } };
}

function envOk(overrides = {}) {
  return {
    APP_ENV: 'production',
    MP_COLLECTOR_ID: String(COLLECTOR),
    CANONICAL_ORIGIN: 'https://www.amadolibros.com',
    ALLOWED_HOSTS: 'amadolibros.com,www.amadolibros.com',
    CHECKOUT_ENABLED: 'true',
    MP_ACCESS_TOKEN: 'APP_USR-secreto-de-prueba',
    MP_WEBHOOK_SECRET: 'secreto-webhook',
    TURNSTILE_SECRET_KEY: 'secreto-turnstile',
    RESEND_API_KEY: 're_secreto',
    SALES_NOTIFICATION_FROM: 'Amado <web@example.test>',
    SALES_NOTIFICATION_TO: 'equipo@example.test',
    ORDERS_DB: dbMock(),
    AMADO_KV: kvMock(),
    ...overrides,
  };
}

function mpFetch({ status = 200, id = COLLECTOR, throws = false } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, auth: opts?.headers?.Authorization });
    if (throws) throw new Error('network');
    return new Response(JSON.stringify({ id, nickname: 'NO-DEBE-SALIR', email: 'no-debe-salir@example.test' }), { status });
  };
  fn.calls = calls;
  return fn;
}

async function run({ env = envOk(), fetchFn = mpFetch(), catalog = { items: [{ id: 'MLU1' }] }, method = 'GET' } = {}) {
  const handler = createCheckoutHealthHandler({ fetchCatalog: async () => catalog, fetchFn, getNow: () => NOW });
  const response = await handler({ request: new Request('https://www.amadolibros.com/api/checkout-health', { method }), env });
  const text = await response.text();
  return { response, text, body: text ? JSON.parse(text) : null, fetchFn, env };
}

test('health-01: todo en pie → 200 ok, sin caché', async () => {
  const { response, body } = await run();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(Object.values(body.checks), Array(8).fill('ok'));
});

test('health-02: la respuesta no expone claves, casillas ni datos de la cuenta', async () => {
  const { text } = await run();
  for (const leak of ['APP_USR', 'secreto', 're_', 'example.test', 'NO-DEBE-SALIR', String(COLLECTOR)]) {
    assert.equal(text.includes(leak), false, `no debe aparecer: ${leak}`);
  }
});

test('health-03: cobros apagados → 503 y nombra la pieza', async () => {
  const { response, body } = await run({ env: envOk({ CHECKOUT_ENABLED: 'false' }) });
  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.checks.cobros_encendidos, 'falla');
  assert.equal(body.checks.configuracion, 'ok');
});

test('health-04: configuración inválida → 503 y no se consulta Mercado Pago', async () => {
  const fetchFn = mpFetch();
  const { response, body } = await run({ env: envOk({ APP_ENV: 'otro' }), fetchFn });
  assert.equal(response.status, 503);
  assert.equal(body.checks.configuracion, 'falla');
  assert.equal(body.checks.mercado_pago, 'falla');
  assert.equal(fetchFn.calls.length, 0);
});

test('health-05: base de pedidos ausente o sin una tabla → 503', async () => {
  const missing = await run({ env: envOk({ ORDERS_DB: undefined }) });
  assert.equal(missing.response.status, 503);
  assert.equal(missing.body.checks.base_de_pedidos, 'falla');
  const broken = await run({ env: envOk({ ORDERS_DB: dbMock({ failOn: 'order_events' }) }) });
  assert.equal(broken.body.checks.base_de_pedidos, 'falla');
});

test('health-06: la base sólo se lee', async () => {
  const env = envOk();
  await run({ env });
  assert.equal(env.ORDERS_DB.seen.length, 3);
  for (const sql of env.ORDERS_DB.seen) assert.match(sql, /^SELECT 1 FROM (orders|order_items|order_events) LIMIT 1$/);
});

test('health-07: catálogo ilegible o vacío → 503', async () => {
  assert.equal((await run({ catalog: null })).body.checks.catalogo, 'falla');
  assert.equal((await run({ catalog: { items: [] } })).body.checks.catalogo, 'falla');
});

test('health-08: credencial de Mercado Pago vencida (401) → 503', async () => {
  const { response, body } = await run({ fetchFn: mpFetch({ status: 401 }) });
  assert.equal(response.status, 503);
  assert.equal(body.checks.mercado_pago, 'falla');
});

test('health-09: credencial de otra cuenta → 503', async () => {
  const { body } = await run({ fetchFn: mpFetch({ id: 999 }) });
  assert.equal(body.checks.mercado_pago, 'falla');
});

test('health-10: Mercado Pago no responde → 503', async () => {
  const { body } = await run({ fetchFn: mpFetch({ throws: true }) });
  assert.equal(body.checks.mercado_pago, 'falla');
});

test('health-11: falta la credencial → 503 sin llamar a Mercado Pago', async () => {
  const fetchFn = mpFetch();
  const { body } = await run({ env: envOk({ MP_ACCESS_TOKEN: '' }), fetchFn });
  assert.equal(body.checks.mercado_pago, 'falla');
  assert.equal(fetchFn.calls.length, 0);
});

test('health-12: faltan claves de avisos, anti-robots o correo → 503 por pieza', async () => {
  assert.equal((await run({ env: envOk({ MP_WEBHOOK_SECRET: undefined }) })).body.checks.clave_de_avisos_de_pago, 'falla');
  assert.equal((await run({ env: envOk({ TURNSTILE_SECRET_KEY: ' ' }) })).body.checks.verificacion_anti_robots, 'falla');
  assert.equal((await run({ env: envOk({ RESEND_API_KEY: undefined }) })).body.checks.correo_de_avisos, 'falla');
});

test('health-13: un resultado bueno de Mercado Pago se reutiliza 5 minutos', async () => {
  const env = envOk();
  const first = mpFetch();
  await run({ env, fetchFn: first });
  assert.equal(first.calls.length, 1);
  const second = mpFetch({ status: 500 });
  const { body } = await run({ env, fetchFn: second });
  assert.equal(second.calls.length, 0);
  assert.equal(body.checks.mercado_pago, 'ok');
});

test('health-14: una falla de Mercado Pago no se guarda: la recuperación se ve en la corrida siguiente', async () => {
  const env = envOk();
  assert.equal((await run({ env, fetchFn: mpFetch({ status: 401 }) })).body.checks.mercado_pago, 'falla');
  assert.equal(env.AMADO_KV.store.size, 0);
  assert.equal((await run({ env, fetchFn: mpFetch() })).body.checks.mercado_pago, 'ok');
});

test('health-15: un resultado guardado vencido se vuelve a consultar', async () => {
  const old = new Date(NOW.getTime() - 6 * 60 * 1000).toISOString();
  const env = envOk({ AMADO_KV: kvMock({ 'checkout-health:mp:v1': JSON.stringify({ result: 'ok', at: old }) }) });
  const fetchFn = mpFetch({ status: 401 });
  const { body } = await run({ env, fetchFn });
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(body.checks.mercado_pago, 'falla');
});

test('health-16: sin KV funciona igual', async () => {
  const { response } = await run({ env: envOk({ AMADO_KV: undefined }) });
  assert.equal(response.status, 200);
});

test('health-17: POST → 405', async () => {
  const { response } = await run({ method: 'POST' });
  assert.equal(response.status, 405);
});
