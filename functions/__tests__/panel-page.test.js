import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionToken, deriveSessionSecret } from '../_shared/panel-auth.js';
import { onRequest } from '../panel/[[path]].js';

const PASSWORD = 'contraseña-larga-del-panel';

const ORDER_ROWS = [{
  public_code: 'AL-1001',
  status: 'paid',
  payment_status: 'approved',
  // Nombre hostil: lo escribe el comprador en el checkout y termina en el HTML.
  buyer_name: '<script>alert("xss")</script>',
  delivery_type: 'shipping',
  payable_total_uyu: 1990,
  created_at: '2026-09-07T10:00:00.000Z',
  paid_at: '2026-09-07T10:05:00.000Z',
  fulfilled_at: null,
}];

function dbStub() {
  const answer = sql => {
    if (sql.includes('FROM orders') && sql.includes('GROUP BY status')) {
      return [{ status: 'paid', total: 3 }];
    }
    if (sql.includes('ORDER BY created_at DESC')) return ORDER_ROWS;
    if (sql.includes("payment_status = 'approved' AND paid_at >=")) {
      return [{ total: 3, total_uyu: 5970 }];
    }
    if (sql.includes('fulfilled_at IS NULL')) return ORDER_ROWS;
    if (sql.includes('FROM stock_waitlist') && sql.includes('GROUP BY status')) {
      return [{ status: 'waiting', total: 2 }];
    }
    if (sql.includes('FROM crawl_stats')) {
      return [{ date: '2026-09-07', requests: 120, errors: 2, verified_googlebot: 100 }];
    }
    return [];
  };
  return {
    prepare(sql) {
      const statement = {
        bind: () => statement,
        all: async () => ({ results: answer(sql) }),
      };
      return statement;
    },
  };
}

function baseEnv(overrides = {}) {
  return {
    APP_ENV: 'production',
    ALLOWED_HOSTS: 'amadolibros.com,www.amadolibros.com',
    PANEL_PASSWORD: PASSWORD,
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    STOCK_WAITLIST_TURNSTILE_SITE_KEY: '0x4AAAAAAD_sitekey',
    ORDERS_DB: dbStub(),
    ...overrides,
  };
}

function request(path, { method = 'GET', cookie = '', body = null } = {}) {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  headers.set('cf-connecting-ip', '203.0.113.9');
  return new Request(`https://www.amadolibros.com${path}`, { method, headers, body });
}

function loginBody(password, token = 'turnstile-token') {
  const form = new URLSearchParams();
  form.set('password', password);
  form.set('cf-turnstile-response', token);
  return form;
}

async function withTurnstile(success, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    success,
    action: 'panel_login',
    hostname: 'www.amadolibros.com',
    'error-codes': success ? [] : ['invalid-input-response'],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function sessionCookie(password = PASSWORD) {
  const token = await createSessionToken(await deriveSessionSecret(password));
  return `amado_panel_session=${token}`;
}

test('sin contraseña configurada el panel responde 503 y no muestra ni el login', async () => {
  const response = await onRequest({
    request: request('/panel'),
    env: { APP_ENV: 'production' },
  });
  assert.equal(response.status, 503);
  const html = await response.text();
  assert.match(html, /Panel no disponible/);
  assert.doesNotMatch(html, /type="password"/);
});

test('sin sesión, /panel muestra el login y ningún dato del negocio', async () => {
  const response = await onRequest({ request: request('/panel'), env: baseEnv() });
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /type="password"/);
  assert.match(html, /data-action="panel_login"/);
  // Nada de pedidos, compradores ni totales antes de autenticarse.
  assert.doesNotMatch(html, /AL-1001/);
  assert.doesNotMatch(html, /Qué quedó trancado/);
});

test('toda respuesta del panel es noindex y no cacheable', async () => {
  const response = await onRequest({ request: request('/panel'), env: baseEnv() });
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('con sesión válida se ve el tablero, y el nombre del comprador va escapado', async () => {
  const response = await onRequest({
    request: request('/panel', { cookie: await sessionCookie() }),
    env: baseEnv(),
  });
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /Qué quedó trancado/);
  assert.match(html, /AL-1001/);
  assert.match(html, /\$ 1[.,]?990/);

  // El nombre hostil aparece escapado, nunca como etiqueta ejecutable.
  assert.match(html, /&lt;script&gt;alert\(&quot;xss&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\("xss"\)<\/script>/);
});

test('el login correcto entrega la cookie de sesión y redirige al tablero', async () => {
  const response = await withTurnstile(true, () => onRequest({
    request: request('/panel/login', { method: 'POST', body: loginBody(PASSWORD) }),
    env: baseEnv(),
  }));

  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/panel');
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /amado_panel_session=v1\./);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
});

test('la contraseña equivocada no entrega cookie ni revela nada del intento', async () => {
  const response = await withTurnstile(true, () => onRequest({
    request: request('/panel/login', { method: 'POST', body: loginBody('la-que-no-es') }),
    env: baseEnv(),
  }));

  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);
  const html = await response.text();
  assert.match(html, /Contraseña incorrecta/);
  assert.doesNotMatch(html, /AL-1001/);
  assert.equal(html.includes(PASSWORD), false);
});

test('sin pasar Turnstile no se llega ni a comparar la contraseña', async () => {
  const response = await withTurnstile(false, () => onRequest({
    request: request('/panel/login', { method: 'POST', body: loginBody(PASSWORD) }),
    env: baseEnv(),
  }));

  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match(await response.text(), /humano/i);
});

test('tras demasiados intentos fallidos el login responde 429 sin validar nada más', async () => {
  const kv = {
    get: async () => '8',
    put: async () => {},
    delete: async () => {},
  };
  let turnstileCalled = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { turnstileCalled = true; return new Response('{}', { status: 200 }); };
  try {
    const response = await onRequest({
      request: request('/panel/login', { method: 'POST', body: loginBody(PASSWORD) }),
      env: baseEnv({ AMADO_KV: kv }),
    });
    assert.equal(response.status, 429);
    assert.equal(turnstileCalled, false, 'no debe gastar una verificación de Turnstile si ya está bloqueado');
  } finally {
    globalThis.fetch = original;
  }
});

test('logout borra la cookie y sólo acepta POST', async () => {
  const post = await onRequest({
    request: request('/panel/logout', { method: 'POST', cookie: await sessionCookie() }),
    env: baseEnv(),
  });
  assert.equal(post.status, 303);
  assert.match(post.headers.get('set-cookie'), /Max-Age=0/);

  const get = await onRequest({ request: request('/panel/logout'), env: baseEnv() });
  assert.equal(get.status, 405);
});

test('el tablero sigue en pie aunque D1 no esté disponible', async () => {
  const response = await onRequest({
    request: request('/panel', { cookie: await sessionCookie() }),
    env: baseEnv({ ORDERS_DB: undefined }),
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Qué quedó trancado/);
  assert.match(html, /No se pudo cargar/);
});

test('una cookie firmada con otra contraseña no abre el tablero', async () => {
  // Es el caso real de cambiar la contraseña: las sesiones abiertas se caen solas,
  // porque la llave de firma se deriva de ella.
  const response = await onRequest({
    request: request('/panel', { cookie: await sessionCookie('otra-contraseña-vieja') }),
    env: baseEnv(),
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /type="password"/);
  assert.doesNotMatch(html, /AL-1001/);
});
