import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../email-test.js';

const TOKEN = '25f663d775d5cc680fbc4e4002d09a8e3523caf32188cba1';

function request(method, token = TOKEN) {
  if (method === 'GET') {
    return new Request(`https://www.amadolibros.com/api/email-test?token=${token}`, { method });
  }
  return new Request('https://www.amadolibros.com/api/email-test', {
    method,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  });
}

function env(overrides = {}) {
  return {
    APP_ENV: 'production',
    RESEND_API_KEY: 're_test_secret',
    SALES_NOTIFICATION_FROM: 'Amado Libros <web@notificaciones.amadolibros.com>',
    SALES_NOTIFICATION_TO: 'uno@example.com,dos@example.com',
    ...overrides,
  };
}

test('email-test-1: token inválido responde 404 y no envía', async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; };
  try {
    const result = await onRequest({ request: request('GET', '0'.repeat(48)), env: env() });
    assert.equal(result.status, 404);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('email-test-2: preview queda bloqueado aunque el token sea válido', async () => {
  const result = await onRequest({
    request: request('GET'),
    env: env({ APP_ENV: 'preview' }),
  });
  assert.equal(result.status, 404);
});

test('email-test-3: GET válido muestra confirmación y no envía', async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; };
  try {
    const result = await onRequest({ request: request('GET'), env: env() });
    const body = await result.text();
    assert.equal(result.status, 200);
    assert.match(body, /Enviar prueba/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('email-test-4: POST envía sólo a los destinatarios configurados', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ id: 'email-test-id' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const guardedEnv = new Proxy(env(), {
      get(target, property) {
        assert.notEqual(property, 'ORDERS_DB');
        assert.notEqual(property, 'MP_ACCESS_TOKEN');
        assert.notEqual(property, 'MP_WEBHOOK_SECRET');
        return target[property];
      },
    });
    const result = await onRequest({ request: request('POST'), env: guardedEnv });
    assert.equal(result.status, 200);
    assert.equal(calls.length, 1);
    const payload = JSON.parse(calls[0].options.body);
    assert.deepEqual(payload.to, ['uno@example.com', 'dos@example.com']);
    assert.equal(payload.subject, 'PRUEBA — Notificación de venta web');
    assert.equal(calls[0].options.headers['Idempotency-Key'], 'safe-email-test/2026-07-30-v1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('email-test-5: método ajeno queda rechazado', async () => {
  const result = await onRequest({
    request: new Request('https://www.amadolibros.com/api/email-test', { method: 'DELETE' }),
    env: env(),
  });
  assert.equal(result.status, 405);
  assert.equal(result.headers.get('Allow'), 'GET, POST');
});

test('email-test-6: un fallo muestra sólo un código seguro, nunca secretos', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ message: 'invalid api key' }, { status: 401 });
  try {
    const result = await onRequest({ request: request('POST'), env: env() });
    const body = await result.text();
    assert.equal(result.status, 502);
    assert.equal(body, 'No se pudo enviar la prueba: RESEND_HTTP_401');
    assert.ok(!body.includes('re_test_secret'));
    assert.ok(!body.includes('uno@example.com'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
