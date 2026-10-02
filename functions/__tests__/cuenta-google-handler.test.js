import test from 'node:test';
import assert from 'node:assert/strict';

import {
  crearGoogleHandler,
  crearNonceHandler,
  crearPerfilHandler,
  crearSalidaHandler,
  crearSesionHandler,
} from '../api/_cuenta_handler.js';
import { COOKIE_CSRF, COOKIE_SESION, hashSecreto } from '../api/_cuenta_logic.js';

const AHORA = new Date('2026-09-07T12:00:00.000Z');
const getNow = () => AHORA;
const CLIENT_ID = '123.apps.googleusercontent.com';

// D1 falso que EXPLOTA ante SQL que no conoce: si el handler cambia su
// consulta, la prueba se rompe en vez de seguir pasando contra un doble que
// ya no representa lo que corre.
function d1Falso() {
  const estado = { nonces: [], identities: [], sessions: [], profiles: [], sqlVisto: [] };

  function ejecutar(sql, args) {
    estado.sqlVisto.push(sql);
    if (sql.startsWith('INSERT INTO auth_nonces')) {
      estado.nonces.push({ nonce_hash: args[0], created_at: args[1], expires_at: args[2], used_at: null });
      return { run: { meta: { changes: 1 } } };
    }
    if (sql.startsWith('UPDATE auth_nonces SET used_at')) {
      const [usedAt, hash, ahoraIso] = args;
      const fila = estado.nonces.find(n => n.nonce_hash === hash);
      const aplica = Boolean(fila) && !fila.used_at && fila.expires_at > ahoraIso;
      if (aplica) fila.used_at = usedAt;
      return { run: { meta: { changes: aplica ? 1 : 0 } } };
    }
    if (sql.startsWith('SELECT id FROM account_identities')) {
      return { first: estado.identities.find(i => i.provider === args[0] && i.subject === args[1]) || null };
    }
    if (sql.startsWith('UPDATE account_identities SET email')) {
      const fila = estado.identities.find(i => i.id === args[2]);
      if (fila) { fila.email = args[0]; fila.last_seen_at = args[1]; }
      return { run: { meta: { changes: fila ? 1 : 0 } } };
    }
    if (sql.startsWith('INSERT INTO account_identities')) {
      const [id, provider, subject, email, created_at, last_seen_at] = args;
      estado.identities.push({ id, provider, subject, email, created_at, last_seen_at });
      return { run: { meta: { changes: 1 } } };
    }
    if (sql.startsWith('INSERT INTO account_sessions')) {
      const [session_hash, identity_id, csrf_hash, created_at, expires_at] = args;
      estado.sessions.push({ session_hash, identity_id, csrf_hash, created_at, expires_at, revoked_at: null });
      return { run: { meta: { changes: 1 } } };
    }
    if (sql.startsWith('UPDATE account_sessions SET revoked_at')) {
      const fila = estado.sessions.find(s => s.session_hash === args[1] && !s.revoked_at);
      if (fila) fila.revoked_at = args[0];
      return { run: { meta: { changes: fila ? 1 : 0 } } };
    }
    if (sql.includes('FROM account_sessions s JOIN account_identities i')) {
      const s = estado.sessions.find(x => x.session_hash === args[0]);
      if (!s) return { first: null };
      const i = estado.identities.find(x => x.id === s.identity_id);
      return { first: { ...s, email: i ? i.email : null } };
    }
    if (sql.startsWith('SELECT identity_id FROM account_profiles')) {
      return { first: estado.profiles.find(p => p.identity_id === args[0]) || null };
    }
    if (sql.includes('FROM account_profiles WHERE identity_id')) {
      return { first: estado.profiles.find(p => p.identity_id === args[0]) || null };
    }
    if (sql.startsWith('INSERT INTO account_profiles')) {
      const [identity_id, buyer_name, buyer_phone, address, locality, department, updated_at] = args;
      const previo = estado.profiles.find(p => p.identity_id === identity_id);
      const fila = { identity_id, buyer_name, buyer_phone, address, locality, department, updated_at };
      if (previo) Object.assign(previo, fila); else estado.profiles.push(fila);
      return { run: { meta: { changes: 1 } } };
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

function entorno(db, { conGoogle = true } = {}) {
  return { ORDERS_DB: db, GOOGLE_CLIENT_ID: conGoogle ? CLIENT_ID : '' };
}

function pedir(cuerpo, { method = 'POST', cookie = '', csrf = '' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  return new Request('https://www.amadolibros.com/api/cuenta/google', {
    method, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
}

function tokenFalso({ sub = '11223344', email = 'clienta@ejemplo.com', aud = CLIENT_ID, nonce, name = 'Clienta' } = {}) {
  return async () => ({
    aud, iss: 'https://accounts.google.com',
    exp: Math.floor(AHORA.getTime() / 1000) + 600,
    nonce, sub, email, email_verified: true, name,
  });
}

async function ingresar(falso, opciones = {}) {
  const env = entorno(falso.db);
  const nonceRes = await crearNonceHandler({ getNow })({ request: pedir(undefined, { method: 'GET' }), env });
  const { nonce } = await nonceRes.json();
  const res = await crearGoogleHandler({ getNow, verificarToken: tokenFalso({ ...opciones, nonce }) })({
    request: pedir({ credential: 'jwt-falso', nonce }), env,
  });
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('Set-Cookie')];
  const sesion = (cookies.find(c => c && c.startsWith(COOKIE_SESION)) || '').split(';')[0];
  const csrfCookie = (cookies.find(c => c && c.startsWith(COOKIE_CSRF)) || '').split(';')[0];
  return { res, env, nonce, cookie: sesion, csrf: csrfCookie.split('=')[1] || '' };
}

// ─── Sin configuración de Google ─────────────────────────────────────────────

test('sin Client ID no hay login y no se simula ninguno', async () => {
  const falso = d1Falso();
  const env = entorno(falso.db, { conGoogle: false });
  const nonce = await crearNonceHandler({ getNow })({ request: pedir(undefined, { method: 'GET' }), env });
  assert.equal(nonce.status, 503);
  assert.equal((await nonce.json()).code, 'google_no_configurado');

  const login = await crearGoogleHandler({ getNow })({ request: pedir({ credential: 'x', nonce: 'n'.repeat(43) }), env });
  assert.equal(login.status, 503);
  assert.equal(falso.estado.sessions.length, 0);
});

// ─── Ingreso ─────────────────────────────────────────────────────────────────

test('un cliente nuevo entra: se crea identidad y sesión, con las dos cookies', async () => {
  const falso = d1Falso();
  const { res, cookie, csrf } = await ingresar(falso);
  assert.equal(res.status, 200);
  const cuerpo = await res.json();
  assert.equal(cuerpo.autenticado, true);
  assert.equal(cuerpo.email, 'clienta@ejemplo.com');
  assert.equal(cuerpo.nombre_sugerido, 'Clienta');
  assert.equal(cuerpo.tiene_perfil, false, 'todavía no guardó nada');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.ok(cookie.startsWith(COOKIE_SESION));
  assert.ok(csrf.length > 0);
  assert.equal(falso.estado.identities.length, 1);
  // Lo guardado es el hash, no la cookie que viaja.
  assert.equal(falso.estado.sessions[0].session_hash, await hashSecreto(cookie.split('=')[1]));
});

test('un cliente que vuelve reusa su identidad, no crea otra', async () => {
  const falso = d1Falso();
  await ingresar(falso);
  await ingresar(falso, { email: 'clienta.nueva@ejemplo.com' });
  assert.equal(falso.estado.identities.length, 1, 'mismo sub de Google, misma identidad');
  assert.equal(falso.estado.identities[0].email, 'clienta.nueva@ejemplo.com', 'el correo se actualiza');
  assert.equal(falso.estado.sessions.length, 2);
});

test('dos cuentas de Google distintas no se unen aunque compartan correo', async () => {
  const falso = d1Falso();
  await ingresar(falso, { sub: 'AAA', email: 'mismo@ejemplo.com' });
  await ingresar(falso, { sub: 'BBB', email: 'mismo@ejemplo.com' });
  assert.equal(falso.estado.identities.length, 2, 'la llave es el sub, nunca el correo');
});

test('el nonce sirve una sola vez: un token repetido no entra', async () => {
  const falso = d1Falso();
  const env = entorno(falso.db);
  const { nonce } = await (await crearNonceHandler({ getNow })({ request: pedir(undefined, { method: 'GET' }), env })).json();
  const handler = crearGoogleHandler({ getNow, verificarToken: tokenFalso({ nonce }) });

  assert.equal((await handler({ request: pedir({ credential: 'jwt', nonce }), env })).status, 200);
  const repetido = await handler({ request: pedir({ credential: 'jwt', nonce }), env });
  assert.equal(repetido.status, 400);
  assert.equal((await repetido.json()).motivo, 'nonce');
  assert.equal(falso.estado.sessions.length, 1);
});

test('un nonce vencido no entra', async () => {
  const falso = d1Falso();
  const env = entorno(falso.db);
  const { nonce } = await (await crearNonceHandler({ getNow })({ request: pedir(undefined, { method: 'GET' }), env })).json();
  const tarde = new Date(AHORA.getTime() + 11 * 60_000);
  const res = await crearGoogleHandler({ getNow: () => tarde, verificarToken: tokenFalso({ nonce }) })({
    request: pedir({ credential: 'jwt', nonce }), env,
  });
  assert.equal(res.status, 400);
});

test('un token para otra aplicación se rechaza y consume el nonce igual', async () => {
  const falso = d1Falso();
  const env = entorno(falso.db);
  const { nonce } = await (await crearNonceHandler({ getNow })({ request: pedir(undefined, { method: 'GET' }), env })).json();
  const res = await crearGoogleHandler({ getNow, verificarToken: tokenFalso({ nonce, aud: 'otra-app' }) })({
    request: pedir({ credential: 'jwt', nonce }), env,
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).motivo, 'audiencia_incorrecta');
  assert.equal(falso.estado.sessions.length, 0);
});

test('si Google no responde, no se entra', async () => {
  const falso = d1Falso();
  const env = entorno(falso.db);
  const { nonce } = await (await crearNonceHandler({ getNow })({ request: pedir(undefined, { method: 'GET' }), env })).json();
  const res = await crearGoogleHandler({ getNow, verificarToken: async () => null })({
    request: pedir({ credential: 'jwt', nonce }), env,
  });
  assert.equal(res.status, 401);
  assert.equal(falso.estado.sessions.length, 0);
});

// ─── Perfil ──────────────────────────────────────────────────────────────────

const PERFIL = {
  buyer_name: 'Ana Pérez', buyer_phone: '099111222',
  address: 'Rincón 608', locality: 'Ciudad Vieja', department: 'Montevideo',
};

test('sin sesión no se lee ni se escribe perfil', async () => {
  const falso = d1Falso();
  const env = entorno(falso.db);
  const handler = crearPerfilHandler({ getNow });
  assert.equal((await handler({ request: pedir(undefined, { method: 'GET' }), env })).status, 401);
  assert.equal((await handler({ request: pedir({ perfil: PERFIL }), env })).status, 401);
  assert.equal(falso.estado.profiles.length, 0);
});

test('guardar el perfil exige CSRF y no crea ningún pedido', async () => {
  const falso = d1Falso();
  const { env, cookie, csrf } = await ingresar(falso);
  const handler = crearPerfilHandler({ getNow });

  const sinCsrf = await handler({ request: pedir({ perfil: PERFIL }, { cookie }), env });
  assert.equal(sinCsrf.status, 403);

  const conCsrf = await handler({ request: pedir({ perfil: PERFIL }, { cookie, csrf }), env });
  assert.equal(conCsrf.status, 200);
  assert.equal(falso.estado.profiles.length, 1);
  assert.equal(falso.estado.profiles[0].buyer_name, 'Ana Pérez');

  // Guardar datos no toca pedidos ni pagos: ninguna consulta miró esas tablas.
  const tocoPedidos = falso.estado.sqlVisto.some(s => /\borders\b|order_items|payments?/i.test(s));
  assert.equal(tocoPedidos, false, 'guardar perfil no debe rozar la tabla de pedidos');
});

test('el perfil se lee sin caché y sólo el propio', async () => {
  const falso = d1Falso();
  const primera = await ingresar(falso, { sub: 'AAA', email: 'ana@ejemplo.com' });
  await crearPerfilHandler({ getNow })({
    request: pedir({ perfil: PERFIL }, { cookie: primera.cookie, csrf: primera.csrf }), env: primera.env,
  });

  const propia = await crearPerfilHandler({ getNow })({
    request: pedir(undefined, { method: 'GET', cookie: primera.cookie }), env: primera.env,
  });
  assert.equal(propia.headers.get('Cache-Control'), 'no-store');
  assert.equal((await propia.json()).perfil.buyer_name, 'Ana Pérez');

  // Otra cuenta de Google, en el mismo navegador: no puede ver lo anterior.
  const segunda = await ingresar(falso, { sub: 'BBB', email: 'beto@ejemplo.com' });
  const ajena = await crearPerfilHandler({ getNow })({
    request: pedir(undefined, { method: 'GET', cookie: segunda.cookie }), env: segunda.env,
  });
  assert.equal((await ajena.json()).perfil, null, 'cambiar de cuenta no muestra datos de la anterior');
});

test('un campo fuera de la lista no se guarda aunque se mande', async () => {
  const falso = d1Falso();
  const { env, cookie, csrf } = await ingresar(falso);
  await crearPerfilHandler({ getNow })({
    request: pedir({ perfil: { ...PERFIL, identity_id: 'ajeno', saldo: 999 } }, { cookie, csrf }), env,
  });
  const guardado = falso.estado.profiles[0];
  assert.equal(guardado.saldo, undefined);
  assert.notEqual(guardado.identity_id, 'ajeno', 'el perfil se ata a la sesión, no al cuerpo');
});

// ─── Sesión y salida ─────────────────────────────────────────────────────────

test('la sesión se consulta y refleja si hay perfil', async () => {
  const falso = d1Falso();
  const { env, cookie, csrf } = await ingresar(falso);
  const antes = await crearSesionHandler({ getNow })({ request: pedir(undefined, { method: 'GET', cookie }), env });
  assert.deepEqual(await antes.json(), { autenticado: true, email: 'clienta@ejemplo.com', tiene_perfil: false });

  await crearPerfilHandler({ getNow })({ request: pedir({ perfil: PERFIL }, { cookie, csrf }), env });
  const despues = await crearSesionHandler({ getNow })({ request: pedir(undefined, { method: 'GET', cookie }), env });
  assert.equal((await despues.json()).tiene_perfil, true);
});

test('salir revoca la sesión y borra las dos cookies', async () => {
  const falso = d1Falso();
  const { env, cookie, csrf } = await ingresar(falso);
  const salida = await crearSalidaHandler({ getNow })({ request: pedir(undefined, { cookie, csrf }), env });
  assert.equal(salida.status, 200);
  const cookies = salida.headers.getSetCookie ? salida.headers.getSetCookie() : [salida.headers.get('Set-Cookie')];
  assert.equal(cookies.filter(c => /Max-Age=0/.test(c)).length, 2);

  const despues = await crearSesionHandler({ getNow })({ request: pedir(undefined, { method: 'GET', cookie }), env });
  assert.deepEqual(await despues.json(), { autenticado: false });

  const perfil = await crearPerfilHandler({ getNow })({ request: pedir(undefined, { method: 'GET', cookie }), env });
  assert.equal(perfil.status, 401, 'la cookie revocada tampoco sirve para el perfil');
});

test('una sesión vencida deja de servir aunque la cookie siga en el navegador', async () => {
  const falso = d1Falso();
  const { env, cookie } = await ingresar(falso);
  const enUnAno = new Date(AHORA.getTime() + 366 * 24 * 60 * 60 * 1000);
  const res = await crearPerfilHandler({ getNow: () => enUnAno })({
    request: pedir(undefined, { method: 'GET', cookie }), env,
  });
  assert.equal(res.status, 401);
});

test('salir sin CSRF no revoca la sesión ajena', async () => {
  const falso = d1Falso();
  const { env, cookie } = await ingresar(falso);
  const res = await crearSalidaHandler({ getNow })({ request: pedir(undefined, { cookie }), env });
  assert.equal(res.status, 403);
  assert.equal(falso.estado.sessions[0].revoked_at, null);
});
