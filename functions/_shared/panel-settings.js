/**
 * functions/_shared/panel-settings.js
 *
 * Los datos de retiro que carga el equipo desde /panel/ajustes y que después
 * salen en el correo que recibe el cliente.
 *
 * Vive aparte de panel-data.js a propósito: ese módulo es solo-lectura y tiene
 * un test que falla si alguna de sus consultas escribe. Acá sí se escribe, pero
 * SÓLO en KV y SÓLO estos cuatro campos. Ni pedidos, ni catálogo, ni Mercado
 * Libre: nada de eso se toca desde el panel.
 *
 * Estos valores terminan en un correo a un cliente, así que se recortan y se
 * limpian antes de guardarse. Un salto de línea es legítimo en los horarios;
 * cualquier otro carácter de control no.
 */

const PICKUP_KEY = 'panel:pickup';

const LIMITS = { address: 160, zone: 120, hours: 240 };
const HOLD_DAYS_MIN = 1;
const HOLD_DAYS_MAX = 90;
const HOLD_DAYS_DEFAULT = 15;

export const PICKUP_EMPTY = Object.freeze({
  address: '', zone: '', hours: '', holdDays: HOLD_DAYS_DEFAULT,
});

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    // Se quitan los caracteres de control salvo el salto de linea:
    // los horarios se escriben en varias lineas y eso es legitimo.
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

function cleanHoldDays(value) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return HOLD_DAYS_DEFAULT;
  return Math.min(HOLD_DAYS_MAX, Math.max(HOLD_DAYS_MIN, number));
}

export function normalizePickup(input) {
  return {
    address: cleanText(input?.address, LIMITS.address),
    zone: cleanText(input?.zone, LIMITS.zone),
    hours: cleanText(input?.hours, LIMITS.hours),
    holdDays: cleanHoldDays(input?.holdDays),
  };
}

/**
 * Un correo de retiro sin dirección, barrio u horarios es un cliente llamando
 * por teléfono. Mientras esto sea falso, ese aviso no se manda.
 */
export function pickupComplete(pickup) {
  return Boolean(pickup?.address && pickup?.zone && pickup?.hours);
}

export async function loadPickup(env) {
  const kv = env?.AMADO_KV;
  if (!kv || typeof kv.get !== 'function') return { ...PICKUP_EMPTY };
  try {
    const raw = await kv.get(PICKUP_KEY);
    if (!raw) return { ...PICKUP_EMPTY };
    return normalizePickup(JSON.parse(raw));
  } catch {
    // Un valor ilegible se trata como vacío: el panel muestra el formulario
    // en blanco y avisa que falta cargarlo, en vez de romper la página.
    return { ...PICKUP_EMPTY };
  }
}

export async function savePickup(env, input) {
  const kv = env?.AMADO_KV;
  const pickup = normalizePickup(input);
  if (!kv || typeof kv.put !== 'function') {
    return { ok: false, pickup, error: 'AMADO_KV no está disponible en este entorno.' };
  }
  try {
    await kv.put(PICKUP_KEY, JSON.stringify(pickup));
    return { ok: true, pickup };
  } catch (error) {
    return { ok: false, pickup, error: String(error?.message || error || 'error desconocido') };
  }
}
