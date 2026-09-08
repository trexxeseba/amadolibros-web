import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PANEL_AUTH_CONSTANTS,
  clearFailedLogins,
  clearedSessionCookieHeader,
  createSessionToken,
  hasValidSession,
  loginAttemptsExceeded,
  parseCookies,
  recordFailedLogin,
  resolvePanelConfig,
  sessionCookieHeader,
  timingSafeEqual,
  verifySessionToken,
} from '../_shared/panel-auth.js';

const SECRET = 'a'.repeat(48);

function kvStub({ failing = false } = {}) {
  const store = new Map();
  if (failing) {
    return {
      get: () => { throw new Error('KV caído'); },
      put: () => { throw new Error('KV caído'); },
      delete: () => { throw new Error('KV caído'); },
    };
  }
  return {
    get: async key => store.get(key) ?? null,
    put: async (key, value) => { store.set(key, value); },
    delete: async key => { store.delete(key); },
    _store: store,
  };
}

test('el panel falla cerrado: sin secrets, o con secrets débiles, no hay configuración válida', () => {
  assert.equal(resolvePanelConfig(undefined).ok, false);
  assert.equal(resolvePanelConfig({}).ok, false);
  assert.equal(resolvePanelConfig({ PANEL_PASSWORD: 'corta', PANEL_SESSION_SECRET: SECRET }).ok, false);
  assert.equal(resolvePanelConfig({ PANEL_PASSWORD: 'x'.repeat(12), PANEL_SESSION_SECRET: 'corto' }).ok, false);

  const valid = resolvePanelConfig({ PANEL_PASSWORD: 'x'.repeat(12), PANEL_SESSION_SECRET: SECRET });
  assert.equal(valid.ok, true);
  assert.equal(valid.password, 'x'.repeat(12));
});

test('timingSafeEqual compara por valor sin cortar ante longitudes distintas', () => {
  assert.equal(timingSafeEqual('secreto', 'secreto'), true);
  assert.equal(timingSafeEqual('secreto', 'secretx'), false);
  assert.equal(timingSafeEqual('secreto', 'secreto-mas-largo'), false);
  assert.equal(timingSafeEqual('', ''), true);
  assert.equal(timingSafeEqual('secreto', ''), false);
  assert.equal(timingSafeEqual(undefined, 'secreto'), false);
  // Acentos y multibyte: se compara sobre bytes UTF-8, no sobre unidades UTF-16.
  assert.equal(timingSafeEqual('contraseña', 'contraseña'), true);
  assert.equal(timingSafeEqual('contraseña', 'contrasena'), false);
});

test('una sesión recién firmada se valida, y uno de otro secret no', async () => {
  const token = await createSessionToken(SECRET);
  assert.equal(await verifySessionToken(token, SECRET), true);
  assert.equal(await verifySessionToken(token, 'b'.repeat(48)), false);
});

test('la sesión vencida se rechaza aunque la firma sea legítima', async () => {
  const now = Date.now();
  const token = await createSessionToken(SECRET, { now, ttlSeconds: 60 });
  assert.equal(await verifySessionToken(token, SECRET, { now: now + 30_000 }), true);
  assert.equal(await verifySessionToken(token, SECRET, { now: now + 61_000 }), false);
});

test('no se acepta un token manipulado: ni la firma, ni la fecha, ni el formato', async () => {
  const token = await createSessionToken(SECRET);
  const [version, expiresAt, signature] = token.split('.');

  // Firma cambiada.
  assert.equal(await verifySessionToken(`${version}.${expiresAt}.${signature}x`, SECRET), false);
  // Vencimiento estirado conservando la firma vieja: la firma cubre la fecha.
  const farFuture = Number(expiresAt) + 999_999;
  assert.equal(await verifySessionToken(`${version}.${farFuture}.${signature}`, SECRET), false);
  // Formatos basura.
  for (const bad of ['', 'x', 'v1.123', `v2.${expiresAt}.${signature}`, `v1.abc.${signature}`]) {
    assert.equal(await verifySessionToken(bad, SECRET), false, `debía rechazar: ${bad}`);
  }
});

test('la cookie de sesión viaja HttpOnly, Secure, SameSite=Strict y acotada a /panel', async () => {
  const header = sessionCookieHeader(await createSessionToken(SECRET));
  assert.match(header, /^amado_panel_session=/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Path=\/panel/);

  const cleared = clearedSessionCookieHeader();
  assert.match(cleared, /Max-Age=0/);
  assert.match(cleared, /HttpOnly/);
});

test('hasValidSession lee la cookie del request real', async () => {
  const token = await createSessionToken(SECRET);
  const withSession = { headers: { get: name => (name === 'cookie' ? `otra=1; amado_panel_session=${token}` : null) } };
  const withoutSession = { headers: { get: () => 'otra=1' } };

  assert.equal(await hasValidSession(withSession, SECRET), true);
  assert.equal(await hasValidSession(withoutSession, SECRET), false);
});

test('parseCookies tolera espacios, valores vacíos y duplicados', () => {
  const jar = parseCookies(' a=1;  b = 2 ; malformada ; a=99; c=');
  assert.equal(jar.get('a'), '1');
  assert.equal(jar.get('b'), '2');
  assert.equal(jar.get('c'), '');
  assert.equal(jar.has('malformada'), false);
});

test('el freno de fuerza bruta corta a los N intentos y se limpia al acertar', async () => {
  const kv = kvStub();
  const ip = '203.0.113.7';

  assert.equal(await loginAttemptsExceeded(kv, ip), false);
  for (let i = 0; i < PANEL_AUTH_CONSTANTS.LOGIN_MAX_ATTEMPTS; i += 1) {
    await recordFailedLogin(kv, ip);
  }
  assert.equal(await loginAttemptsExceeded(kv, ip), true);
  // Otra IP no queda bloqueada por los intentos ajenos.
  assert.equal(await loginAttemptsExceeded(kv, '198.51.100.4'), false);

  await clearFailedLogins(kv, ip);
  assert.equal(await loginAttemptsExceeded(kv, ip), false);
});

test('si KV falla el freno deja pasar el intento en vez de dejar afuera al dueño', async () => {
  const kv = kvStub({ failing: true });
  assert.equal(await loginAttemptsExceeded(kv, '203.0.113.7'), false);
  await recordFailedLogin(kv, '203.0.113.7');
  await clearFailedLogins(kv, '203.0.113.7');
  // Sin KV configurado tampoco explota.
  assert.equal(await loginAttemptsExceeded(undefined, '203.0.113.7'), false);
});
