// POST /api/payments/reconcile — conciliación de pagos de Mercado Pago.
//
// Para qué: el aviso firmado de Mercado Pago es el único que hoy deja un
// pedido como pagado. Si ese aviso no llega (clave rotada, base caída más
// tiempo del que Mercado Pago reintenta), el cliente pagó y el pedido figura
// sin pagar. Esto mira los pagos recientes de la cuenta y, para los de la web
// que no cierran con la base, los vuelve a procesar.
//
// Qué NO hace: decidir un cobro por su cuenta. La búsqueda sólo descubre ids;
// cada pago pasa por `createPaymentProcessor`, el mismo código y las mismas
// validaciones que el aviso firmado (cuenta, moneda, importe exacto, orden de
// pago). Lo que no pasa una validación no se marca pagado: queda en
// payment_incidents y se avisa por correo.
//
// Lo dispara el Worker cada 5 minutos. El endpoint es público pero inofensivo:
// no recibe datos, corre como mucho una vez cada 4 minutos y responde sólo
// cantidades.
//
// El turno se toma en la base de pedidos con una sentencia condicional
// (payment_reconcile_runs): de dos llamados simultáneos pasa uno solo. Si el
// turno no se puede tomar (base caída, tabla ausente), no se consulta a
// Mercado Pago: se responde 503. El turno es por entorno y cuenta: una vista
// previa no le saca el turno a producción.

import { resolveConfig } from './_env_config.js';
import {
  getPayment as defaultGetPayment,
  getMerchantOrder as defaultGetMerchantOrder,
  searchRecentPayments as defaultSearchRecentPayments,
} from './_mp_client.js';
import { createPaymentProcessor, isWebOrderReference } from './_mp_webhook_handler.js';
import { notifyPendingIncidents as defaultNotifyPending } from './_payment_incidents.js';

const MIN_INTERVAL_MS = 4 * 60 * 1000;
const PAGE_SIZE = 50;
const MAX_PAGES = 6;
const MAX_CANDIDATES = 20;
const MONEY_STATUSES = new Set(['approved', 'refunded', 'charged_back']);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

async function loadOrders(db, codes) {
  const byCode = new Map();
  for (let i = 0; i < codes.length; i += 40) {
    const chunk = codes.slice(i, i + 40);
    const rows = await db.prepare(
      `SELECT public_code,payment_status,payment_id FROM orders WHERE public_code IN (${chunk.map(() => '?').join(',')})`
    ).bind(...chunk).all();
    for (const row of rows?.results || []) byCode.set(row.public_code, row);
  }
  return byCode;
}

async function loadKnownIncidents(db, paymentIds) {
  const known = new Set();
  for (let i = 0; i < paymentIds.length; i += 40) {
    const chunk = paymentIds.slice(i, i + 40);
    const rows = await db.prepare(
      `SELECT payment_id FROM payment_incidents WHERE payment_id IN (${chunk.map(() => '?').join(',')})`
    ).bind(...chunk).all();
    for (const row of rows?.results || []) known.add(String(row.payment_id));
  }
  return known;
}

export function reconcileScope(config) {
  return `${config.appEnv}:${config.mpCollectorId}`;
}

/**
 * Toma el turno de la corrida. Devuelve true sólo para un llamado por ventana:
 * la fila se inserta o se pisa únicamente si la corrida anterior empezó hace
 * más de MIN_INTERVAL_MS. Cualquier error se propaga: sin turno no se corre.
 */
async function claimRun(db, scope, now) {
  const result = await db.prepare(
    "INSERT INTO payment_reconcile_runs (scope,started_at,finished_at,status,summary_json) VALUES (?,?,NULL,'running',NULL) " +
    "ON CONFLICT(scope) DO UPDATE SET started_at=excluded.started_at, finished_at=NULL, status='running', summary_json=NULL " +
    'WHERE payment_reconcile_runs.started_at <= ?'
  ).bind(scope, now.toISOString(), new Date(now.getTime() - MIN_INTERVAL_MS).toISOString()).run();
  return Number(result?.meta?.changes) === 1;
}

/** ¿El pago de Mercado Pago no cierra con lo que dice la base? */
export function needsProcessing(payment, order) {
  if (payment.status === 'approved') {
    if (!order) return true;
    return order.payment_status !== 'approved' || String(order.payment_id ?? '') !== String(payment.id);
  }
  // Devolución o contracargo: sólo importa si hay un pedido que no lo refleja.
  return Boolean(order) && order.payment_status !== 'refunded' && String(order.payment_id ?? '') === String(payment.id);
}

export function createPaymentsReconcileHandler({
  mpClient = {
    getPayment: defaultGetPayment,
    getMerchantOrder: defaultGetMerchantOrder,
    searchRecentPayments: defaultSearchRecentPayments,
  },
  getNow = () => new Date(),
  notifyPending = defaultNotifyPending,
  processorDeps = {},
} = {}) {
  const processPayment = createPaymentProcessor({ mpClient, getNow, ...processorDeps });

  return async function onRequest(context) {
    const { request, env } = context;
    if (request.method !== 'POST') return json({ error: 'Método no permitido.' }, 405);

    const config = resolveConfig(env);
    if (!config.ok) return json({ error: 'Servicio no disponible.' }, 503);
    if (!config.isAllowedRequestHost(new URL(request.url).hostname)) return json({ error: 'Origen no permitido.' }, 400);

    const accessToken = env?.MP_ACCESS_TOKEN;
    const db = env?.ORDERS_DB;
    if (!accessToken || !db) return json({ error: 'Servicio no disponible.' }, 503);

    // Freno de frecuencia y de simultaneidad. Sin turno confirmado no se
    // consulta a Mercado Pago: ni por error de la base ni por duda.
    const now = getNow();
    const scope = reconcileScope(config);
    let claimed = false;
    try {
      claimed = await claimRun(db, scope, now);
    } catch (error) {
      console.error('[payments-reconcile] no se pudo tomar el turno', error?.name || 'Error');
      return json({ error: 'Servicio no disponible.' }, 503);
    }
    if (!claimed) return json({ ok: true, skipped: true });

    const summary = { revisados: 0, de_la_web: 0, candidatos: 0, aplicados: 0, sin_asignar: 0, reintentar: 0, avisos_reenviados: 0 };
    let status = 'ok';
    try {
      // 1. Descubrir pagos recientes de la cuenta con referencia de la web.
      const found = new Map();
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await mpClient.searchRecentPayments(accessToken, { limit: PAGE_SIZE, offset: page * PAGE_SIZE });
        if (!result.ok) { status = 'mp_search_failed'; break; }
        summary.revisados += result.results.length;
        for (const p of result.results) {
          if (p.collector_id !== config.mpCollectorId) continue;
          if (!isWebOrderReference(p.external_reference) || !MONEY_STATUSES.has(p.status)) continue;
          found.set(p.id, p);
        }
        if (result.results.length < PAGE_SIZE) break;
      }
      summary.de_la_web = found.size;

      if (status === 'ok' && found.size > 0) {
        // 2. Quedarse con los que no cierran con la base y todavía no se avisaron.
        const payments = [...found.values()];
        const orders = await loadOrders(db, [...new Set(payments.map(p => p.external_reference))]);
        const open = payments.filter(p => needsProcessing(p, orders.get(p.external_reference)));
        const known = open.length > 0 ? await loadKnownIncidents(db, open.map(p => p.id)) : new Set();
        const candidates = open.filter(p => !known.has(p.id)).slice(0, MAX_CANDIDATES);
        summary.candidatos = candidates.length;

        // 3. Cada candidato pasa por el mismo procesamiento que el aviso firmado.
        for (const candidate of candidates) {
          const outcome = await processPayment({
            context: null, env, config, db, accessToken, paymentId: candidate.id, source: 'conciliacion',
          });
          if (outcome.result === 'applied') summary.aplicados++;
          else if (outcome.result === 'ignored') summary.sin_asignar++;
          else summary.reintentar++;
        }
      }

      // 4. Correos de incidentes que no salieron en su momento.
      if (config.isProduction) {
        const pending = await notifyPending({ db, env, now });
        summary.avisos_reenviados = pending.sent;
      }
    } catch (error) {
      status = 'error';
      console.error('[payments-reconcile] falló la corrida', error?.name || 'Error');
    }

    // Resultado de la corrida. Sólo si el turno sigue siendo de esta corrida.
    try {
      await db.prepare(
        'UPDATE payment_reconcile_runs SET finished_at=?, status=?, summary_json=? WHERE scope=? AND started_at=?'
      ).bind(getNow().toISOString(), status, JSON.stringify(summary), scope, now.toISOString()).run();
    } catch (error) {
      console.error('[payments-reconcile] no se pudo anotar el resultado', error?.name || 'Error');
    }
    return json({ ok: status === 'ok', status, ...summary }, status === 'ok' ? 200 : 502);
  };
}
