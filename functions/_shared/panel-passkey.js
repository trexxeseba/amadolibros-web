/**
 * functions/_shared/panel-passkey.js
 *
 * Entrar al panel con Windows Hello (o la huella del celular): llaves de acceso
 * WebAuthn. Seba, Gaby y Lola registran cada equipo una vez desde Ajustes, con
 * la sesión ya abierta. Después el panel pide solo el PIN o la huella de
 * Windows, sin contraseña ni captcha.
 *
 * Qué se guarda: por cada equipo, el id de la llave y su llave pública (SPKI),
 * en AMADO_KV. La llave privada nunca sale del equipo. Sin la llave pública
 * guardada acá no se entra, y para guardar una hay que estar adentro.
 *
 * Qué se verifica al entrar (WebAuthn nivel 2, sin atestación):
 *  - el desafío es uno que emitimos nosotros, de un solo uso y de 5 minutos;
 *  - el origen es el del panel y el rpIdHash corresponde a este dominio;
 *  - el equipo verificó a la persona (bandera UV: PIN, huella o cara);
 *  - la firma sobre authenticatorData + SHA-256(clientDataJSON) es válida con la
 *    llave pública registrada.
 */

const PASSKEYS_KEY = 'panel_passkeys';
const CHALLENGE_PREFIX = 'panel_passkey_chal:';
const CHALLENGE_TTL_SECONDS = 300;
const MAX_PASSKEYS = 20;
const ALG_ES256 = -7;
const ALG_RS256 = -257;
const SUPPORTED_ALGS = [ALG_ES256, ALG_RS256];
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;

export function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(text) {
  const clean = typeof text === 'string' ? text.trim() : '';
  if (!/^[A-Za-z0-9_-]*$/.test(clean)) throw new Error('base64url_invalido');
  const padded = clean.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((clean.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

async function sha256(bytes, cryptoImpl = globalThis.crypto) {
  return new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes));
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Las firmas ECDSA de WebAuthn vienen en DER (SEQUENCE de dos INTEGER); WebCrypto
 * espera r||s de 32 bytes cada uno.
 */
export function ecdsaDerToRaw(der, size = 32) {
  const bytes = new Uint8Array(der);
  if (bytes[0] !== 0x30) throw new Error('firma_der_invalida');
  let offset = 2;
  if (bytes[1] & 0x80) offset = 2 + (bytes[1] & 0x7f);
  const readInt = () => {
    if (bytes[offset] !== 0x02) throw new Error('firma_der_invalida');
    const length = bytes[offset + 1];
    let value = bytes.slice(offset + 2, offset + 2 + length);
    offset += 2 + length;
    while (value.length > size && value[0] === 0) value = value.slice(1);
    if (value.length > size) throw new Error('firma_der_invalida');
    const out = new Uint8Array(size);
    out.set(value, size - value.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  return concat(r, s);
}

function importParams(alg) {
  if (alg === ALG_ES256) return { name: 'ECDSA', namedCurve: 'P-256' };
  if (alg === ALG_RS256) return { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  throw new Error('algoritmo_no_soportado');
}

function verifyParams(alg) {
  if (alg === ALG_ES256) return { name: 'ECDSA', hash: 'SHA-256' };
  return { name: 'RSASSA-PKCS1-v1_5' };
}

async function importPublicKey(spki, alg, cryptoImpl) {
  return cryptoImpl.subtle.importKey('spki', spki, importParams(alg), false, ['verify']);
}

// ---------------------------------------------------------------------------
// Desafíos de un solo uso en KV
// ---------------------------------------------------------------------------

export async function issueChallenge(kv, purpose, { crypto: cryptoImpl = globalThis.crypto } = {}) {
  if (!kv || typeof kv.put !== 'function') throw new Error('kv_no_disponible');
  const challenge = base64UrlEncode(cryptoImpl.getRandomValues(new Uint8Array(32)));
  await kv.put(CHALLENGE_PREFIX + challenge, purpose, { expirationTtl: CHALLENGE_TTL_SECONDS });
  return challenge;
}

async function consumeChallenge(kv, challenge, purpose) {
  if (!kv || !/^[A-Za-z0-9_-]{20,100}$/.test(challenge || '')) return false;
  const key = CHALLENGE_PREFIX + challenge;
  const stored = await kv.get(key);
  if (stored === null || stored === undefined) return false;
  await kv.delete(key);
  return stored === purpose;
}

// ---------------------------------------------------------------------------
// Equipos registrados
// ---------------------------------------------------------------------------

export async function listPasskeys(kv) {
  if (!kv || typeof kv.get !== 'function') return [];
  try {
    const raw = await kv.get(PASSKEYS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(p => p && typeof p.id === 'string' && typeof p.spki === 'string') : [];
  } catch {
    return [];
  }
}

async function savePasskeys(kv, list) {
  await kv.put(PASSKEYS_KEY, JSON.stringify(list));
}

export async function removePasskey(kv, id) {
  const list = await listPasskeys(kv);
  const next = list.filter(p => p.id !== id);
  if (next.length !== list.length) await savePasskeys(kv, next);
  return next.length !== list.length;
}

// ---------------------------------------------------------------------------
// Verificaciones
// ---------------------------------------------------------------------------

function parseClientData(clientDataBytes) {
  try {
    return JSON.parse(new TextDecoder().decode(clientDataBytes));
  } catch {
    return null;
  }
}

async function checkAuthenticatorData(authData, rpId, cryptoImpl) {
  if (authData.length < 37) return 'authenticator_data_corto';
  const expectedRpHash = await sha256(new TextEncoder().encode(rpId), cryptoImpl);
  if (!sameBytes(authData.slice(0, 32), expectedRpHash)) return 'rp_id_distinto';
  const flags = authData[32];
  if (!(flags & FLAG_USER_PRESENT)) return 'sin_presencia';
  if (!(flags & FLAG_USER_VERIFIED)) return 'sin_verificacion';
  return null;
}

async function checkClientData(clientDataBytes, { type, origin, kv, purpose }) {
  const clientData = parseClientData(clientDataBytes);
  if (!clientData) return 'client_data_invalido';
  if (clientData.type !== type) return 'tipo_distinto';
  if (clientData.origin !== origin) return 'origen_distinto';
  if (!(await consumeChallenge(kv, clientData.challenge, purpose))) return 'desafio_invalido';
  return null;
}

/**
 * Alta de un equipo. La llama una ruta que ya exige sesión abierta: lo que
 * prueba esta función es que la llave la creó este navegador, en este dominio,
 * para el desafío que acabamos de dar, con la persona verificada.
 */
export async function registerPasskey(kv, body, { origin, rpId, crypto: cryptoImpl = globalThis.crypto } = {}) {
  try {
    const nombre = String(body?.nombre ?? '').trim().slice(0, 60) || 'Equipo sin nombre';
    const id = String(body?.id ?? '');
    const alg = Number(body?.alg);
    if (!/^[A-Za-z0-9_-]{16,1400}$/.test(id)) return { ok: false, error: 'id_invalido' };
    if (!SUPPORTED_ALGS.includes(alg)) return { ok: false, error: 'algoritmo_no_soportado' };

    const clientData = base64UrlDecode(body?.clientDataJSON);
    const authData = base64UrlDecode(body?.authenticatorData);
    const spki = base64UrlDecode(body?.publicKey);

    const clientError = await checkClientData(clientData, { type: 'webauthn.create', origin, kv, purpose: 'registro' });
    if (clientError) return { ok: false, error: clientError };
    const authError = await checkAuthenticatorData(authData, rpId, cryptoImpl);
    if (authError) return { ok: false, error: authError };
    await importPublicKey(spki, alg, cryptoImpl); // falla si la llave no es válida

    const list = await listPasskeys(kv);
    if (list.some(p => p.id === id)) return { ok: true, passkey: list.find(p => p.id === id) };
    if (list.length >= MAX_PASSKEYS) return { ok: false, error: 'demasiados_equipos' };
    const passkey = { id, spki: base64UrlEncode(spki), alg, nombre, creado: new Date().toISOString() };
    await savePasskeys(kv, [...list, passkey]);
    return { ok: true, passkey };
  } catch {
    return { ok: false, error: 'datos_invalidos' };
  }
}

/** Entrada con un equipo ya registrado. */
export async function verifyPasskeyLogin(kv, body, { origin, rpId, crypto: cryptoImpl = globalThis.crypto } = {}) {
  try {
    const id = String(body?.id ?? '');
    const list = await listPasskeys(kv);
    const passkey = list.find(p => p.id === id);
    if (!passkey) return { ok: false, error: 'equipo_no_registrado' };

    const clientData = base64UrlDecode(body?.clientDataJSON);
    const authData = base64UrlDecode(body?.authenticatorData);
    let signature = base64UrlDecode(body?.signature);

    const clientError = await checkClientData(clientData, { type: 'webauthn.get', origin, kv, purpose: 'entrada' });
    if (clientError) return { ok: false, error: clientError };
    const authError = await checkAuthenticatorData(authData, rpId, cryptoImpl);
    if (authError) return { ok: false, error: authError };

    if (passkey.alg === ALG_ES256) signature = ecdsaDerToRaw(signature);
    const key = await importPublicKey(base64UrlDecode(passkey.spki), passkey.alg, cryptoImpl);
    const signed = concat(authData, await sha256(clientData, cryptoImpl));
    const valid = await cryptoImpl.subtle.verify(verifyParams(passkey.alg), key, signature, signed);
    if (!valid) return { ok: false, error: 'firma_invalida' };
    return { ok: true, passkey };
  } catch {
    return { ok: false, error: 'datos_invalidos' };
  }
}

export const PANEL_PASSKEY_CONSTANTS = Object.freeze({
  PASSKEYS_KEY,
  CHALLENGE_PREFIX,
  CHALLENGE_TTL_SECONDS,
  MAX_PASSKEYS,
  SUPPORTED_ALGS,
});
