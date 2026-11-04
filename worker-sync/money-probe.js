/**
 * worker-sync/money-probe.js
 *
 * Diagnóstico de SOLO LECTURA para el sistema de plata: con el token real del
 * Worker prueba cada endpoint de plata de Mercado Libre / Mercado Pago y
 * devuelve únicamente el código HTTP y el motivo del error. Nunca devuelve ni
 * guarda datos de ventas, montos ni ids: el repo es público y los logs también.
 *
 * Solo GET. No renueva el token por su cuenta más allá de getAccessToken.
 */
import { getAccessToken } from './meli-auth.js';

const ML = 'https://api.mercadolibre.com';
const MP = 'https://api.mercadopago.com';
const TIMEOUT_MS = 12_000;
const safe = v => String(v ?? '').replace(/[^\w .:/_-]/g, '').slice(0, 80);

export function createMoneyProbe({ fetcher = (...a) => globalThis.fetch(...a), tokenProvider = getAccessToken } = {}) {
  return async function probe(env) {
    const token = await tokenProvider(env);
    const get = async (url, headers = {}) => {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      try {
        const res = await fetcher(url, { method: 'GET', redirect: 'manual', signal: ctl.signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...headers } });
        let body = null; try { body = await res.json(); } catch { body = null; }
        return { status: res.status, body };
      } catch { return { status: 0, body: null }; } finally { clearTimeout(timer); }
    };
    const verdict = r => ({ http: r.status, ok: r.status >= 200 && r.status < 300, motivo: r.status >= 200 && r.status < 300 ? null : safe(r.body?.error || r.body?.message || r.body?.code || 'sin_detalle') });

    const results = {};
    const me = await get(`${ML}/users/me`);
    results.usuario = verdict(me);
    const uid = Number(me.body?.id);
    if (!Number.isFinite(uid) || uid <= 0) return { resultados: results, nota: 'sin_usuario: no se pudo seguir' };

    const orders = await get(`${ML}/orders/search?seller=${uid}&sort=date_desc&limit=1`);
    results.ordenes = verdict(orders);
    const order = orders.body?.results?.[0];
    const shipmentId = order?.shipping?.id;
    const paymentId = order?.payments?.[0]?.id;

    results.envio_costos = shipmentId ? verdict(await get(`${ML}/shipments/${shipmentId}/costs`, { 'x-format-new': 'true' })) : { http: null, ok: null, motivo: 'sin_envio_de_muestra' };
    results.pago_mp = paymentId ? verdict(await get(`${MP}/v1/payments/${paymentId}`)) : { http: null, ok: null, motivo: 'sin_pago_de_muestra' };
    results.pagos_busqueda_mp = verdict(await get(`${MP}/v1/payments/search?limit=1&sort=date_created&criteria=desc`));
    results.saldo_cuenta_mp = verdict(await get(`${ML}/users/${uid}/mercadopago_account/balance`));
    results.movimientos_mp = verdict(await get(`${ML}/mercadopago_account/movements/search?limit=1`));
    results.reportes_liberaciones_mp = verdict(await get(`${MP}/v1/account/release_report/list`));
    results.reportes_conciliacion_mp = verdict(await get(`${MP}/v1/account/settlement_report/list`));
    results.reclamos = verdict(await get(`${ML}/post-purchase/v1/claims/search?limit=1`));
    results.facturacion_periodos = verdict(await get(`${ML}/billing/integration/monthly/periods?group=ML&document_type=BILL&limit=1`));
    results.ads_anunciante = verdict(await get(`${ML}/advertising/advertisers?product_id=PADS`, { 'Api-Version': '1' }));
    return { resultados: results };
  };
}

export const moneyProbe = createMoneyProbe();

export async function handleMoneyRoute(request, env, probe = moneyProbe) {
  const url = new URL(request.url);
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (request.method !== 'GET' || url.pathname !== '/money/probe') return Response.json({ error: 'not_found' }, { status: 404, headers });
  try { return Response.json(await probe(env), { headers }); }
  catch (e) { return Response.json({ error: safe(e?.code || 'internal_error') }, { status: e?.status && e.status < 600 ? e.status : 500, headers }); }
}
