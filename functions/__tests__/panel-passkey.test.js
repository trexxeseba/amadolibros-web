import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';

import {
  base64UrlDecode,
  base64UrlEncode,
  ecdsaDerToRaw,
  issueChallenge,
  listPasskeys,
  registerPasskey,
  removePasskey,
  verifyPasskeyLogin,
} from '../_shared/panel-passkey.js';

const cryptoImpl = webcrypto;
const RP_ID = 'www.amadolibros.com';
const ORIGIN = 'https://www.amadolibros.com';
const OPTS = { origin: ORIGIN, rpId: RP_ID, crypto: cryptoImpl };

function kvStub() {
  const store = new Map();
  return {
    store,
    get: async key => (store.has(key) ? store.get(key) : null),
    put: async (key, value) => { store.set(key, value); },
    delete: async key => { store.delete(key); },
  };
}

const enc = text => new TextEncoder().encode(text);
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const sha256 = async bytes => new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes));

// Firma cruda r||s → DER, como la entregan los autenticadores reales.
function rawToDer(raw) {
  const int = bytes => {
    let b = bytes;
    while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.slice(1);
    if (b[0] & 0x80) b = concat(new Uint8Array([0]), b);
    return concat(new Uint8Array([0x02, b.length]), b);
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return concat(new Uint8Array([0x30, r.length + s.length]), r, s);
}

async function authData({ rpId = RP_ID, flags = 0x05 } = {}) {
  return concat(await sha256(enc(rpId)), new Uint8Array([flags, 0, 0, 0, 1]));
}

async function makeAuthenticator(alg) {
  const params = alg === -7
    ? { name: 'ECDSA', namedCurve: 'P-256' }
    : { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
  const keys = await cryptoImpl.subtle.generateKey(params, true, ['sign', 'verify']);
  const spki = new Uint8Array(await cryptoImpl.subtle.exportKey('spki', keys.publicKey));
  const id = base64UrlEncode(cryptoImpl.getRandomValues(new Uint8Array(32)));
  async function sign(data) {
    if (alg === -7) {
      const raw = new Uint8Array(await cryptoImpl.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, data));
      return rawToDer(raw);
    }
    return new Uint8Array(await cryptoImpl.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, keys.privateKey, data));
  }
  return { alg, id, spki, sign };
}

async function registrationBody(kv, auth, { nombre = 'PC de Seba', origin = ORIGIN, rpId = RP_ID, flags = 0x05, challenge } = {}) {
  const ch = challenge ?? await issueChallenge(kv, 'registro', { crypto: cryptoImpl });
  const clientData = enc(JSON.stringify({ type: 'webauthn.create', challenge: ch, origin }));
  return {
    nombre,
    id: auth.id,
    alg: auth.alg,
    publicKey: base64UrlEncode(auth.spki),
    clientDataJSON: base64UrlEncode(clientData),
    authenticatorData: base64UrlEncode(await authData({ rpId, flags })),
  };
}

async function loginBody(kv, auth, { origin = ORIGIN, rpId = RP_ID, flags = 0x05, challenge, purpose = 'entrada', type = 'webauthn.get' } = {}) {
  const ch = challenge ?? await issueChallenge(kv, purpose, { crypto: cryptoImpl });
  const clientData = enc(JSON.stringify({ type, challenge: ch, origin }));
  const data = await authData({ rpId, flags });
  const signature = await auth.sign(concat(data, await sha256(clientData)));
  return {
    body: {
      id: auth.id,
      clientDataJSON: base64UrlEncode(clientData),
      authenticatorData: base64UrlEncode(data),
      signature: base64UrlEncode(signature),
    },
    challenge: ch,
  };
}

for (const alg of [-7, -257]) {
  test(`alg ${alg}: registrar un equipo y entrar con él`, async () => {
    const kv = kvStub();
    const auth = await makeAuthenticator(alg);
    const reg = await registerPasskey(kv, await registrationBody(kv, auth), OPTS);
    assert.equal(reg.ok, true, reg.error);
    const lista = await listPasskeys(kv);
    assert.equal(lista.length, 1);
    assert.equal(lista[0].nombre, 'PC de Seba');
    assert.equal(lista[0].alg, alg);

    const { body } = await loginBody(kv, auth);
    const res = await verifyPasskeyLogin(kv, body, OPTS);
    assert.equal(res.ok, true, res.error);
  });
}

test('el desafío sirve una sola vez', async () => {
  const kv = kvStub();
  const auth = await makeAuthenticator(-7);
  await registerPasskey(kv, await registrationBody(kv, auth), OPTS);
  const { body } = await loginBody(kv, auth);
  assert.equal((await verifyPasskeyLogin(kv, body, OPTS)).ok, true);
  const again = await verifyPasskeyLogin(kv, body, OPTS);
  assert.deepEqual(again, { ok: false, error: 'desafio_invalido' });
});

test('un desafío de registro no sirve para entrar, ni uno inventado', async () => {
  const kv = kvStub();
  const auth = await makeAuthenticator(-7);
  await registerPasskey(kv, await registrationBody(kv, auth), OPTS);
  const { body } = await loginBody(kv, auth, { purpose: 'registro' });
  assert.equal((await verifyPasskeyLogin(kv, body, OPTS)).error, 'desafio_invalido');
  const inventado = await loginBody(kv, auth, { challenge: base64UrlEncode(new Uint8Array(32).fill(7)) });
  assert.equal((await verifyPasskeyLogin(kv, inventado.body, OPTS)).error, 'desafio_invalido');
});

test('rechaza otro origen, otro dominio, sin verificar a la persona y tipo equivocado', async () => {
  const kv = kvStub();
  const auth = await makeAuthenticator(-7);
  await registerPasskey(kv, await registrationBody(kv, auth), OPTS);
  const casos = [
    [{ origin: 'https://amadolibros.evil.com' }, 'origen_distinto'],
    [{ rpId: 'evil.com' }, 'rp_id_distinto'],
    [{ flags: 0x01 }, 'sin_verificacion'],
    [{ flags: 0x04 }, 'sin_presencia'],
    [{ type: 'webauthn.create' }, 'tipo_distinto'],
  ];
  for (const [opciones, error] of casos) {
    const { body } = await loginBody(kv, auth, opciones);
    assert.equal((await verifyPasskeyLogin(kv, body, OPTS)).error, error, JSON.stringify(opciones));
  }
});

test('rechaza firma alterada y equipo no registrado', async () => {
  const kv = kvStub();
  const auth = await makeAuthenticator(-257);
  await registerPasskey(kv, await registrationBody(kv, auth), OPTS);
  const { body } = await loginBody(kv, auth);
  const sig = base64UrlDecode(body.signature);
  sig[sig.length - 1] ^= 0xff;
  assert.equal((await verifyPasskeyLogin(kv, { ...body, signature: base64UrlEncode(sig) }, OPTS)).error, 'firma_invalida');

  const otro = await makeAuthenticator(-7);
  const ajeno = await loginBody(kv, otro);
  assert.equal((await verifyPasskeyLogin(kv, ajeno.body, OPTS)).error, 'equipo_no_registrado');

  // Llave de otro equipo con el id del registrado: firma inválida.
  const robado = await loginBody(kv, otro);
  assert.equal((await verifyPasskeyLogin(kv, { ...robado.body, id: auth.id }, OPTS)).ok, false);
});

test('registro: rechaza otro origen, sin verificación y algoritmos no soportados', async () => {
  const kv = kvStub();
  const auth = await makeAuthenticator(-7);
  assert.equal((await registerPasskey(kv, await registrationBody(kv, auth, { origin: 'https://otro.com' }), OPTS)).error, 'origen_distinto');
  assert.equal((await registerPasskey(kv, await registrationBody(kv, auth, { flags: 0x01 }), OPTS)).error, 'sin_verificacion');
  const malAlg = { ...(await registrationBody(kv, auth)), alg: -8 };
  assert.equal((await registerPasskey(kv, malAlg, OPTS)).error, 'algoritmo_no_soportado');
  assert.equal((await listPasskeys(kv)).length, 0);
});

test('quitar un equipo lo deja sin poder entrar', async () => {
  const kv = kvStub();
  const auth = await makeAuthenticator(-7);
  await registerPasskey(kv, await registrationBody(kv, auth), OPTS);
  assert.equal(await removePasskey(kv, auth.id), true);
  const { body } = await loginBody(kv, auth);
  assert.equal((await verifyPasskeyLogin(kv, body, OPTS)).error, 'equipo_no_registrado');
});

test('datos basura no rompen nada', async () => {
  const kv = kvStub();
  for (const body of [null, {}, { id: 'x' }, { id: 'a'.repeat(20), clientDataJSON: '%%%' }]) {
    const res = await verifyPasskeyLogin(kv, body, OPTS);
    assert.equal(res.ok, false);
    const reg = await registerPasskey(kv, body, OPTS);
    assert.equal(reg.ok, false);
  }
});

test('ecdsaDerToRaw convierte una firma DER a r||s de 64 bytes', () => {
  const raw = new Uint8Array(64).map((_, i) => (i === 0 || i === 32 ? 0x80 : i));
  assert.deepEqual(ecdsaDerToRaw(rawToDer(raw)), raw);
});
