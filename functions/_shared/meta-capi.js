/**
 * functions/_shared/meta-capi.js
 *
 * Meta: Pixel (navegador) + API de conversiones (servidor), con el mismo
 * event_id en los dos lados para que Meta deduplique.
 *
 * Todo depende de META_TRACKING_ENABLED === 'true'. Sin eso, ni la
 * configuración pública ni el envío server-side existen: es el estado de
 * producción por defecto. Fuera de producción (APP_ENV distinto de
 * 'production') el servidor sólo envía con META_TEST_EVENT_CODE: un Preview
 * nunca manda eventos reales al Pixel aunque tenga el token productivo.
 *
 * Datos personales: email y teléfono salen únicamente como SHA-256 de su
 * forma normalizada. No se envía la IP. El token (META_CAPI_TOKEN) viaja en
 * el cuerpo del POST, nunca en la URL, y no se registra en ningún log: los
 * errores se devuelven como un código corto.
 */

export const META_GRAPH_VERSION = 'v21.0';
const GRAPH_ORIGIN = 'https://graph.facebook.com';
const REQUEST_TIMEOUT_MS = 5000;

/** Eventos que el navegador puede pedir que se reenvíen por CAPI. Purchase no:
 *  la compra la manda solamente el servidor, desde el pago confirmado. */
export const BROWSER_CAPI_EVENTS = new Set(['PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout', 'Contact']);

/** Eventos que no necesitan productos (custom_data opcional). */
export const EVENTS_WITHOUT_ITEMS = new Set(['PageView', 'Contact']);

/**
 * Parámetros de URL que sí pueden llegar a Meta: campaña y clic de anuncio.
 * Todo lo demás (búsquedas, códigos de pedido, cualquier cosa que alguien
 * pegue en la URL) se descarta antes de enviar.
 */
export const ALLOWED_URL_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'fbclid', 'gclid',
]);

const PRODUCT_ID_RE = /^MLU\d{6,15}$/i;
const EVENT_ID_RE = /^[A-Za-z0-9_.:-]{8,100}$/;
const FBP_RE = /^fb\.\d\.\d{10,16}\.\d{1,20}$/;
const FBC_RE = /^fb\.\d\.\d{10,16}\.[A-Za-z0-9_-]{1,400}$/;
const MAX_ITEMS = 50;

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function trackingEnabled(env) {
  return cleanString(env?.META_TRACKING_ENABLED) === 'true';
}

export function isProductionEnv(env) {
  return cleanString(env?.APP_ENV) === 'production';
}

/** URL https del mismo host, sin fragmento y sólo con parámetros permitidos. */
export function sanitizeEventUrl(raw, hostname) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || (hostname && url.hostname !== hostname)) return '';
    for (const key of [...url.searchParams.keys()]) {
      if (!ALLOWED_URL_PARAMS.has(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.toString().slice(0, 1000);
  } catch {
    return '';
  }
}

/**
 * Qué Pixel, token y código de prueba corresponden a este entorno.
 *
 * - Producción: META_PIXEL_ID + META_CAPI_TOKEN (código de prueba opcional).
 * - Cualquier otro entorno: SÓLO un Pixel de pruebas separado
 *   (META_TEST_PIXEL_ID + META_TEST_CAPI_TOKEN) y siempre con
 *   META_TEST_EVENT_CODE. El Pixel y el token productivos se ignoran: un
 *   Preview no puede mandar nada al Pixel real, ni desde el navegador ni
 *   desde el servidor, aunque alguien los cargue ahí por error.
 */
function environmentCredentials(env) {
  if (!trackingEnabled(env)) return null;
  const testEventCode = cleanString(env?.META_TEST_EVENT_CODE);
  const validTestCode = /^[A-Z0-9]{3,20}$/i.test(testEventCode);
  if (isProductionEnv(env)) {
    return {
      pixelId: cleanString(env?.META_PIXEL_ID),
      token: cleanString(env?.META_CAPI_TOKEN),
      testEventCode: validTestCode ? testEventCode : '',
    };
  }
  if (!validTestCode) return null;
  return {
    pixelId: cleanString(env?.META_TEST_PIXEL_ID),
    token: cleanString(env?.META_TEST_CAPI_TOKEN),
    testEventCode,
  };
}

/** Lo que el navegador necesita saber. Nunca incluye el token. */
export function publicTrackingConfig(env) {
  const creds = environmentCredentials(env);
  if (!creds || !/^\d{5,20}$/.test(creds.pixelId)) return { enabled: false };
  return { enabled: true, pixel_id: creds.pixelId };
}

/** Configuración del envío server-side, o null si falta algo o está apagado. */
export function metaConfig(env) {
  const creds = environmentCredentials(env);
  if (!creds || !/^\d{5,20}$/.test(creds.pixelId) || !creds.token) return null;
  return {
    pixelId: creds.pixelId,
    token: creds.token,
    ...(creds.testEventCode ? { testEventCode: creds.testEventCode } : {}),
  };
}

// ─── Datos personales: normalizar y hashear ──────────────────────────────────

export function normalizeEmail(value) {
  const email = cleanString(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

/**
 * Teléfono en formato E.164 sin «+», como lo pide Meta. Los números locales
 * uruguayos (09x…, 2xxx…) reciben el código de país 598.
 */
export function normalizePhone(value, countryCode = '598') {
  let digits = cleanString(value).replace(/\D+/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (!digits.startsWith(countryCode)) digits = countryCode + digits.replace(/^0+/, '');
  return digits.length >= 10 && digits.length <= 15 ? digits : '';
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** user_data de Meta: identificadores hasheados + cookies propias de Meta. */
export async function buildUserData({ email, phone, fbp, fbc, userAgent } = {}) {
  const userData = {};
  const em = normalizeEmail(email);
  const ph = normalizePhone(phone);
  if (em) userData.em = [await sha256Hex(em)];
  if (ph) userData.ph = [await sha256Hex(ph)];
  if (em || ph) userData.country = [await sha256Hex('uy')];
  const cleanFbp = cleanString(fbp);
  const cleanFbc = cleanString(fbc);
  if (FBP_RE.test(cleanFbp)) userData.fbp = cleanFbp;
  if (FBC_RE.test(cleanFbc)) userData.fbc = cleanFbc;
  const ua = cleanString(userAgent).slice(0, 500);
  if (ua) userData.client_user_agent = ua;
  return userData;
}

export function validFbp(value) { return FBP_RE.test(cleanString(value)); }
export function validFbc(value) { return FBC_RE.test(cleanString(value)); }
export function validEventId(value) { return EVENT_ID_RE.test(cleanString(value)); }

// ─── custom_data ─────────────────────────────────────────────────────────────

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 10_000_000
    ? Math.round(number * 100) / 100
    : null;
}

/**
 * items: [{ id, quantity, price }]. Se descarta todo lo que no tenga forma de
 * ficha (MLU…); content_ids es el ID de la ficha, igual que en el feed.
 */
export function buildCustomData({ items, value } = {}) {
  const contents = (Array.isArray(items) ? items : [])
    .slice(0, MAX_ITEMS)
    .map(raw => {
      const id = cleanString(String(raw?.id ?? raw?.item_id ?? raw?.product_id ?? '')).toUpperCase();
      if (!PRODUCT_ID_RE.test(id)) return null;
      const quantity = Math.min(99, Math.max(1, Math.floor(Number(raw?.quantity) || 1)));
      const price = money(raw?.price ?? raw?.item_price ?? raw?.unit_price_uyu);
      return { id, quantity, ...(price ? { item_price: price } : {}) };
    })
    .filter(Boolean);
  if (!contents.length) return null;

  let total = money(value);
  if (total === null) {
    total = contents.reduce((sum, item) => sum + (item.item_price || 0) * item.quantity, 0);
  }
  return {
    currency: 'UYU',
    value: Math.round(total * 100) / 100,
    content_ids: contents.map(item => item.id),
    content_type: 'product',
    contents,
    num_items: contents.reduce((sum, item) => sum + item.quantity, 0),
  };
}

export function buildServerEvent({
  eventName,
  eventId,
  eventTime = Math.floor(Date.now() / 1000),
  eventSourceUrl,
  userData = {},
  customData,
}) {
  const event = {
    event_name: eventName,
    event_time: eventTime,
    event_id: eventId,
    action_source: 'website',
    event_source_url: eventSourceUrl,
    user_data: userData,
  };
  if (customData) event.custom_data = customData;
  return event;
}

// ─── Envío ───────────────────────────────────────────────────────────────────

export async function postMetaEvents(config, events, {
  fetchFn = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const url = `${GRAPH_ORIGIN}/${META_GRAPH_VERSION}/${config.pixelId}/events`;
  const body = { data: events, access_token: config.token };
  if (config.testEventCode) body.test_event_code = config.testEventCode;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return response.ok
      ? { ok: true, status: response.status }
      : { ok: false, code: `META_HTTP_${response.status}` };
  } catch (error) {
    return { ok: false, code: error?.name === 'AbortError' ? 'META_TIMEOUT' : 'META_NETWORK_ERROR' };
  } finally {
    clearTimeout(timer);
  }
}
