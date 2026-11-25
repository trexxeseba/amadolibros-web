import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto as cryptoImpl } from 'node:crypto';

import { createSessionToken, deriveSessionSecret } from '../_shared/panel-auth.js';
import { base64UrlEncode } from '../_shared/panel-passkey.js';
import { onRequest } from '../panel/[[path]].js';

const PASSWORD = 'contraseña-larga-del-panel';
const ORIGIN = 'https://www.amadolibros.com';

function kvMap() {
  const store = new Map();
  return {
    store,
    get: async key => (store.has(key) ? store.get(key) : null),
    put: async (key, value) => { store.set(key, value); },
    delete: async key => { store.delete(key); },
  };
}

function env(kv) {
  return {
    APP_ENV: 'production',
    ALLOWED_HOSTS: 'www.amadolibros.com',
    PANEL_PASSWORD: PASSWORD,
    TURNSTILE_SECRET_KEY: 'x',
    STOCK_WAITLIST_TURNSTILE_SITE_KEY: 'y',
    AMADO_KV: kv,
  };
}

function req(path, { cookie = '', json, form, origin = ORIGIN, method = 'POST' } = {}) {
  const headers = new Headers({ 'cf-connecting-ip': '203.0.113.7' });
  if (cookie) headers.set('cookie', cookie);
  if (origin) headers.set('origin', origin);
  let body = null;
  if (json) { headers.set('content-type', 'application/json'); body = JSON.stringify(json); }
  if (form) body = form;
  return new Request(`${ORIGIN}${path}`, { method, headers, body });
}

async function sessionCookie() {
  return `amado_panel_session=${await createSessionToken(await deriveSessionSecret(PASSWORD))}`;
}

const enc = t => new TextEncoder().encode(t);
const sha256 = async b => new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', b));
const concat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

async function equipoRs256() {
  const keys = await cryptoImpl.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  return {
    id: base64UrlEncode(cryptoImpl.getRandomValues(new Uint8Array(32))),
    spki: new Uint8Array(await cryptoImpl.subtle.exportKey('spki', keys.publicKey)),
    sign: async data => new Uint8Array(await cryptoImpl.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, keys.privateKey, data)),
  };
}

const authData = async () => concat(await sha256(enc('www.amadolibros.com')), new Uint8Array([0x05, 0, 0, 0, 1]));

test('la pantalla de entrada ofrece Windows Hello primero y la contraseña plegada', async () => {
  const res = await onRequest({ request: req('/panel', { method: 'GET', origin: '' }), env: env(kvMap()) });
  const html = await res.text();
  assert.match(html, /id="entrar-hello"/);
  assert.match(html, /<details>[\s\S]*type="password"/);
  assert.match(html, /\/assets\/panel-hello\.js/);
});

test('sin equipos registrados, pedir entrar con Windows Hello avisa y no emite desafío', async () => {
  const kv = kvMap();
  const res = await onRequest({ request: req('/panel/passkey/opciones-entrada'), env: env(kv) });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'sin_equipos');
  assert.equal(kv.store.size, 0);
});

test('registrar un equipo exige sesión abierta', async () => {
  const kv = kvMap();
  for (const path of ['/panel/passkey/opciones-registro', '/panel/passkey/registrar']) {
    const res = await onRequest({ request: req(path, { json: {} }), env: env(kv) });
    assert.equal(res.status, 401, path);
  }
});

test('un POST desde otro sitio se rechaza', async () => {
  const res = await onRequest({ request: req('/panel/passkey/opciones-entrada', { origin: 'https://evil.example' }), env: env(kvMap()) });
  assert.equal(res.status, 403);
});

test('flujo completo: registrar con sesión, entrar sin sesión y recibir 30 días', async () => {
  const kv = kvMap();
  const equipo = await equipoRs256();
  const cookie = await sessionCookie();

  const opReg = await (await onRequest({ request: req('/panel/passkey/opciones-registro', { cookie }), env: env(kv) })).json();
  const cdReg = enc(JSON.stringify({ type: 'webauthn.create', challenge: opReg.challenge, origin: ORIGIN }));
  const reg = await onRequest({
    request: req('/panel/passkey/registrar', { cookie, json: {
      nombre: 'PC de Gaby', id: equipo.id, alg: -257, publicKey: base64UrlEncode(equipo.spki),
      clientDataJSON: base64UrlEncode(cdReg), authenticatorData: base64UrlEncode(await authData()),
    } }),
    env: env(kv),
  });
  assert.equal(reg.status, 200);

  const ajustes = await onRequest({ request: req('/panel/ajustes', { cookie, method: 'GET', origin: '' }), env: env(kv) });
  assert.match(await ajustes.text(), /PC de Gaby/);

  const op = await (await onRequest({ request: req('/panel/passkey/opciones-entrada'), env: env(kv) })).json();
  assert.deepEqual(op.ids, [equipo.id]);
  assert.equal(op.rpId, 'www.amadolibros.com');
  const cd = enc(JSON.stringify({ type: 'webauthn.get', challenge: op.challenge, origin: ORIGIN }));
  const ad = await authData();
  const firma = await equipo.sign(concat(ad, await sha256(cd)));
  const entrar = await onRequest({
    request: req('/panel/passkey/entrar', { json: {
      id: equipo.id, clientDataJSON: base64UrlEncode(cd), authenticatorData: base64UrlEncode(ad), signature: base64UrlEncode(firma),
    } }),
    env: env(kv),
  });
  assert.equal(entrar.status, 200);
  const setCookie = entrar.headers.get('set-cookie');
  assert.match(setCookie, /amado_panel_session=/);
  assert.match(setCookie, /Max-Age=2592000/);
  assert.match(setCookie, /SameSite=Lax/);

  // Con esa cookie se ve el tablero.
  const token = setCookie.split(';')[0];
  const panel = await onRequest({ request: req('/panel', { cookie: token, method: 'GET', origin: '' }), env: env(kv) });
  assert.doesNotMatch(await panel.text(), /id="entrar-hello"/);

  // La misma firma no sirve dos veces.
  const repetir = await onRequest({
    request: req('/panel/passkey/entrar', { json: {
      id: equipo.id, clientDataJSON: base64UrlEncode(cd), authenticatorData: base64UrlEncode(ad), signature: base64UrlEncode(firma),
    } }),
    env: env(kv),
  });
  assert.equal(repetir.status, 401);
  assert.equal(repetir.headers.get('set-cookie'), null);

  // Quitar el equipo desde Ajustes.
  const form = new URLSearchParams({ id: equipo.id });
  const quitar = await onRequest({ request: req('/panel/passkey/quitar', { cookie, form }), env: env(kv) });
  assert.equal(quitar.status, 303);
  const sin = await onRequest({ request: req('/panel/passkey/opciones-entrada'), env: env(kv) });
  assert.equal(sin.status, 404);
});
