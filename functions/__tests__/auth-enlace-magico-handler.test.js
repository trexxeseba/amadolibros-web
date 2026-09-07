import test from 'node:test';
import assert from 'node:assert/strict';

import {
  crearConfirmacionHandler,
  crearMisPedidosHandler,
  crearSalidaHandler,
  crearSesionHandler,
  crearSolicitudHandler,
} from '../api/_auth_handler.js';
import { COOKIE_NAME, hashSecreto } from '../api/_auth_logic.js';

const AHORA = new Date('2026-09-07T12:00:00.000Z');
const getNow = () => AHORA;

// D1 falso que EXPLOTA ante una consulta que no conoce. Si el handler cambia
// su SQL, la prueba se rompe en vez de seguir pasando contra un doble que ya
// no representa lo que corre.
function d1Falso({ orders = [], orderItems = [], tokens = [], sessions = [] } = {}) {
  const estado = { orders, orderItems, tokens, sessions };

  function ejecutar(sql, args) {
    if (sql.includes('SELECT 1 AS existe FROM orders')) {
      const hay = estado.orders.some(o => o.buyer_email === args[0]);
      return { first: hay ? { existe: 1 } : null };
    }
    if (sql.startsWith('INSERT INTO auth_tokens')) {
      const [token_hash, email, created_at, expires_at, request_ip] = args;
      estado.tokens.push({ token_hash, email, created_at, expires_at, request_ip, used_at: null });
      return { run: { meta: { changes: 1 } } };
    }
    if (sql.startsWith('UPDATE auth_tokens SET used_at')) {
      const [usedAt, hash, ahoraIso] = args;
      const fila = estado.tokens.find(t => t.token_hash === hash);
      const aplica = Boolean(fila) && !fila.used_at && fila.expires_at > ahoraIso;
      if (aplica) fila.used_at = usedAt;
      return { run: { meta: { changes: aplica ? 1 : 0 } } };
    }
    if (sql.includes('FROM auth_tokens WHERE token_hash')) {
      return { first: estado.tokens.find(t => t.token_hash === args[0]) || null };
    }
    if (sql.startsWith('INSERT INTO auth_sessions')) {
      const [session_hash, email, created_at, expires_at] = args;
      estado.sessions.push({ session_hash, email, created_at, expires_at, revoked_at: null });
      return { run: { meta: { changes: 1 } } };
    }
    if (sql.startsWith('UPDATE auth_sessions SET revoked_at')) {
      const fila = estado.sessions.find(s => s.session_hash === args[1] && !s.revoked_at);
      if (fila) fila.revoked_at = args[0];
      return { run: { meta: { changes: fila ? 1 : 0 } } };
    }
    if (sql.includes('FROM auth_sessions WHERE session_hash')) {
      return { first: estado.sessions.find(s => s.session_hash === args[0]) || null };
    }
    if (sql.includes('FROM orders WHERE buyer_email')) {
      return { results: estado.orders.filter(o => o.buyer_email === args[0]) };
    }
    if (sql.includes('FROM order_items WHERE order_id')) {
      return { results: estado.orderItems.filter(i => i.order_id === args[0]) };
    }
    throw new Error(`El D1 falso no conoce esta consulta: ${sql}`);
  }

  return {
    estado,
    db: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() { return ejecutar(sql, args).first ?? null; },
              async all() { return { results: ejecutar(sql, args).results ?? [] }; },
              async run() { return ejecutar(sql, args).run ?? { meta: { changes: 0 } }; },
            };
          },
        };
      },
    },
  };
}

function kvFalso() {
  const mapa = new Map();
  return { mapa, async get(k) { return mapa.get(k) ?? null; }, async put(k, v) { mapa.set(k, v); } };
}

function entorno({ db, kv }) {
  return {
    ORDERS_DB: db,
    AMADO_KV: kv,
    TURNSTILE_SECRET_KEY: 'secreto-turnstile',
    APP_ENV: 'preview',
    MP_COLLECTOR_ID: '123456',
    CANONICAL_ORIGIN: 'https://www.amadolibros.com',
    RESEND_API_KEY: 'clave',
    SALES_NOTIFICATION_FROM: 'hola@amadolibros.com',
  };
}

function peticion(cuerpo, { method = 'POST', cookie = '' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  return new Request('https://pr-1.amadolibros-web.pages.dev/api/auth/solicitar', {
    method, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
}

const PEDIDO = {
  id: 'ord_1', public_code: 'AL-001', status: 'paid', payment_status: 'approved',
  delivery_type: 'pickup', payable_total_uyu: 990, currency: 'UYU',
  created_at: '2026-09-01T10:00:00.000Z', buyer_email: 'clienta@ejemplo.com',
};

function solicitud({ db, kv, enviados, turnstileOk = true }) {
  return crearSolicitudHandler({
    getNow,
    verifyTurnstileToken: async () => ({ ok: turnstileOk }),
    enviarCorreo: async ({ to, email }) => { enviados.push({ to, email }); return { ok: true }; },
  });
}

// ─── Pedir el enlace ─────────────────────────────────────────────────────────

test('la respuesta es idéntica exista o no el correo: no dice quién compró', async () => {
  const { db } = d1Falso({ orders: [PEDIDO] });
  const kv = kvFalso();
  const enviados = [];
  const handler = solicitud({ db, kv, enviados });
  const env = entorno({ db, kv });

  const conocido = await handler({ request: peticion({ email: 'clienta@ejemplo.com', turnstileToken: 't' }), env });
  const desconocido = await handler({ request: peticion({ email: 'nadie@ejemplo.com', turnstileToken: 't' }), env });

  assert.equal(conocido.status, desconocido.status);
  assert.deepEqual(await conocido.json(), await desconocido.json());
  assert.equal(enviados.length, 1, 'sólo se manda correo a quien tiene pedidos');
  assert.equal(enviados[0].to, 'clienta@ejemplo.com');
});

test('el enlace del correo apunta al origen canónico, no al host de la petición', async () => {
  const { db } = d1Falso({ orders: [PEDIDO] });
  const kv = kvFalso();
  const enviados = [];
  await solicitud({ db, kv, enviados })({
    request: peticion({ email: 'clienta@ejemplo.com', turnstileToken: 't' }),
    env: entorno({ db, kv }),
  });
  assert.match(enviados[0].email.html, /https:\/\/www\.amadolibros\.com\/ingresar\?t=/);
  assert.doesNotMatch(enviados[0].email.html, /pages\.dev/);
});

test('sin Turnstile válido no se manda nada', async () => {
  const { db } = d1Falso({ orders: [PEDIDO] });
  const kv = kvFalso();
  const enviados = [];
  const res = await solicitud({ db, kv, enviados, turnstileOk: false })({
    request: peticion({ email: 'clienta@ejemplo.com', turnstileToken: 't' }),
    env: entorno({ db, kv }),
  });
  assert.equal(res.status, 403);
  assert.equal(enviados.length, 0);
});

test('el límite de envío corta el cañón de correo, sin delatar el corte', async () => {
  const { db } = d1Falso({ orders: [PEDIDO] });
  const kv = kvFalso();
  const enviados = [];
  const handler = solicitud({ db, kv, enviados });
  const env = entorno({ db, kv });

  const respuestas = [];
  for (let i = 0; i < 5; i += 1) {
    respuestas.push(await handler({ request: peticion({ email: 'clienta@ejemplo.com', turnstileToken: 't' }), env }));
  }
  assert.equal(enviados.length, 3, 'tres envíos y no más');
  for (const res of respuestas) assert.equal(res.status, 200, 'el bloqueo no cambia la respuesta');
});

test('sin KV, sin base o sin secreto de Turnstile falla cerrado', async () => {
  const { db } = d1Falso({ orders: [PEDIDO] });
  const kv = kvFalso();
  const enviados = [];
  const handler = solicitud({ db, kv, enviados });
  for (const faltante of ['AMADO_KV', 'ORDERS_DB', 'TURNSTILE_SECRET_KEY']) {
    const env = { ...entorno({ db, kv }), [faltante]: undefined };
    const res = await handler({ request: peticion({ email: 'clienta@ejemplo.com', turnstileToken: 't' }), env });
    assert.equal(res.status, 503, `debería fallar cerrado sin ${faltante}`);
  }
  assert.equal(enviados.length, 0);
});

test('sólo POST', async () => {
  const { db } = d1Falso();
  const kv = kvFalso();
  const res = await solicitud({ db, kv, enviados: [] })({
    request: peticion(undefined, { method: 'GET' }), env: entorno({ db, kv }),
  });
  assert.equal(res.status, 405);
});

// ─── Confirmar el enlace ─────────────────────────────────────────────────────

async function pedirYObtenerToken() {
  const falso = d1Falso({ orders: [PEDIDO] });
  const kv = kvFalso();
  const enviados = [];
  await solicitud({ db: falso.db, kv, enviados })({
    request: peticion({ email: 'clienta@ejemplo.com', turnstileToken: 't' }),
    env: entorno({ db: falso.db, kv }),
  });
  const secreto = new URL(enviados[0].email.html.match(/href="([^"]+)"/)[1]).searchParams.get('t');
  return { falso, kv, secreto };
}

test('un enlace válido crea sesión y devuelve la cookie protegida', async () => {
  const { falso, kv, secreto } = await pedirYObtenerToken();
  const res = await crearConfirmacionHandler({ getNow })({
    request: peticion({ token: secreto }), env: entorno({ db: falso.db, kv }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('Set-Cookie');
  assert.ok(cookie.startsWith(`${COOKIE_NAME}=`), cookie);
  for (const defensa of ['HttpOnly', 'Secure', 'SameSite=Lax']) assert.match(cookie, new RegExp(defensa));
  assert.equal(falso.estado.sessions.length, 1);
  // La sesión guardada es el hash, no la credencial que viaja en la cookie.
  const enviadoEnCookie = cookie.split(';')[0].split('=')[1];
  assert.notEqual(falso.estado.sessions[0].session_hash, enviadoEnCookie);
  assert.equal(falso.estado.sessions[0].session_hash, await hashSecreto(enviadoEnCookie));
});

test('el enlace sirve UNA sola vez', async () => {
  const { falso, kv, secreto } = await pedirYObtenerToken();
  const env = entorno({ db: falso.db, kv });
  const handler = crearConfirmacionHandler({ getNow });

  assert.equal((await handler({ request: peticion({ token: secreto }), env })).status, 200);
  const segunda = await handler({ request: peticion({ token: secreto }), env });
  assert.equal(segunda.status, 400, 'el segundo uso tiene que fallar');
  assert.equal((await segunda.json()).motivo, 'ya_usado');
  assert.equal(falso.estado.sessions.length, 1, 'no se creó una segunda sesión');
});

test('un enlace vencido no entra', async () => {
  const { falso, kv, secreto } = await pedirYObtenerToken();
  const masTarde = new Date(AHORA.getTime() + 16 * 60_000);
  const res = await crearConfirmacionHandler({ getNow: () => masTarde })({
    request: peticion({ token: secreto }), env: entorno({ db: falso.db, kv }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).motivo, 'vencido');
});

test('un token inventado no entra y no toca la base', async () => {
  const falso = d1Falso();
  const kv = kvFalso();
  const res = await crearConfirmacionHandler({ getNow })({
    request: peticion({ token: 'z'.repeat(43) }), env: entorno({ db: falso.db, kv }),
  });
  assert.equal(res.status, 400);
  assert.equal(falso.estado.sessions.length, 0);
  const deforme = await crearConfirmacionHandler({ getNow })({
    request: peticion({ token: 'corto' }), env: entorno({ db: falso.db, kv }),
  });
  assert.equal(deforme.status, 400);
});

// ─── Mis pedidos ─────────────────────────────────────────────────────────────

const PEDIDO_AJENO = { ...PEDIDO, id: 'ord_2', public_code: 'AL-002', buyer_email: 'otro@ejemplo.com' };

async function sesionIniciada() {
  const falso = d1Falso({
    orders: [PEDIDO, PEDIDO_AJENO],
    orderItems: [
      { order_id: 'ord_1', title: 'Rayuela', quantity: 1, unit_price_uyu: 990, line_total_uyu: 990 },
      { order_id: 'ord_2', title: 'Secreto ajeno', quantity: 1, unit_price_uyu: 500, line_total_uyu: 500 },
    ],
  });
  const kv = kvFalso();
  const enviados = [];
  const env = entorno({ db: falso.db, kv });
  await solicitud({ db: falso.db, kv, enviados })({
    request: peticion({ email: 'clienta@ejemplo.com', turnstileToken: 't' }), env,
  });
  const secreto = new URL(enviados[0].email.html.match(/href="([^"]+)"/)[1]).searchParams.get('t');
  const res = await crearConfirmacionHandler({ getNow })({ request: peticion({ token: secreto }), env });
  const cookie = res.headers.get('Set-Cookie').split(';')[0];
  return { falso, env, cookie };
}

test('sin cookie no se ven pedidos', async () => {
  const { env } = await sesionIniciada();
  const res = await crearMisPedidosHandler({ getNow })({ request: peticion(undefined, { method: 'GET' }), env });
  assert.equal(res.status, 401);
});

test('sólo se ven los pedidos del correo de la sesión', async () => {
  const { env, cookie } = await sesionIniciada();
  const res = await crearMisPedidosHandler({ getNow })({
    request: peticion(undefined, { method: 'GET', cookie }), env,
  });
  assert.equal(res.status, 200);
  const cuerpo = await res.json();
  assert.equal(cuerpo.email, 'clienta@ejemplo.com');
  assert.equal(cuerpo.pedidos.length, 1);
  assert.equal(cuerpo.pedidos[0].codigo, 'AL-001');
  assert.doesNotMatch(JSON.stringify(cuerpo), /AL-002|Secreto ajeno/, 'nunca un pedido ajeno');
});

test('la sesión se puede consultar y cerrar', async () => {
  const { env, cookie } = await sesionIniciada();
  const activa = await crearSesionHandler({ getNow })({ request: peticion(undefined, { method: 'GET', cookie }), env });
  assert.deepEqual(await activa.json(), { autenticado: true, email: 'clienta@ejemplo.com' });

  const salida = await crearSalidaHandler({ getNow })({ request: peticion(undefined, { cookie }), env });
  assert.match(salida.headers.get('Set-Cookie'), /Max-Age=0/);

  const despues = await crearSesionHandler({ getNow })({ request: peticion(undefined, { method: 'GET', cookie }), env });
  assert.deepEqual(await despues.json(), { autenticado: false }, 'la cookie vieja ya no sirve');

  const pedidos = await crearMisPedidosHandler({ getNow })({ request: peticion(undefined, { method: 'GET', cookie }), env });
  assert.equal(pedidos.status, 401, 'tampoco sirve para los pedidos');
});

test('una sesión vencida deja de servir aunque la cookie siga en el navegador', async () => {
  const { env, cookie } = await sesionIniciada();
  const enUnAno = new Date(AHORA.getTime() + 366 * 24 * 60 * 60 * 1000);
  const res = await crearMisPedidosHandler({ getNow: () => enUnAno })({
    request: peticion(undefined, { method: 'GET', cookie }), env,
  });
  assert.equal(res.status, 401);
});
