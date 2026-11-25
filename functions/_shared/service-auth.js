// Firma entre el Worker de sincronización y Pages para la conciliación de pagos.
//
// El Worker firma "<marca de tiempo>.POST.<ruta>" con HMAC-SHA256 y la clave
// compartida RECONCILE_SECRET; Pages recalcula y compara. La firma vale unos
// minutos, así que un llamado copiado no sirve más tarde. La clave nunca viaja.

export const SIGNATURE_HEADER = 'X-Amado-Signature';
export const TIMESTAMP_HEADER = 'X-Amado-Timestamp';
export const MAX_AGE_MS = 5 * 60 * 1000;
export const MAX_FUTURE_MS = 60 * 1000;

const encoder = new TextEncoder();

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function importKey(secret, usages) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

function message(timestamp, method, path) {
  return `${timestamp}.${method}.${path}`;
}

export async function signServiceRequest(secret, { method, path, now = Date.now() }) {
  const timestamp = String(now);
  const key = await importKey(secret, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message(timestamp, method, path)));
  return { [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: toHex(signature) };
}

/** true sólo si la firma es válida y reciente. Nunca lanza. */
export async function verifyServiceRequest(secret, { method, path, headers, now = Date.now() }) {
  try {
    if (typeof secret !== 'string' || secret.length < 16) return false;
    const timestamp = headers.get(TIMESTAMP_HEADER);
    const signature = fromHex(headers.get(SIGNATURE_HEADER));
    if (!signature || !/^\d{10,15}$/.test(timestamp || '')) return false;
    const age = now - Number(timestamp);
    if (age > MAX_AGE_MS || age < -MAX_FUTURE_MS) return false;
    const key = await importKey(secret, ['verify']);
    return await crypto.subtle.verify('HMAC', key, signature, encoder.encode(message(timestamp, method, path)));
  } catch {
    return false;
  }
}
