import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionToken, deriveSessionSecret } from '../_shared/panel-auth.js';
import {
  buildPickupReadyEmail,
  buildShippingTodayEmail,
  noticeBlockedReason,
  noticeEventId,
  noticeStateFromEvents,
} from '../_shared/panel-notice.js';
import { onRequest } from '../panel/[[path]].js';

const PASSWORD = 'contraseña-larga-del-panel';

const PICKUP_LLENO = {
  address: 'Sarandí 675', zone: 'Ciudad Vieja, Montevideo',
  hours: 'Lunes a viernes de 10 a 18', holdDays: 15,
};
const PICKUP_VACIO = { address: '', zone: '', hours: '', holdDays: 15 };

const RETIRO = {
  id: 42, public_code: 'AL-260909-K71QP2', status: 'paid', payment_status: 'approved',
  buyer_name: 'Valentina Rodríguez', buyer_email: 'valen@example.com', buyer_phone: '099 214 887',
  delivery_type: 'pickup', address: null, locality: null, department: null,
  delivery_notes: null, requested_delivery_date: null,
  requested_delivery_from: null, requested_delivery_to: null,
  products_total_uyu: 3770, pickup_discount_uyu: 190, shipping_cost_uyu: 0,
  payable_total_uyu: 3580, currency: 'UYU', payment_provider: 'mercadopago',
  payment_id: '118742339015', created_at: '2026-09-07T10:00:00.000Z',
  paid_at: '2026-09-07T10:05:00.000Z', fulfilled_at: null, cancelled_at: null,
};
const ENVIO = {
  ...RETIRO, delivery_type: 'shipping',
  address: 'Bulevar España 2341 ap. 604', locality: 'Pocitos', department: 'Montevideo',
};
const ITEMS = [
  { title: '<script>alert(1)</script>Biblia', product_id: 'MLU651526046', quantity: 1, unit_price_uyu: 1990, line_total_uyu: 1990 },
];

// ─────────────────────────────────────────────────────────────────────────
// La regla de cuándo NO se manda. Es pura, así que se prueba directo.
// ─────────────────────────────────────────────────────────────────────────

test('el aviso de retiro no sale sin la dirección y los horarios cargados', () => {
  // Éste es el motivo por el que existe la pantalla de Ajustes: sin esos datos
  // el correo diría "vení a retirarlo" sin decir a dónde.
  const motivo = noticeBlockedReason({ kind: 'pickup_ready', order: RETIRO, pickup: PICKUP_VACIO });
  assert.match(motivo, /Ajustes/);

  for (const incompleto of [
    { ...PICKUP_LLENO, address: '' },
    { ...PICKUP_LLENO, zone: '' },
    { ...PICKUP_LLENO, hours: '' },
    { ...PICKUP_LLENO, hours: '   ' },
  ]) {
    assert.notEqual(
      noticeBlockedReason({ kind: 'pickup_ready', order: RETIRO, pickup: incompleto }), '',
      'con cualquiera de los tres campos vacío el aviso no puede salir',
    );
  }

  assert.equal(noticeBlockedReason({ kind: 'pickup_ready', order: RETIRO, pickup: PICKUP_LLENO }), '');
});

test('cada aviso corresponde a su tipo de entrega y no al otro', () => {
  assert.match(
    noticeBlockedReason({ kind: 'pickup_ready', order: ENVIO, pickup: PICKUP_LLENO }),
    /envío/,
  );
  assert.match(
    noticeBlockedReason({ kind: 'shipping_today', order: RETIRO, pickup: PICKUP_LLENO }),
    /retiro/,
  );
  assert.equal(noticeBlockedReason({ kind: 'shipping_today', order: ENVIO, pickup: PICKUP_LLENO }), '');
});

test('sin correo del comprador no hay a quién avisarle', () => {
  for (const email of [null, '', '   ', undefined]) {
    assert.match(
      noticeBlockedReason({ kind: 'shipping_today', order: { ...ENVIO, buyer_email: email }, pickup: PICKUP_LLENO }),
      /WhatsApp/,
      'hay que decir qué hacer en su lugar, no sólo que no se puede',
    );
  }
});

test('a un pedido cancelado o vencido no se le avisa nada', () => {
  for (const status of ['cancelled', 'expired']) {
    assert.notEqual(
      noticeBlockedReason({ kind: 'shipping_today', order: { ...ENVIO, status }, pickup: PICKUP_LLENO }), '',
    );
  }
});

test('un tipo de aviso inventado no se manda', () => {
  for (const kind of ['', null, 'fulfilled', '__proto__', 'pickup_ready ']) {
    assert.notEqual(
      noticeBlockedReason({ kind, order: ENVIO, pickup: PICKUP_LLENO }), '',
      `"${String(kind)}" no es un aviso válido`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// El contenido del correo
// ─────────────────────────────────────────────────────────────────────────

test('el correo de retiro dice a dónde ir, cuándo y hasta cuándo se guarda', () => {
  const email = buildPickupReadyEmail({ order: RETIRO, pickup: PICKUP_LLENO });
  assert.match(email.subject, /AL-260909-K71QP2/);
  assert.match(email.subject, /listo para retirar/);
  for (const dato of ['Sarandí 675', 'Ciudad Vieja, Montevideo', 'Lunes a viernes de 10 a 18']) {
    assert.ok(email.text.includes(dato), `falta en el correo: ${dato}`);
    assert.ok(email.html.includes(dato), `falta en el HTML: ${dato}`);
  }
  assert.match(email.text, /15 días/);
});

test('el correo de envío dice a dónde va', () => {
  const email = buildShippingTodayEmail({ order: ENVIO });
  assert.match(email.subject, /sale hoy/);
  assert.match(email.text, /Bulevar España 2341 ap\. 604, Pocitos, Montevideo/);
});

test('lo que carga el equipo en Ajustes va escapado en el correo', () => {
  // Gaby escribe estos campos y terminan en un HTML que abre un cliente.
  const email = buildPickupReadyEmail({
    order: { ...RETIRO, buyer_name: '<b>Valentina</b>' },
    pickup: { ...PICKUP_LLENO, address: 'Sarandí <script>alert(1)</script>' },
  });
  assert.doesNotMatch(email.html, /<script>alert\(1\)<\/script>/);
  assert.match(email.html, /&lt;script&gt;/);
  assert.doesNotMatch(email.html, /<b>Valentina<\/b>/);
});

// ─────────────────────────────────────────────────────────────────────────
// Leer del historial qué ya salió
// ─────────────────────────────────────────────────────────────────────────

test('el historial dice qué aviso ya salió, cuál falló y cuál nunca se mandó', () => {
  const state = noticeStateFromEvents([
    {
      event_type: 'panel_pickup_ready_email',
      payload_json: JSON.stringify({ status: 'sent', sent_at: '2026-09-09T12:00:00.000Z' }),
      created_at: '2026-09-09T12:00:00.000Z',
    },
    {
      event_type: 'panel_shipping_today_email',
      payload_json: JSON.stringify({ status: 'failed', failure_code: 'RESEND_HTTP_500', attempted_at: '2026-09-09T13:00:00.000Z' }),
      created_at: '2026-09-09T13:00:00.000Z',
    },
  ]);
  assert.equal(state.pickup_ready.status, 'sent');
  assert.equal(state.pickup_ready.at, '2026-09-09T12:00:00.000Z');
  assert.equal(state.shipping_today.status, 'failed');
  assert.equal(state.shipping_today.failureCode, 'RESEND_HTTP_500');

  assert.equal(noticeStateFromEvents([]).pickup_ready.status, 'none');
  // Un payload ilegible no puede romper la ficha del pedido.
  const roto = noticeStateFromEvents([
    { event_type: 'panel_pickup_ready_email', payload_json: '{no es json', created_at: 'x' },
  ]);
  assert.equal(roto.pickup_ready.status, 'unknown');
});

// ─────────────────────────────────────────────────────────────────────────
// La ruta completa
// ─────────────────────────────────────────────────────────────────────────

function db(order = RETIRO) {
  const seen = [];
  const events = new Map();
  return {
    seen,
    events,
    prepare(sql) {
      let bound = [];
      const st = {
        bind: (...p) => { bound = p; return st; },
        all: async () => {
          seen.push({ sql, bound });
          if (sql.includes('FROM orders')) return { results: [order] };
          if (sql.includes('FROM order_items')) return { results: ITEMS };
          if (sql.includes('FROM order_events')) {
            return { results: [...events.values()].map(row => ({
              event_type: row.event_type, payload_json: row.payload_json, created_at: row.created_at,
            })) };
          }
          return { results: [] };
        },
        first: async () => {
          seen.push({ sql, bound });
          const row = events.get(bound[0]);
          return row ? { payload_json: row.payload_json } : null;
        },
        run: async () => {
          seen.push({ sql, bound });
          if (sql.startsWith('INSERT OR IGNORE INTO order_events')) {
            const [id, orderId, event_type, payload_json, created_at] = bound;
            if (events.has(id)) return { meta: { changes: 0 } };
            events.set(id, { id, orderId, event_type, payload_json, created_at });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE order_events SET payload_json')) {
            const [next, id, previous] = bound;
            const row = events.get(id);
            if (!row || row.payload_json !== previous) return { meta: { changes: 0 } };
            row.payload_json = next;
            return { meta: { changes: 1 } };
          }
          throw new Error(`run inesperado: ${sql}`);
        },
      };
      return st;
    },
  };
}

function kv(pickup) {
  return { get: async () => JSON.stringify(pickup), put: async () => {} };
}

function env({ orders, pickup = PICKUP_LLENO, ...rest } = {}) {
  return {
    APP_ENV: 'production',
    ALLOWED_HOSTS: 'amadolibros.com,www.amadolibros.com',
    PANEL_PASSWORD: PASSWORD,
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    STOCK_WAITLIST_TURNSTILE_SITE_KEY: '0x4AAAAAAD_sitekey',
    RESEND_API_KEY: 're_test',
    SALES_NOTIFICATION_FROM: 'Amado Libros <web@notificaciones.amadolibros.com>',
    ORDERS_DB: orders,
    AMADO_KV: kv(pickup),
    ...rest,
  };
}

async function cookie() {
  const token = await createSessionToken(await deriveSessionSecret(PASSWORD));
  return `amado_panel_session=${token}`;
}

function avisar(kind, { origin = 'https://www.amadolibros.com', session = '' } = {}) {
  const headers = new Headers({ 'cf-connecting-ip': '203.0.113.9' });
  if (session) headers.set('cookie', session);
  if (origin) headers.set('origin', origin);
  const body = new URLSearchParams();
  body.set('kind', kind);
  return new Request('https://www.amadolibros.com/panel/pedido/AL-260909-K71QP2/avisar', {
    method: 'POST', headers, body,
  });
}

async function withResend(responder, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return responder(calls.length);
  };
  try { return await run(calls); } finally { globalThis.fetch = original; }
}

const RESEND_OK = () => new Response(JSON.stringify({ id: 'resend-1' }), {
  status: 200, headers: { 'content-type': 'application/json' },
});

test('avisar retiro: manda el correo y lo deja anotado en el historial', async () => {
  const orders = db(RETIRO);
  await withResend(RESEND_OK, async calls => {
    const response = await onRequest({
      request: avisar('pickup_ready', { session: await cookie() }),
      env: env({ orders }),
    });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /le avisamos a valen@example\.com/);

    assert.equal(calls.length, 1, 'un clic, un correo');
    const enviado = JSON.parse(calls[0].options.body);
    assert.deepEqual(enviado.to, ['valen@example.com']);
    assert.match(enviado.subject, /listo para retirar/);
    assert.ok(enviado.text.includes('Sarandí 675'), 'el correo lleva la dirección de Ajustes');
    // La clave de idempotencia es la misma que el id del evento: si Resend
    // recibe el mismo pedido dos veces, no manda dos correos.
    assert.equal(calls[0].options.headers['Idempotency-Key'], noticeEventId('pickup_ready', 42));
  });

  const evento = orders.events.get(noticeEventId('pickup_ready', 42));
  assert.equal(evento.event_type, 'panel_pickup_ready_email');
  assert.equal(JSON.parse(evento.payload_json).status, 'sent');
});

test('el aviso no toca el pedido: sólo escribe la fila del historial', async () => {
  // El panel manda un correo; no despacha, no cambia estado, no toca catálogo.
  const orders = db(RETIRO);
  await withResend(RESEND_OK, async () => {
    await onRequest({
      request: avisar('pickup_ready', { session: await cookie() }),
      env: env({ orders }),
    });
  });
  const escrituras = orders.seen.filter(({ sql }) => /\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i.test(sql));
  assert.ok(escrituras.length > 0, 'algo tiene que anotar el aviso');
  for (const { sql } of escrituras) {
    assert.match(sql, /order_events/, `el panel escribió fuera del historial: ${sql}`);
    assert.doesNotMatch(sql, /\b(orders|order_items)\b/, `tocó el pedido: ${sql}`);
  }
});

test('dos clics no le mandan dos correos al mismo cliente', async () => {
  const orders = db(RETIRO);
  await withResend(RESEND_OK, async calls => {
    const session = await cookie();
    await onRequest({ request: avisar('pickup_ready', { session }), env: env({ orders }) });
    const segunda = await onRequest({ request: avisar('pickup_ready', { session }), env: env({ orders }) });

    assert.equal(calls.length, 1, 'el segundo clic no llega a Resend');
    const html = await segunda.text();
    assert.match(html, /ya se le había mandado/);
  });
});

test('sin la dirección cargada en Ajustes, el aviso de retiro no sale', async () => {
  const orders = db(RETIRO);
  await withResend(RESEND_OK, async calls => {
    const response = await onRequest({
      request: avisar('pickup_ready', { session: await cookie() }),
      env: env({ orders, pickup: PICKUP_VACIO }),
    });
    assert.equal(response.status, 422);
    assert.equal(calls.length, 0, 'no se manda un correo sin decir a dónde ir');
    assert.match(await response.text(), /Ajustes/);
  });
  assert.equal(orders.events.size, 0, 'un aviso bloqueado no ensucia el historial');
});

test('un aviso que no corresponde al tipo de entrega no se manda', async () => {
  const orders = db(RETIRO);
  await withResend(RESEND_OK, async calls => {
    const response = await onRequest({
      request: avisar('shipping_today', { session: await cookie() }),
      env: env({ orders }),
    });
    assert.equal(response.status, 422);
    assert.equal(calls.length, 0);
  });
});

test('si Resend falla, se dice y queda reintentable', async () => {
  const orders = db(RETIRO);
  await withResend(() => new Response('nope', { status: 500 }), async () => {
    const response = await onRequest({
      request: avisar('pickup_ready', { session: await cookie() }),
      env: env({ orders }),
    });
    assert.equal(response.status, 422);
    assert.match(await response.text(), /No se pudo mandar el correo/);
  });
  const evento = orders.events.get(noticeEventId('pickup_ready', 42));
  assert.equal(JSON.parse(evento.payload_json).status, 'failed');

  // Y el reintento sí sale: un fallo no deja el aviso trancado para siempre.
  await withResend(RESEND_OK, async calls => {
    await onRequest({
      request: avisar('pickup_ready', { session: await cookie() }),
      env: env({ orders }),
    });
    assert.equal(calls.length, 1, 'después de un fallo se puede reintentar');
  });
  assert.equal(JSON.parse(orders.events.get(noticeEventId('pickup_ready', 42)).payload_json).status, 'sent');
});

test('un POST desde otro sitio no manda nada', async () => {
  const orders = db(RETIRO);
  await withResend(RESEND_OK, async calls => {
    const response = await onRequest({
      request: avisar('pickup_ready', { origin: 'https://evil.example', session: await cookie() }),
      env: env({ orders }),
    });
    assert.equal(response.status, 403);
    assert.equal(calls.length, 0);
  });
});

test('sin sesión no se puede avisar', async () => {
  const orders = db(RETIRO);
  await withResend(RESEND_OK, async calls => {
    const response = await onRequest({ request: avisar('pickup_ready'), env: env({ orders }) });
    const html = await response.text();
    assert.match(html, /Turnstile|contraseña|password/i, 'responde el login, no la ficha');
    assert.equal(calls.length, 0);
  });
  assert.equal(orders.events.size, 0);
});

test('la ficha muestra el botón del aviso que corresponde y esconde el otro', async () => {
  const orders = db(RETIRO);
  const response = await onRequest({
    request: new Request('https://www.amadolibros.com/panel/pedido/AL-260909-K71QP2', {
      headers: { cookie: await cookie(), 'cf-connecting-ip': '203.0.113.9' },
    }),
    env: env({ orders }),
  });
  const html = await response.text();
  assert.match(html, /Avisar que está listo para retirar/);
  assert.doesNotMatch(html, /Avisar que el envío sale hoy/);
  assert.match(html, /valen@example\.com/);
});

test('un GET a la ficha no manda ni anota nada', async () => {
  const orders = db(RETIRO);
  await withResend(RESEND_OK, async calls => {
    await onRequest({
      request: new Request('https://www.amadolibros.com/panel/pedido/AL-260909-K71QP2', {
        headers: { cookie: await cookie(), 'cf-connecting-ip': '203.0.113.9' },
      }),
      env: env({ orders }),
    });
    assert.equal(calls.length, 0);
  });
  for (const { sql } of orders.seen) {
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i, `mirar la ficha escribió: ${sql}`);
  }
});

test('un GET a la ruta de avisar no existe, y un POST a la ficha tampoco', async () => {
  const orders = db(RETIRO);
  const get = await onRequest({
    request: new Request('https://www.amadolibros.com/panel/pedido/AL-260909-K71QP2/avisar', {
      headers: { cookie: await cookie(), 'cf-connecting-ip': '203.0.113.9' },
    }),
    env: env({ orders }),
  });
  assert.equal(get.status, 405);

  const post = await onRequest({
    request: new Request('https://www.amadolibros.com/panel/pedido/AL-260909-K71QP2', {
      method: 'POST',
      headers: { cookie: await cookie(), 'cf-connecting-ip': '203.0.113.9' },
    }),
    env: env({ orders }),
  });
  assert.equal(post.status, 405);
});
