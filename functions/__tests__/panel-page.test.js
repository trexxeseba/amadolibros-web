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

const CATALOG_HOSTILE = {
  items: [
    // Sin fotos: es la ficha que sale a Google sin `image`.
    { id: 'MLU999111', title: 'Libro sin foto', status: 'active', available_quantity: 1, isbn: '9781234567897', pictures: [] },
    // Id hostil escrito afuera: nunca debe terminar dentro de un href.
    { id: 'MLU1" onmouseover="alert(1)', title: '<script>alert("titulo")</script>', status: 'paused', available_quantity: 0, isbn: '', pictures: [] },
    // Con foto: no debe aparecer en el aviso.
    { id: 'MLU222333', title: 'Libro con foto', status: 'active', available_quantity: 3, isbn: '9780000000001', pictures: [{ url: 'https://x/y.jpg' }] },
  ],
};

async function withCatalog(catalog, run) {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  globalThis.fetch = async () => Response.json(catalog);
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches) globalThis.caches = originalCaches; else delete globalThis.caches;
  }
}

test('el panel avisa qué fichas salen a Google sin imagen, con enlace para ir a arreglarlas', async () => {
  const html = await withCatalog(CATALOG_HOSTILE, async () => {
    const response = await onRequest({
      request: request('/panel', { cookie: await sessionCookie() }),
      env: baseEnv(),
    });
    assert.equal(response.status, 200);
    return response.text();
  });

  assert.match(html, /Ficha sin imagen para Google \(2\)/);
  assert.match(html, /Libro sin foto/);
  assert.match(html, /href="https:\/\/www\.amadolibros\.com\/libro\/MLU999111"/);

  // El que sí tiene foto no se reporta.
  assert.doesNotMatch(html, /Libro con foto/);

  // El id hostil no genera enlace ni escapa del atributo, y el título va escapado.
  assert.doesNotMatch(html, /onmouseover/);
  assert.doesNotMatch(html, /<script>alert\("titulo"\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(&quot;titulo&quot;\)&lt;\/script&gt;/);
});

test('sin fichas sin imagen el aviso no inventa una alerta', async () => {
  const html = await withCatalog({
    items: [{ id: 'MLU222333', title: 'Libro con foto', status: 'active', available_quantity: 3, isbn: '9780000000001', pictures: [{ url: 'https://x/y.jpg' }] }],
  }, async () => {
    const response = await onRequest({
      request: request('/panel', { cookie: await sessionCookie() }),
      env: baseEnv(),
    });
    return response.text();
  });

  assert.match(html, /Ficha sin imagen para Google/);
  assert.doesNotMatch(html, /Ficha sin imagen para Google \(/);
});

const CATALOG_FEED = {
  items: [
    // Llega a Google: activo, con stock, precio, UYU, permalink y es libro.
    { id: 'MLU100', title: 'Libro vendible', status: 'active', available_quantity: 2, price: 500,
      currency: 'UYU', permalink: 'https://ml/1', domain_id: 'MLU-BOOKS', isbn: '9780000000001', pictures: [{ url: 'https://x/1.jpg' }] },
    // Activos que NO llegan, uno por cada motivo.
    { id: 'MLU200', title: 'Sin precio', status: 'active', available_quantity: 1, price: 0,
      currency: 'UYU', permalink: 'https://ml/2', domain_id: 'MLU-BOOKS', pictures: [{ url: 'https://x/2.jpg' }] },
    { id: 'MLU300', title: 'Sin moneda', status: 'active', available_quantity: 1, price: 400,
      currency: '', permalink: 'https://ml/3', domain_id: 'MLU-BOOKS', pictures: [{ url: 'https://x/3.jpg' }] },
    { id: 'MLU400', title: 'Sin enlace', status: 'active', available_quantity: 1, price: 400,
      currency: 'UYU', permalink: '', domain_id: 'MLU-BOOKS', pictures: [{ url: 'https://x/4.jpg' }] },
    // Pausado: no cuenta como "activo que queda afuera".
    { id: 'MLU500', title: 'Pausado', status: 'paused', available_quantity: 0, price: 300,
      currency: 'UYU', permalink: 'https://ml/5', domain_id: 'MLU-BOOKS', pictures: [{ url: 'https://x/5.jpg' }] },
  ],
};

test('el panel muestra cuántos activos no llegan a Google Shopping y por qué', async () => {
  const html = await withCatalog(CATALOG_FEED, async () => {
    const response = await onRequest({
      request: request('/panel', { cookie: await sessionCookie() }),
      env: baseEnv(),
    });
    assert.equal(response.status, 200);
    return response.text();
  });

  assert.match(html, /Cuántos llegan a Google Shopping/);
  // 4 activos, 1 pasa, 3 quedan afuera. El pausado no entra en la cuenta.
  assert.match(html, /<b>4<\/b><span>libros activos<\/span>/);
  assert.match(html, /<b>1<\/b><span>pasan la puerta comercial<\/span>/);
  assert.match(html, /<b>3<\/b><span>quedan afuera<\/span>/);

  assert.match(html, /sin precio/);
  assert.match(html, /sin moneda UYU/);
  assert.match(html, /sin enlace a Mercado Libre/);

  // No se promete que ese número sea la cantidad final de ofertas en Merchant.
  assert.match(html, /igual o menor/);
});

test('el motivo del feed nunca se desincroniza de la regla real', async () => {
  // Si alguien cambia isEligibleForFeed y no toca feedBlockerReason, este test
  // falla: todo activo contado como bloqueado tiene que ser realmente inelegible,
  // y todo activo elegible no debe aparecer con motivo.
  const { loadCatalogSummary } = await import('../_shared/panel-data.js');
  const { isEligibleForFeed } = await import('../feed.xml.js');

  const summary = await withCatalog(CATALOG_FEED, () => loadCatalogSummary({}));
  const active = CATALOG_FEED.items.filter(item => item.status === 'active');
  const reallyEligible = active.filter(isEligibleForFeed).length;

  assert.equal(summary.feed.activeTotal, active.length);
  assert.equal(summary.feed.eligible, reallyEligible);
  assert.equal(
    summary.feed.blockers.reduce((total, row) => total + row.total, 0),
    active.length - reallyEligible,
    'la suma de motivos tiene que dar exactamente los activos que no pasan',
  );
});

test('las fichas sin foto se ordenan por las que venden primero', async () => {
  const { loadCatalogSummary } = await import('../_shared/panel-data.js');
  const summary = await withCatalog({
    items: [
      { id: 'MLU1', title: 'Pausado sin foto', status: 'paused', available_quantity: 0, pictures: [] },
      { id: 'MLU2', title: 'Activo sin stock sin foto', status: 'active', available_quantity: 0, pictures: [] },
      { id: 'MLU3', title: 'Activo CON stock sin foto', status: 'active', available_quantity: 5, pictures: [] },
    ],
  }, () => loadCatalogSummary({}));

  assert.deepEqual(summary.missingImage.items.map(row => row.title), [
    'Activo CON stock sin foto',
    'Activo sin stock sin foto',
    'Pausado sin foto',
  ]);
});

test('la fecha del catálogo sale del campo que el catálogo realmente trae', async () => {
  // buildCatalog escribe `updated_at`. El panel buscaba `generated_at` y
  // `generatedAt`, que no existen en ningún catálogo real: por eso mostraba "—".
  const { loadCatalogSummary } = await import('../_shared/panel-data.js');
  const summary = await withCatalog(
    { updated_at: '2026-09-10T00:30:00.000Z', items: [] },
    () => loadCatalogSummary({}),
  );
  assert.equal(summary.generatedAt, '2026-09-10T00:30:00.000Z');
});

const ORDER = {
  id: 42, public_code: 'AL-260909-K71QP2', status: 'paid', payment_status: 'approved',
  buyer_name: 'Valentina Rodríguez', buyer_email: 'valen@example.com', buyer_phone: '099 214 887',
  delivery_type: 'shipping', address: 'Bulevar España 2341 ap. 604', locality: 'Pocitos',
  department: 'Montevideo', delivery_notes: '<b>Portero</b> hasta las 18',
  requested_delivery_date: '2026-09-11', requested_delivery_from: '14:00', requested_delivery_to: '18:00',
  products_total_uyu: 3770, pickup_discount_uyu: 0, shipping_cost_uyu: 190, payable_total_uyu: 3960,
  currency: 'UYU', payment_provider: 'mercadopago', payment_id: '118742339015',
  created_at: '2026-09-07T10:00:00.000Z', paid_at: '2026-09-07T10:05:00.000Z',
  fulfilled_at: null, cancelled_at: null,
};
const ORDER_ITEMS = [
  { title: '<script>alert(1)</script>Biblia Reina-Valera', product_id: 'MLU651526046', quantity: 1, unit_price_uyu: 1990, line_total_uyu: 1990 },
  { title: 'El Tarot de Marsella', product_id: 'MLU478189961', quantity: 2, unit_price_uyu: 890, line_total_uyu: 1780 },
];

function orderDb({ found = true } = {}) {
  const seen = [];
  const answer = (sql, params) => {
    seen.push({ sql, params });
    if (sql.includes('FROM orders') && sql.includes('public_code = ?')) return found ? [ORDER] : [];
    if (sql.includes('FROM order_items')) return ORDER_ITEMS;
    if (sql.includes('FROM order_events')) return [{ event_type: 'payment_approved', created_at: '2026-09-07T10:05:00.000Z' }];
    return [];
  };
  return {
    seen,
    prepare(sql) {
      let bound = [];
      const st = { bind: (...p) => { bound = p; return st; }, all: async () => ({ results: answer(sql, bound) }) };
      return st;
    },
  };
}

test('la ficha muestra qué va en la caja y a dónde va, con todo escapado', async () => {
  const db = orderDb();
  const response = await onRequest({
    request: request('/panel/pedido/AL-260909-K71QP2', { cookie: await sessionCookie() }),
    env: baseEnv({ ORDERS_DB: db }),
  });
  assert.equal(response.status, 200);
  const html = await response.text();

  // Lo que hoy la lista no muestra y hace falta para despachar.
  assert.match(html, /Qué va en la caja/);
  assert.match(html, /El Tarot de Marsella/);
  assert.match(html, /2×/);
  assert.match(html, /Bulevar España 2341/);
  assert.match(html, /099 214 887/);
  assert.match(html, /2026-09-11, de 14:00 a 18:00/);
  assert.match(html, /Pago aprobado/);
  assert.match(html, /\$ 3[.,]?960/);

  // Un título hostil de Mercado Libre no ejecuta nada.
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  // Ni una nota de entrega con etiquetas.
  assert.doesNotMatch(html, /<b>Portero<\/b>/);
});

test('sigue siendo solo lectura: la ficha no escribe nada', async () => {
  const db = orderDb();
  await onRequest({
    request: request('/panel/pedido/AL-260909-K71QP2', { cookie: await sessionCookie() }),
    env: baseEnv({ ORDERS_DB: db }),
  });
  for (const { sql } of db.seen) {
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i, `consulta que escribe: ${sql}`);
  }
});

test('un código con forma inválida no llega a consultar la base', async () => {
  const db = orderDb();
  const response = await onRequest({
    request: request(`/panel/pedido/${encodeURIComponent("AL-1' OR 1=1--")}`, { cookie: await sessionCookie() }),
    env: baseEnv({ ORDERS_DB: db }),
  });
  assert.equal(response.status, 404);
  assert.equal(db.seen.length, 0, 'un código que no tiene la forma real ni siquiera se consulta');
});

test('un pedido inexistente responde 404 sin revelar si el código existe', async () => {
  const response = await onRequest({
    request: request('/panel/pedido/AL-260101-ZZZZZZ', { cookie: await sessionCookie() }),
    env: baseEnv({ ORDERS_DB: orderDb({ found: false }) }),
  });
  assert.equal(response.status, 404);
  assert.match(await response.text(), /Pedido no encontrado/);
});

test('sin sesión la ficha muestra el login, nunca los datos del pedido', async () => {
  const response = await onRequest({
    request: request('/panel/pedido/AL-260909-K71QP2'),
    env: baseEnv({ ORDERS_DB: orderDb() }),
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /type="password"/);
  assert.doesNotMatch(html, /Bulevar España/);
  assert.doesNotMatch(html, /Valentina/);
});
