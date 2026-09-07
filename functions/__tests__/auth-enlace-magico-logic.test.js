import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COOKIE_NAME,
  construirCookie,
  construirCorreoDeIngreso,
  construirEnlace,
  cookieDeBorrado,
  generarSecreto,
  hashSecreto,
  leerCookieDeSesion,
  normalizeEmail,
  pareceSecreto,
  pedidoPublico,
  sesionUtilizable,
  tokenUtilizable,
  vencimiento,
} from '../api/_auth_logic.js';

const AHORA = new Date('2026-09-07T12:00:00.000Z');

test('normaliza el correo y rechaza lo que no lo es', () => {
  assert.equal(normalizeEmail('  Seba@Ejemplo.COM '), 'seba@ejemplo.com');
  for (const malo of ['', 'sin-arroba', 'a@b', null, 42, `${'a'.repeat(250)}@b.com`]) {
    assert.equal(normalizeEmail(malo), null, `debería rechazar: ${String(malo).slice(0, 20)}`);
  }
});

test('el secreto tiene 256 bits y forma reconocible', () => {
  const secreto = generarSecreto();
  assert.ok(pareceSecreto(secreto), secreto);
  assert.notEqual(secreto, generarSecreto(), 'dos secretos seguidos no pueden coincidir');
  for (const malo of ['corto', `${'a'.repeat(43)}!`, '', null]) assert.equal(pareceSecreto(malo), false);
});

test('se guarda el hash y nunca el secreto', async () => {
  const secreto = generarSecreto();
  const hash = await hashSecreto(secreto);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, secreto);
  assert.equal(hash, await hashSecreto(secreto), 'mismo secreto, mismo hash');
  assert.notEqual(hash, await hashSecreto(generarSecreto()));
});

// Si el enlace se armara con el Host de la petición, alguien podría pedir un
// enlace con Host falso y recibiría la víctima, en su correo, una URL que
// apunta al servidor del atacante.
test('el enlace sale del origen canónico, no de un host arbitrario', () => {
  const enlace = construirEnlace('https://www.amadolibros.com', 'a'.repeat(43));
  assert.ok(enlace.startsWith('https://www.amadolibros.com/ingresar?t='), enlace);
  assert.equal(new URL(enlace).hostname, 'www.amadolibros.com');
});

test('la cookie de sesión lleva todas las defensas', () => {
  const cookie = construirCookie('b'.repeat(43), { maxAgeSegundos: 100 });
  assert.ok(cookie.startsWith(`${COOKIE_NAME}=`));
  assert.ok(COOKIE_NAME.startsWith('__Host-'), 'el prefijo __Host- impide que un subdominio la fije');
  for (const defensa of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=100']) {
    assert.match(cookie, new RegExp(defensa.replace('/', '\\/')), `falta ${defensa}`);
  }
  assert.match(cookieDeBorrado(), /Max-Age=0/);
});

test('sólo se lee una cookie de sesión con forma válida', () => {
  const secreto = 'c'.repeat(43);
  assert.equal(leerCookieDeSesion(`otra=1; ${COOKIE_NAME}=${secreto}; mas=2`), secreto);
  assert.equal(leerCookieDeSesion(`${COOKIE_NAME}=corto`), null, 'un valor deforme no se acepta');
  assert.equal(leerCookieDeSesion('otra=1'), null);
  assert.equal(leerCookieDeSesion(null), null);
});

test('un token sirve una sola vez, vigente y existente', () => {
  const vigente = { email: 'a@b.com', expires_at: '2026-09-07T12:10:00.000Z', used_at: null };
  assert.deepEqual(tokenUtilizable(vigente, AHORA), { ok: true, email: 'a@b.com' });
  assert.equal(tokenUtilizable({ ...vigente, used_at: '2026-09-07T12:01:00.000Z' }, AHORA).motivo, 'ya_usado');
  assert.equal(tokenUtilizable({ ...vigente, expires_at: '2026-09-07T11:59:00.000Z' }, AHORA).motivo, 'vencido');
  assert.equal(tokenUtilizable(null, AHORA).motivo, 'inexistente');
  assert.equal(tokenUtilizable({ ...vigente, expires_at: 'basura' }, AHORA).ok, false);
});

test('una sesión revocada o vencida deja de servir', () => {
  const viva = { email: 'a@b.com', expires_at: '2026-10-07T12:00:00.000Z', revoked_at: null };
  assert.equal(sesionUtilizable(viva, AHORA).ok, true);
  assert.equal(sesionUtilizable({ ...viva, revoked_at: '2026-09-07T11:00:00.000Z' }, AHORA).motivo, 'revocada');
  assert.equal(sesionUtilizable({ ...viva, expires_at: '2026-09-06T12:00:00.000Z' }, AHORA).motivo, 'vencida');
});

test('el vencimiento se calcula sobre el instante recibido', () => {
  assert.equal(vencimiento(AHORA, 15).toISOString(), '2026-09-07T12:15:00.000Z');
});

// El comprador ve su pedido, no la fila entera: nada de huellas, claves de
// idempotencia ni identificadores internos de pago.
test('el pedido público no filtra campos internos', () => {
  const publico = pedidoPublico({
    id: 'ord_1', public_code: 'AL-123', status: 'paid', payment_status: 'approved',
    delivery_type: 'pickup', payable_total_uyu: 990, currency: 'UYU',
    created_at: '2026-09-01T10:00:00.000Z',
    idempotency_key: 'SECRETO', request_fingerprint: 'HUELLA', buyer_phone: '099', buyer_email: 'a@b.com',
  }, [{ title: 'Rayuela', quantity: 1, unit_price_uyu: 990, line_total_uyu: 990 }]);

  const serializado = JSON.stringify(publico);
  for (const interno of ['SECRETO', 'HUELLA', 'ord_1', '099', 'a@b.com']) {
    assert.doesNotMatch(serializado, new RegExp(interno), `no debe exponer ${interno}`);
  }
  assert.equal(publico.codigo, 'AL-123');
  assert.equal(publico.articulos[0].titulo, 'Rayuela');
});

test('el correo dice que el enlace vence y que sirve una sola vez', () => {
  const correo = construirCorreoDeIngreso({ enlace: 'https://www.amadolibros.com/ingresar?t=x' });
  assert.match(correo.text, /una sola vez/);
  assert.match(correo.text, /15 minutos/);
  assert.match(correo.text, /Si no lo pediste/);
  assert.match(correo.html, /href="https:\/\/www\.amadolibros\.com\/ingresar\?t=x"/);
});
