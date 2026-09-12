/**
 * functions/_shared/panel-auth.js
 *
 * PANEL-BACKEND-1 — autenticación del panel interno (/panel).
 *
 * El panel muestra pedidos con datos del comprador, así que la regla de oro es
 * FALLAR CERRADO: sin PANEL_PASSWORD el panel no se sirve, nunca queda abierto
 * "porque todavía no lo configuraron".
 *
 * Una sola clave para configurar. La llave que firma las sesiones no es un
 * segundo secret a cargar a mano: se deriva de la contraseña con HMAC sobre una
 * etiqueta fija. Quien tiene la contraseña ya entra al panel, así que derivarla
 * no debilita nada, y de yapa cambiar la contraseña invalida al instante todas
 * las sesiones abiertas.
 *
 * La sesión es una cookie firmada con HMAC-SHA256 sobre el instante de
 * expiración. No guarda identidad ni datos del comprador: solo prueba que
 * alguien pasó por el login antes de esa fecha. No hay estado en D1/KV que
 * mantener ni invalidar.
 *
 * La comparación de la contraseña y de la firma es de tiempo constante: una
 * comparación con === corta en el primer byte distinto y filtra, medición a
 * medición, cuántos caracteres acertó quien está probando.
 */

const SESSION_COOKIE_NAME = 'amado_panel_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const TOKEN_VERSION = 'v1';
const SESSION_KEY_LABEL = 'amado-panel-session-key-v1';

// Freno de fuerza bruta: una contraseña compartida es adivinable a fuerza de
// intentos, y el login es público. Se cuenta por IP en KV.
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_ATTEMPTS_PREFIX = 'panel_login_fail:';

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolvePanelConfig(env) {
  const password = cleanString(env?.PANEL_PASSWORD);
  // Una contraseña corta con Turnstile delante sigue siendo débil; se exige un
  // mínimo acá para que el panel no dependa de la disciplina de quien la cargue.
  if (password.length < 12) return { ok: false };
  return { ok: true, password };
}

/**
 * Comparación de tiempo constante sobre los bytes UTF-8 de ambos valores.
 * Compara siempre la misma cantidad de posiciones, y la diferencia de longitud
 * se acumula en el mismo acumulador en vez de cortar temprano.
 */
export function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const left = encoder.encode(typeof a === 'string' ? a : '');
  const right = encoder.encode(typeof b === 'string' ? b : '');
  const length = Math.max(left.length, right.length, 1);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSignature(secret, message, cryptoImpl = globalThis.crypto) {
  const encoder = new TextEncoder();
  const key = await cryptoImpl.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await cryptoImpl.subtle.sign('HMAC', key, encoder.encode(message));
  return base64UrlEncode(new Uint8Array(signature));
}

/**
 * Llave de firma derivada de la contraseña. La etiqueta fija separa este uso de
 * cualquier otro que la contraseña pudiera tener: lo que firma las cookies no es
 * la contraseña en sí, sino HMAC(contraseña, etiqueta).
 */
export async function deriveSessionSecret(password, { crypto: cryptoImpl = globalThis.crypto } = {}) {
  return hmacSignature(cleanString(password), SESSION_KEY_LABEL, cryptoImpl);
}

export async function createSessionToken(sessionSecret, {
  now = Date.now(),
  ttlSeconds = SESSION_TTL_SECONDS,
  crypto: cryptoImpl = globalThis.crypto,
} = {}) {
  const expiresAt = Math.floor(now / 1000) + ttlSeconds;
  const payload = `${TOKEN_VERSION}.${expiresAt}`;
  const signature = await hmacSignature(sessionSecret, payload, cryptoImpl);
  return `${payload}.${signature}`;
}

export async function verifySessionToken(token, sessionSecret, {
  now = Date.now(),
  crypto: cryptoImpl = globalThis.crypto,
} = {}) {
  const raw = cleanString(token);
  if (!raw) return false;

  const parts = raw.split('.');
  if (parts.length !== 3) return false;

  const [version, expiresAtRaw, signature] = parts;
  if (version !== TOKEN_VERSION) return false;
  if (!/^\d{1,15}$/.test(expiresAtRaw)) return false;

  // La firma se valida SIEMPRE, incluso con el token vencido: así un token
  // expirado y uno falsificado cuestan lo mismo en tiempo de respuesta.
  const expected = await hmacSignature(sessionSecret, `${version}.${expiresAtRaw}`, cryptoImpl);
  const signatureValid = timingSafeEqual(signature, expected);
  const notExpired = Number(expiresAtRaw) > Math.floor(now / 1000);
  return signatureValid && notExpired;
}

export function parseCookies(cookieHeader) {
  const jar = new Map();
  for (const chunk of cleanString(cookieHeader).split(';')) {
    const separator = chunk.indexOf('=');
    if (separator < 1) continue;
    const name = chunk.slice(0, separator).trim();
    const value = chunk.slice(separator + 1).trim();
    if (name && !jar.has(name)) jar.set(name, value);
  }
  return jar;
}

export function sessionCookieHeader(token, { ttlSeconds = SESSION_TTL_SECONDS } = {}) {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/panel',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${ttlSeconds}`,
  ].join('; ');
}

export function clearedSessionCookieHeader() {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/panel',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Max-Age=0',
  ].join('; ');
}

export function sessionTokenFromRequest(request) {
  return parseCookies(request?.headers?.get?.('cookie')).get(SESSION_COOKIE_NAME) || '';
}

export async function hasValidSession(request, sessionSecret, options = {}) {
  return verifySessionToken(sessionTokenFromRequest(request), sessionSecret, options);
}

/**
 * El límite de intentos es defensa en profundidad, no el control de acceso: si
 * KV no responde se deja pasar el intento (la contraseña sigue siendo
 * obligatoria) en vez de dejar afuera al dueño por una falla de KV.
 */
export async function loginAttemptsExceeded(kv, ip) {
  const key = LOGIN_ATTEMPTS_PREFIX + cleanString(ip);
  if (!kv || typeof kv.get !== 'function' || !cleanString(ip)) return false;
  try {
    const current = Number(await kv.get(key));
    return Number.isFinite(current) && current >= LOGIN_MAX_ATTEMPTS;
  } catch {
    return false;
  }
}

export async function recordFailedLogin(kv, ip) {
  const key = LOGIN_ATTEMPTS_PREFIX + cleanString(ip);
  if (!kv || typeof kv.put !== 'function' || !cleanString(ip)) return;
  try {
    const current = Number(await kv.get(key));
    const next = (Number.isFinite(current) ? current : 0) + 1;
    await kv.put(key, String(next), { expirationTtl: LOGIN_WINDOW_SECONDS });
  } catch {
    // Un fallo de KV no puede romper el login ni filtrar nada al cliente.
  }
}

export async function clearFailedLogins(kv, ip) {
  const key = LOGIN_ATTEMPTS_PREFIX + cleanString(ip);
  if (!kv || typeof kv.delete !== 'function' || !cleanString(ip)) return;
  try {
    await kv.delete(key);
  } catch {
    // Idem: no puede romper un login que ya fue correcto.
  }
}

export const PANEL_AUTH_CONSTANTS = Object.freeze({
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_SECONDS,
});
