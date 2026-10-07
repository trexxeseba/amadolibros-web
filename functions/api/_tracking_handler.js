/**
 * functions/api/_tracking_handler.js
 *
 * GET  /api/tracking/config → { enabled, pixel_id } para el navegador.
 * POST /api/tracking/meta   → reenvía por la API de conversiones el mismo
 *                             evento que el Pixel acaba de disparar, con el
 *                             mismo event_id.
 *
 * Con META_TRACKING_ENABLED distinto de 'true' los dos responden «apagado»
 * y no hacen nada. El POST sólo actúa si el navegador declara el
 * consentimiento de marketing, viene del mismo sitio y trae un evento de la
 * lista cerrada; Purchase no se acepta desde el navegador.
 *
 * consent='denied' con `revoke_codes` registra la retirada del
 * consentimiento para esos pedidos: su compra ya no se manda a Meta.
 *
 * Límite de pedidos: RATE_LIMIT_PER_MINUTE por visitante (IP hasheada, nunca
 * guardada en claro) y por isolate. Es una primera barrera; la definitiva es
 * una regla de rate limiting de Cloudflare sobre /api/tracking/*.
 */

import { resolveConfig } from './_env_config.js';
import {
  BROWSER_CAPI_EVENTS,
  EVENTS_WITHOUT_ITEMS,
  buildCustomData,
  buildServerEvent,
  buildUserData,
  metaConfig,
  postMetaEvents,
  publicTrackingConfig,
  sanitizeEventUrl,
  sha256Hex,
  validEventId,
  validFbc,
  validFbp,
} from '../_shared/meta-capi.js';
import {
  recordMetaAttribution,
  revokeMetaAttribution,
  sendMetaPurchase,
} from '../_shared/purchase-tracking.js';

const MAX_BODY_BYTES = 16384;
export const RATE_LIMIT_PER_MINUTE = 60;
export const REVOKE_RATE_LIMIT_PER_MINUTE = 20;

/** Ventana fija por minuto, en memoria del isolate. Clave: hash de la IP. */
export function createRateLimiter({ limit = RATE_LIMIT_PER_MINUTE, windowMs = 60_000, maxKeys = 5000 } = {}) {
  const buckets = new Map();
  return function allow(key, nowMs = Date.now()) {
    const bucket = buckets.get(key);
    if (!bucket || nowMs - bucket.start >= windowMs) {
      if (buckets.size >= maxKeys) buckets.clear();
      buckets.set(key, { start: nowMs, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= limit;
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

export function createTrackingConfigHandler() {
  return async function onRequest({ request, env }) {
    if (request.method !== 'GET') return json({ error: 'Método no permitido.' }, 405);
    return json(publicTrackingConfig(env), 200, { 'Cache-Control': 'public, max-age=300' });
  };
}

export function createTrackingMetaHandler({
  fetchFn = globalThis.fetch,
  getNow = () => new Date(),
  rateLimiter = createRateLimiter(),
  // La revocación tiene su propio cupo: una ráfaga de eventos nunca puede
  // dejar sin lugar a la retirada del consentimiento.
  revokeRateLimiter = createRateLimiter({ limit: REVOKE_RATE_LIMIT_PER_MINUTE }),
} = {}) {
  return async function onRequest(context) {
    const { request, env } = context;
    if (request.method !== 'POST') return json({ error: 'Método no permitido.' }, 405);

    const config = resolveConfig(env);
    if (!config.ok) return json({ ok: true, skipped: 'disabled' }, 202);
    const reqUrl = new URL(request.url);
    if (!config.isAllowedRequestHost(reqUrl.hostname)) return json({ error: 'Origen no permitido.' }, 403);
    const origin = request.headers.get('Origin');
    if (origin) {
      let originHost = '';
      try { originHost = new URL(origin).hostname; } catch { /* inválido */ }
      if (originHost !== reqUrl.hostname) return json({ error: 'Origen no permitido.' }, 403);
    }

    let body;
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return json({ error: 'Payload inválido.' }, 400);
      body = JSON.parse(text);
    } catch {
      return json({ error: 'Payload inválido.' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Payload inválido.' }, 400);

    const visitor = await sha256Hex(`rl:${request.headers.get('CF-Connecting-IP') || 'unknown'}`);

    // Retirada del consentimiento: camino propio, antes de mirar si Meta está
    // encendido (una atribución `granted` no debe sobrevivir a un apagado y
    // reencendido) y con su propio límite. Responde `confirmed: true` sólo
    // cuando la base quedó escrita; el navegador reintenta hasta verlo.
    if (body.consent === 'denied' && Array.isArray(body.revoke_codes)) {
      if (!revokeRateLimiter(visitor, getNow().getTime())) {
        return json({ error: 'Demasiadas solicitudes.' }, 429, { 'Retry-After': '60' });
      }
      if (!env?.ORDERS_DB) return json({ ok: false, confirmed: false }, 503);
      try {
        const result = await revokeMetaAttribution({ db: env.ORDERS_DB, publicCodes: body.revoke_codes, now: getNow() });
        return json({ ok: true, confirmed: true, revoked: result.revoked || 0 }, 200);
      } catch {
        return json({ ok: false, confirmed: false }, 503);
      }
    }

    const capi = metaConfig(env);
    if (!capi) return json({ ok: true, skipped: 'disabled' }, 202);

    if (!rateLimiter(visitor, getNow().getTime())) {
      return json({ error: 'Demasiadas solicitudes.' }, 429, { 'Retry-After': '60' });
    }

    // Sin consentimiento no se manda nada: ni el evento ni la atribución.
    if (body.consent !== 'granted') return json({ ok: true, skipped: 'no_consent' }, 202);

    const eventName = String(body.event_name || '');
    if (!BROWSER_CAPI_EVENTS.has(eventName)) return json({ error: 'Evento no permitido.' }, 400);
    if (!validEventId(body.event_id)) return json({ error: 'event_id inválido.' }, 400);
    const eventSourceUrl = sanitizeEventUrl(body.event_source_url, reqUrl.hostname);
    if (!eventSourceUrl) return json({ error: 'URL inválida.' }, 400);

    let customData = buildCustomData({ items: body.items, value: body.value }) || undefined;
    if (!customData && !EVENTS_WITHOUT_ITEMS.has(eventName)) return json({ error: 'Items inválidos.' }, 400);
    if (eventName === 'PageView') customData = undefined;

    const fbp = validFbp(body.fbp) ? body.fbp : '';
    const fbc = validFbc(body.fbc) ? body.fbc : '';
    const userAgent = request.headers.get('User-Agent') || '';
    const now = getNow();

    const event = buildServerEvent({
      eventName,
      eventId: body.event_id,
      eventTime: Math.floor(now.getTime() / 1000),
      eventSourceUrl,
      userData: await buildUserData({ fbp, fbc, userAgent }),
      customData,
    });

    const work = (async () => {
      // Al iniciar el checkout se guarda, ligado al pedido, que el comprador
      // aceptó y sus cookies de Meta: la compra la manda después el servidor.
      const sent = await postMetaEvents(capi, [event], { fetchFn });
      if (!sent.ok) console.warn('[tracking] Meta rechazó el evento', { event: eventName, code: sent.code });
      if (eventName === 'InitiateCheckout' && typeof body.public_code === 'string' && env?.ORDERS_DB) {
        const recorded = await recordMetaAttribution({
          db: env.ORDERS_DB, publicCode: body.public_code, fbp, fbc, userAgent, now,
        }).catch(() => null);
        // Si el pago ya se había confirmado antes de que llegara la
        // atribución, la compra se recupera acá (es idempotente).
        if (recorded?.ok) {
          await sendMetaPurchase({ db: env.ORDERS_DB, env, orderId: recorded.orderId, now, fetchFn }).catch(() => {});
        }
      }
    })();
    if (typeof context.waitUntil === 'function') context.waitUntil(work);
    else await work;

    return json({ ok: true }, 202);
  };
}
