import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAMPOS_PERFIL,
  COOKIE_CSRF,
  COOKIE_SESION,
  camposACompletar,
  construirCookie,
  hashSecreto,
  generarSecreto,
  leerCookie,
  normalizarPerfil,
  pareceSecreto,
  validarClaims,
} from '../api/_cuenta_logic.js';

const AHORA = new Date('2026-09-07T12:00:00.000Z');
const NONCE = 'n'.repeat(43);
const CLIENT_ID = '123.apps.googleusercontent.com';

function claims(patch = {}) {
  return {
    aud: CLIENT_ID,
    iss: 'https://accounts.google.com',
    exp: Math.floor(AHORA.getTime() / 1000) + 600,
    nonce: NONCE,
    sub: '11223344',
    email: 'Clienta@Ejemplo.com',
    email_verified: true,
    name: 'Clienta Ejemplo',
    ...patch,
  };
}

test('un token correcto se acepta y normaliza el correo', () => {
  const r = validarClaims(claims(), { clientId: CLIENT_ID, nonceEsperado: NONCE, ahora: AHORA });
  assert.equal(r.ok, true);
  assert.equal(r.subject, '11223344');
  assert.equal(r.email, 'clienta@ejemplo.com');
  assert.equal(r.nombre, 'Clienta Ejemplo');
});

// Un token emitido para OTRA aplicación es perfectamente válido para Google.
// Si no se compara la audiencia, sirve para entrar acá.
test('un token para otra aplicación no entra', () => {
  const r = validarClaims(claims({ aud: 'otra-app.apps.googleusercontent.com' }),
    { clientId: CLIENT_ID, nonceEsperado: NONCE, ahora: AHORA });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'audiencia_incorrecta');
});

test('sin Client ID configurado ningún token entra', () => {
  const r = validarClaims(claims(), { clientId: '', nonceEsperado: NONCE, ahora: AHORA });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'audiencia_incorrecta');
});

test('emisor, vencimiento, nonce y correo sin verificar cierran la puerta', () => {
  const base = { clientId: CLIENT_ID, nonceEsperado: NONCE, ahora: AHORA };
  const casos = [
    [{ iss: 'https://accounts.example.com' }, 'emisor_incorrecto'],
    [{ exp: Math.floor(AHORA.getTime() / 1000) - 1 }, 'vencido'],
    [{ exp: 'no-es-numero' }, 'vencido'],
    [{ nonce: 'otro'.padEnd(43, 'x') }, 'nonce_incorrecto'],
    [{ email_verified: false }, 'email_sin_verificar'],
    [{ sub: '' }, 'sin_subject'],
    [{ email: '' }, 'sin_email'],
  ];
  for (const [patch, motivo] of casos) {
    const r = validarClaims(claims(patch), base);
    assert.equal(r.ok, false, `debería rechazar ${motivo}`);
    assert.equal(r.motivo, motivo);
  }
  assert.equal(validarClaims(null, base).motivo, 'sin_claims');
});

test('los dos emisores que usa Google se aceptan', () => {
  for (const iss of ['accounts.google.com', 'https://accounts.google.com']) {
    assert.equal(validarClaims(claims({ iss }), { clientId: CLIENT_ID, nonceEsperado: NONCE, ahora: AHORA }).ok, true);
  }
});

test('sin nonce esperado no se acepta ningún token', () => {
  const r = validarClaims(claims(), { clientId: CLIENT_ID, nonceEsperado: null, ahora: AHORA });
  assert.equal(r.motivo, 'nonce_incorrecto');
});

// ─── Cookies ─────────────────────────────────────────────────────────────────

test('la cookie de sesión es __Host-, HttpOnly y Secure; la de CSRF es legible', () => {
  const sesion = construirCookie(COOKIE_SESION, 'a'.repeat(43), { maxAgeSegundos: 60 });
  assert.ok(COOKIE_SESION.startsWith('__Host-'));
  for (const d of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.match(sesion, new RegExp(d.replace('/', '\\/')));

  const csrf = construirCookie(COOKIE_CSRF, 'b'.repeat(43), { maxAgeSegundos: 60, httpOnly: false });
  assert.doesNotMatch(csrf, /HttpOnly/, 'el JS del sitio tiene que poder leerla para reenviarla');
  assert.match(csrf, /Secure/);
});

test('sólo se lee una cookie con forma de secreto', () => {
  const valor = 'c'.repeat(43);
  assert.equal(leerCookie(`x=1; ${COOKIE_SESION}=${valor}`, COOKIE_SESION), valor);
  assert.equal(leerCookie(`${COOKIE_SESION}=corto`, COOKIE_SESION), null);
  assert.equal(leerCookie('x=1', COOKIE_SESION), null);
});

test('el secreto guardado es el hash, no el secreto', async () => {
  const s = generarSecreto();
  assert.ok(pareceSecreto(s));
  const h = await hashSecreto(s);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.notEqual(h, s);
});

// ─── Perfil ──────────────────────────────────────────────────────────────────

test('el perfil acepta sólo los campos de la lista y recorta espacios', () => {
  const { perfil } = normalizarPerfil({
    buyer_name: '  Ana   Pérez ', buyer_phone: '099 111 222',
    address: 'Rincón 608', locality: 'Ciudad Vieja', department: 'Montevideo',
    saldo: 999999, identity_id: 'ajeno',
  });
  assert.equal(perfil.buyer_name, 'Ana Pérez');
  assert.deepEqual(Object.keys(perfil).sort(), [...CAMPOS_PERFIL].sort());
  assert.equal(perfil.saldo, undefined, 'un campo fuera de la lista no entra');
  assert.equal(perfil.identity_id, undefined, 'ni siquiera para elegir de quién es el perfil');
});

test('un perfil vacío o desmedido se rechaza', () => {
  assert.match(normalizarPerfil({}).error, /ningún dato/);
  assert.match(normalizarPerfil({ buyer_name: '   ' }).error, /ningún dato/);
  assert.match(normalizarPerfil({ address: 'x'.repeat(201) }).error, /demasiado largo/);
});

// ─── La regla que impide pisar lo escrito ────────────────────────────────────

test('sólo se completan campos vacíos y no tocados', () => {
  const perfil = {
    buyer_name: 'Ana Pérez', buyer_phone: '099111222',
    address: 'Rincón 608', locality: 'Ciudad Vieja', department: 'Montevideo',
  };
  const aCompletar = camposACompletar({
    perfil,
    valoresActuales: { buyer_name: 'Otro Nombre', buyer_phone: '', address: '   ', locality: '', department: '' },
    tocados: ['locality'],
  });
  assert.equal(aCompletar.buyer_name, undefined, 'no pisa lo que ya estaba escrito');
  assert.equal(aCompletar.locality, undefined, 'no pisa un campo que la persona tocó');
  assert.equal(aCompletar.buyer_phone, '099111222');
  assert.equal(aCompletar.address, 'Rincón 608', 'un campo con sólo espacios cuenta como vacío');
  assert.equal(aCompletar.department, 'Montevideo');
});

// Éste es el caso que pide el encargo: la respuesta llega tarde y la persona
// ya escribió mientras esperaba.
test('una respuesta tardía no sobrescribe lo que se escribió mientras llegaba', () => {
  const perfil = { buyer_name: 'Ana Pérez', buyer_phone: '099111222' };
  // Al pedir los datos ambos campos estaban vacíos; para cuando llegó la
  // respuesta la persona ya había escrito el teléfono.
  const aCompletar = camposACompletar({
    perfil,
    valoresActuales: { buyer_name: '', buyer_phone: '098765432' },
    tocados: ['buyer_phone'],
  });
  assert.deepEqual(aCompletar, { buyer_name: 'Ana Pérez' });
});

test('sin perfil guardado no se completa nada', () => {
  assert.deepEqual(camposACompletar({ perfil: null, valoresActuales: {} }), {});
});
