/**
 * functions/api/_tracking_handler.js
 *
 * GET  /api/tracking/config → { enabled, pixel_id } para el navegador.
 * POST /api/tracking/meta   → reenvía por la API de conversiones el mismo
 *                             evento que el Pixel acaba de disparar, con el
 *                             mismo event_id.
 *
 * Con MARKETING_TRACKING_ENABLED distinto de 'true' los dos responden «apagado»
 * y no hacen nada. El POST sólo actúa si el navegador declara el
 * consentimiento de marketing, viene del mismo sitio y trae un evento de la
 * lista cerrada; Purchase no se acepta desde el navegador.
 */

import { resolveConfig } from './_env_config.js';
import {
  BROWSER_CAPI_EVENTS,
  buildCustomData,
  buildServerEvent,
  buildUserData,
  metaConfig,
  postMetaEvents,
  publicTrackingConfig,
  validEventId,
  validFbc,
  validFbp,
} from '../_shared/meta-capi.js';
import { recordMetaAttribution } from '../_shared/purchase-tracking.js';

const MAX_BODY_BYTES = 16384;

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

function sameSiteUrl(raw, hostname) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== hostname) return '';
    url.hash = '';
    return url.toString().slice(0, 1000);
  } catch {
    return '';
  }
}

export function createTrackingMetaHandler({ fetchFn = globalThis.fetch, getNow = () => new Date() } = {}) {
  return async function onRequest(context) {
    const { request, env } = context;
    if (request.method !== 'POST') return json({ error: 'Método no permitido.' }, 405);

    const capi = metaConfig(env);
    if (!capi) return json({ ok: true, skipped: 'disabled' }, 202);

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

    // Sin consentimiento no se manda nada: ni el evento ni la atribución.
    if (body.consent !== 'granted') return json({ ok: true, skipped: 'no_consent' }, 202);

    const eventName = String(body.event_name || '');
    if (!BROWSER_CAPI_EVENTS.has(eventName)) return json({ error: 'Evento no permitido.' }, 400);
    if (!validEventId(body.event_id)) return json({ error: 'event_id inválido.' }, 400);
    const eventSourceUrl = sameSiteUrl(body.event_source_url, reqUrl.hostname);
    if (!eventSourceUrl) return json({ error: 'URL inválida.' }, 400);

    let customData;
    if (eventName !== 'PageView') {
      customData = buildCustomData({ items: body.items, value: body.value });
      if (!customData) return json({ error: 'Items inválidos.' }, 400);
    }

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
      if (eventName === 'InitiateCheckout' && typeof body.public_code === 'string' && env?.ORDERS_DB) {
        await recordMetaAttribution({
          db: env.ORDERS_DB, publicCode: body.public_code, fbp, fbc, userAgent, now,
        }).catch(() => {});
      }
      const sent = await postMetaEvents(capi, [event], { fetchFn });
      if (!sent.ok) console.warn('[tracking] Meta rechazó el evento', { event: eventName, code: sent.code });
    })();
    if (typeof context.waitUntil === 'function') context.waitUntil(work);
    else await work;

    return json({ ok: true }, 202);
  };
}
