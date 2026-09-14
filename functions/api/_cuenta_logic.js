// Lógica pura de la cuenta opcional del comprador. Sin red, sin base y sin
// reloj propio: todo lo que decide se prueba sin levantar nada.
//
// Alcance: identificarse con Google es opcional y sólo sirve para traer los
// datos que el cliente decidió guardar. No toca precios, envío, stock,
// idempotencia, Mercado Pago ni los correos de compra.

export const SESSION_TTL_DAYS = 30;
export const NONCE_TTL_MINUTES = 10;
export const MAX_BODY_BYTES = 8 * 1024;

// __Host- obliga a Secure, Path=/ y sin Domain: un subdominio no puede
// fijarle la cookie al sitio.
export const COOKIE_SESION = '__Host-al_cuenta';
// La de CSRF se lee desde JS a propósito (doble envío), así que NO es HttpOnly.
// No es una credencial por sí sola: sin la cookie de sesión no autoriza nada.
export const COOKIE_CSRF = '__Host-al_csrf';

export const GOOGLE_ISSUERS = Object.freeze(['accounts.google.com', 'https://accounts.google.com']);

// Lista explícita de campos del perfil. Cualquier cosa fuera de acá no se lee
// ni se escribe, venga de donde venga.
export const CAMPOS_PERFIL = Object.freeze([
  'buyer_name', 'buyer_phone', 'address', 'locality', 'department',
]);

export const LIMITES_PERFIL = Object.freeze({
  buyer_name: 120, buyer_phone: 40, address: 200, locality: 120, department: 60,
});

function limpiar(valor) {
  return String(valor ?? '').replace(/\s+/g, ' ').trim();
}

function base64url(bytes) {
  let binario = '';
  for (const byte of bytes) binario += String.fromCharCode(byte);
  return btoa(binario).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generarSecreto(getRandomValues = crypto.getRandomValues.bind(crypto)) {
  return base64url(getRandomValues(new Uint8Array(32)));
}

export async function hashSecreto(secreto, subtle = crypto.subtle) {
  const datos = new TextEncoder().encode(String(secreto));
  const digest = await subtle.digest('SHA-256', datos);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function pareceSecreto(valor) {
  return typeof valor === 'string' && /^[A-Za-z0-9_-]{43}$/.test(valor);
}

export function vencimiento(desde, minutos) {
  return new Date(desde.getTime() + minutos * 60_000);
}

export function estaVencido(expiresAt, ahora) {
  const limite = Date.parse(expiresAt);
  return !Number.isFinite(limite) || limite <= ahora.getTime();
}

export function construirCookie(nombre, valor, { maxAgeSegundos, httpOnly = true }) {
  return [
    `${nombre}=${valor}`,
    'Path=/',
    httpOnly ? 'HttpOnly' : null,
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSegundos}`,
  ].filter(Boolean).join('; ');
}

export function cookieDeBorrado(nombre, { httpOnly = true } = {}) {
  return construirCookie(nombre, '', { maxAgeSegundos: 0, httpOnly });
}

export function leerCookie(cabecera, nombre) {
  if (typeof cabecera !== 'string' || !cabecera) return null;
  for (const parte of cabecera.split(';')) {
    const corte = parte.indexOf('=');
    if (corte === -1) continue;
    if (parte.slice(0, corte).trim() !== nombre) continue;
    const valor = parte.slice(corte + 1).trim();
    return pareceSecreto(valor) ? valor : null;
  }
  return null;
}

// ─── Validación del ID token de Google ───────────────────────────────────────
//
// La firma y el vencimiento los verifica Google; acá se comprueba todo lo que
// además tiene que cumplirse para que ese token sea PARA ESTE SITIO y para
// ESTE ingreso. Sin estas comprobaciones, un token legítimo emitido para otra
// aplicación serviría para entrar acá.

export function validarClaims(claims, { clientId, nonceEsperado, ahora }) {
  if (!claims || typeof claims !== 'object') return { ok: false, motivo: 'sin_claims' };

  const aud = limpiar(claims.aud);
  if (!clientId || aud !== clientId) return { ok: false, motivo: 'audiencia_incorrecta' };

  if (!GOOGLE_ISSUERS.includes(limpiar(claims.iss))) return { ok: false, motivo: 'emisor_incorrecto' };

  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || exp * 1000 <= ahora.getTime()) return { ok: false, motivo: 'vencido' };

  // El nonce lo emitió este servidor y se consume una sola vez: sin esto, un
  // token capturado se podría reenviar.
  if (!nonceEsperado || limpiar(claims.nonce) !== nonceEsperado) return { ok: false, motivo: 'nonce_incorrecto' };

  const subject = limpiar(claims.sub);
  if (!subject) return { ok: false, motivo: 'sin_subject' };

  const email = limpiar(claims.email).toLowerCase();
  if (!email) return { ok: false, motivo: 'sin_email' };
  // Google marca los correos no verificados; no se aceptan como identidad.
  if (claims.email_verified !== true && claims.email_verified !== 'true') {
    return { ok: false, motivo: 'email_sin_verificar' };
  }

  return { ok: true, subject, email, nombre: limpiar(claims.name) || null };
}

// ─── Perfil ──────────────────────────────────────────────────────────────────

export function normalizarPerfil(entrada) {
  const perfil = {};
  for (const campo of CAMPOS_PERFIL) {
    const valor = limpiar(entrada?.[campo]);
    if (!valor) { perfil[campo] = null; continue; }
    if (valor.length > LIMITES_PERFIL[campo]) return { error: `El campo ${campo} es demasiado largo.` };
    perfil[campo] = valor;
  }
  const alguno = CAMPOS_PERFIL.some(campo => perfil[campo]);
  if (!alguno) return { error: 'No hay ningún dato para guardar.' };
  return { perfil };
}

export function perfilPublico(fila) {
  if (!fila) return null;
  const perfil = {};
  for (const campo of CAMPOS_PERFIL) perfil[campo] = fila[campo] ?? null;
  return perfil;
}

// ─── La regla que impide pisar lo que el cliente escribió ────────────────────
//
// Se completa un campo SÓLO si sigue vacío y el cliente no lo tocó desde que
// pidió sus datos. Así una respuesta que llega tarde no borra lo que estuvo
// escribiendo mientras esperaba.

export function camposACompletar({ perfil, valoresActuales, tocados = [] }) {
  const tocadosSet = new Set(tocados);
  const aCompletar = {};
  for (const campo of CAMPOS_PERFIL) {
    const guardado = perfil?.[campo];
    if (!guardado) continue;
    if (tocadosSet.has(campo)) continue;
    if (limpiar(valoresActuales?.[campo])) continue;
    aCompletar[campo] = guardado;
  }
  return aCompletar;
}
