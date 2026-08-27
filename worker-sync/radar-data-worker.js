/**
 * Entrada compuesta para RADAR DATA (#276).
 *
 * Sigue siendo el mismo Worker: delega todo el comportamiento existente a
 * index.js y añade únicamente rutas/ingesta read-only de ventas ML. El flag
 * ML_SALES_SYNC_ENABLED está apagado por defecto.
 */

import baseWorker from './index.js';
import { getAccessToken } from './meli-auth.js';
import { fetchSellerOrders, normalizeMlOrderItems, summarizeNormalizedSales } from './ml-orders.js';
import {
  getMlOrderItemsForItem,
  getMlSalesSyncState,
  getMlSalesWindows,
  upsertMlOrderItems,
  writeMlSalesSyncState,
} from './ml-sales-store.js';

const DEFAULT_BACKFILL_DAYS = 90;
const DEFAULT_MAINTENANCE_DAYS = 7;

function positiveInt(value, fallback, max = 365) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(max, parsed) : fallback;
}

function isoDaysAgo(now, days) {
  return new Date(now.getTime() - days * 86400000).toISOString();
}

export function salesSyncWindow(now, state, env = {}) {
  const backfillDays = positiveInt(env.ML_SALES_BACKFILL_DAYS, DEFAULT_BACKFILL_DAYS, 365);
  const maintenanceDays = positiveInt(env.ML_SALES_MAINTENANCE_DAYS, DEFAULT_MAINTENANCE_DAYS, 90);
  const hasCoverage = Boolean(state?.coverage_from && state?.coverage_to && state?.last_status === 'ok');
  const days = hasCoverage ? maintenanceDays : backfillDays;
  return {
    mode: hasCoverage ? 'maintenance' : 'backfill',
    days,
    from: isoDaysAgo(now, days),
    to: now.toISOString(),
  };
}

function earlierIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a < b ? a : b;
}

function laterIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a > b ? a : b;
}

export async function runMlSalesSync(env, { source = 'unknown' } = {}, {
  getAccessTokenFn = getAccessToken,
  fetchSellerOrdersFn = fetchSellerOrders,
  normalizeMlOrderItemsFn = normalizeMlOrderItems,
  upsertMlOrderItemsFn = upsertMlOrderItems,
  getMlSalesSyncStateFn = getMlSalesSyncState,
  writeMlSalesSyncStateFn = writeMlSalesSyncState,
  now = () => new Date(),
} = {}) {
  if (String(env?.ML_SALES_SYNC_ENABLED) !== 'true') {
    return { status: 'skipped', reason: 'ml_sales_sync_disabled', source };
  }
  const sellerId = env?.USER_ID;
  if (!sellerId) return { status: 'error', error: 'USER_ID no configurado.', source };

  const startedAt = now();
  let previousState = null;
  let window = null;
  try {
    previousState = await getMlSalesSyncStateFn(env);
    window = salesSyncWindow(startedAt, previousState, env);
    const token = await getAccessTokenFn(env);
    const fetched = await fetchSellerOrdersFn(token, {
      sellerId,
      dateFrom: window.from,
      dateTo: window.to,
      status: 'paid',
    });
    const observedAt = now().toISOString();
    const rows = normalizeMlOrderItemsFn(fetched.orders, { observedAt });
    const persisted = await upsertMlOrderItemsFn(env, rows);
    const coverageFrom = earlierIso(previousState?.coverage_from, window.from);
    const coverageTo = laterIso(previousState?.coverage_to, window.to);
    await writeMlSalesSyncStateFn(env, {
      coverageFrom,
      coverageTo,
      lastSyncAt: observedAt,
      status: 'ok',
      orderCount: fetched.orders.length,
      itemRows: persisted.written,
      error: null,
    });
    return {
      status: 'ok',
      source,
      mode: window.mode,
      coverage_from: coverageFrom,
      coverage_to: coverageTo,
      fetched_orders: fetched.orders.length,
      pages: fetched.pages,
      item_rows: rows.length,
      rows_upserted: persisted.written,
      observed_at: observedAt,
    };
  } catch (error) {
    const observedAt = now().toISOString();
    try {
      await writeMlSalesSyncStateFn(env, {
        coverageFrom: previousState?.coverage_from || window?.from || null,
        coverageTo: previousState?.coverage_to || null,
        lastSyncAt: observedAt,
        status: 'error',
        error: error?.message || 'Error',
      });
    } catch {
      // La falla al registrar observabilidad no oculta la causa principal.
    }
    return {
      status: 'error',
      source,
      observed_at: observedAt,
      error: String(error?.message || 'Error').slice(0, 400),
    };
  }
}

function unauthorized(env, request) {
  if (!env?.SYNC_SECRET) return new Response(JSON.stringify({ error: 'Server misconfiguration: SYNC_SECRET not set.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  const authHeader = request.headers.get('Authorization') || '';
  if (authHeader !== `Bearer ${env.SYNC_SECRET}`) return new Response(JSON.stringify({ error: 'Unauthorized.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  return null;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function verifySalesLive(env, url) {
  const days = positiveInt(url.searchParams.get('days'), 7, 90);
  const maxPages = positiveInt(url.searchParams.get('pages'), 1, 5);
  const now = new Date();
  const token = await getAccessToken(env);
  const fetched = await fetchSellerOrders(token, {
    sellerId: env.USER_ID,
    dateFrom: isoDaysAgo(now, days),
    dateTo: now.toISOString(),
    status: 'paid',
    maxPages,
  });
  const rows = normalizeMlOrderItems(fetched.orders, { observedAt: now.toISOString() });
  return {
    checked_at: now.toISOString(),
    days,
    pages: fetched.pages,
    orders_observed: fetched.orders.length,
    item_rows: rows.length,
    sample: summarizeNormalizedSales(rows).slice(0, 20),
    pii_persisted: false,
    writes_to_ml: false,
  };
}

export default {
  async scheduled(event, env, ctx) {
    await baseWorker.scheduled(event, env, ctx);
    if (event?.cron === '15 7 * * *' && String(env?.ML_SALES_SYNC_ENABLED) === 'true') {
      ctx.waitUntil(runMlSalesSync(env, { source: 'cron' }));
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/sales/')) return baseWorker.fetch(request, env, ctx);
    const authError = unauthorized(env, request);
    if (authError) return authError;

    if (request.method === 'POST' && url.pathname === '/sales/sync') {
      if (String(env?.ML_SALES_SYNC_ENABLED) !== 'true') return json({ error: 'Not found.' }, 404);
      const mode = url.searchParams.get('mode') || 'async';
      if (mode === 'await') {
        const result = await runMlSalesSync(env, { source: 'manual-await' });
        return json(result, result.status === 'error' ? 500 : 200);
      }
      ctx.waitUntil(runMlSalesSync(env, { source: 'manual-async' }));
      return json({ status: 'ML_SALES_SYNC_TRIGGERED', mode: 'async' }, 202);
    }

    if (request.method === 'GET' && url.pathname === '/sales/summary') {
      const ids = (url.searchParams.get('ids') || '').split(',').map(v => v.trim()).filter(Boolean);
      if (ids.length === 0) return json({ error: 'Falta ?ids=MLU1,MLU2.' }, 400);
      if (ids.length > 20) return json({ error: 'Máximo 20 item_id por consulta.' }, 400);
      const asOf = url.searchParams.get('as_of') || undefined;
      const items = await Promise.all(ids.map(itemId => getMlSalesWindows(env, itemId, { asOf })));
      return json({ generated_at: new Date().toISOString(), items });
    }

    if (request.method === 'GET' && url.pathname === '/sales/raw') {
      const itemId = url.searchParams.get('item_id');
      if (!itemId) return json({ error: 'Falta ?item_id=MLUxxxxxxxxx.' }, 400);
      const rows = await getMlOrderItemsForItem(env, itemId, { limit: url.searchParams.get('limit') || 100 });
      return json({ item_id: itemId, rows });
    }

    if (request.method === 'GET' && url.pathname === '/sales/state') {
      return json({ state: await getMlSalesSyncState(env) });
    }

    if (request.method === 'GET' && url.pathname === '/sales/verify') {
      try {
        return json(await verifySalesLive(env, url));
      } catch (error) {
        return json({ error: String(error?.message || 'Error').slice(0, 400) }, 502);
      }
    }

    return json({ error: 'Not found.' }, 404);
  },
};
