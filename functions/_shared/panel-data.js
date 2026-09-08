/**
 * functions/_shared/panel-data.js
 *
 * PANEL-BACKEND-1 — lecturas del panel interno. SOLO LECTURA: acá no hay un
 * solo INSERT/UPDATE/DELETE. El panel observa; no toca precio, stock, título,
 * slug, imágenes ni nada del catálogo ni de Mercado Libre.
 *
 * Cada bloque se resuelve por separado y atrapa su propio error: si D1 se cae,
 * el panel igual muestra catálogo y estado en vez de responder una página en
 * blanco. Un bloque roto se muestra como roto, nunca como "0".
 *
 * Valores de estado tomados de los CHECK reales de migrations/:
 *   orders.status          open | paid | cancelled | expired | fulfilled
 *   orders.payment_status  not_started | pending | approved | rejected | refunded | cancelled
 *   stock_waitlist.status  waiting | notified | cancelled
 *   stock_waitlist.internal_notification_status  pending | sent | failed | skipped
 */

import { fetchCatalog } from './catalog.js';

const RECENT_ORDERS_LIMIT = 20;
const STUCK_LIMIT = 25;
const CRAWL_DAYS = 7;

async function queryAll(db, sql, params = []) {
  const statement = db.prepare(sql);
  const bound = params.length ? statement.bind(...params) : statement;
  const { results } = await bound.all();
  return Array.isArray(results) ? results : [];
}

async function section(loader) {
  try {
    return { ok: true, data: await loader() };
  } catch (error) {
    // El mensaje se muestra en el panel (ya autenticado), nunca al público.
    return { ok: false, error: String(error?.message || error || 'error desconocido') };
  }
}

function isoDaysAgo(now, days) {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

export async function loadOrdersOverview(db, { now = Date.now() } = {}) {
  const last30 = isoDaysAgo(now, 30);
  const [byStatus, recent, paidLast30] = await Promise.all([
    queryAll(db, 'SELECT status, COUNT(*) AS total FROM orders GROUP BY status'),
    queryAll(
      db,
      `SELECT public_code, status, payment_status, buyer_name, delivery_type,
              payable_total_uyu, created_at, paid_at, fulfilled_at
         FROM orders
        ORDER BY created_at DESC
        LIMIT ?`,
      [RECENT_ORDERS_LIMIT],
    ),
    queryAll(
      db,
      `SELECT COUNT(*) AS total, COALESCE(SUM(payable_total_uyu), 0) AS total_uyu
         FROM orders
        WHERE payment_status = 'approved' AND paid_at >= ?`,
      [last30],
    ),
  ]);

  return {
    byStatus,
    recent,
    paidLast30: paidLast30[0] || { total: 0, total_uyu: 0 },
  };
}

/**
 * "Qué quedó trancado": lo que ya no avanza solo y necesita que alguien lo mire.
 * Cada fila trae un motivo explícito para no tener que interpretar estados.
 */
export async function loadStuck(db, { now = Date.now() } = {}) {
  const anHourAgo = isoDaysAgo(now, 1 / 24);

  const [paidNotFulfilled, paymentHanging, waitlistRestocked, notificationFailed] = await Promise.all([
    queryAll(
      db,
      `SELECT public_code, buyer_name, payable_total_uyu, paid_at
         FROM orders
        WHERE payment_status = 'approved' AND fulfilled_at IS NULL
        ORDER BY paid_at ASC
        LIMIT ?`,
      [STUCK_LIMIT],
    ),
    queryAll(
      db,
      `SELECT public_code, buyer_name, payable_total_uyu, created_at
         FROM orders
        WHERE payment_status = 'pending' AND created_at < ?
        ORDER BY created_at ASC
        LIMIT ?`,
      [anHourAgo, STUCK_LIMIT],
    ),
    queryAll(
      db,
      `SELECT product_id, product_title, email, restocked_at
         FROM stock_waitlist
        WHERE status = 'waiting' AND restocked_at IS NOT NULL AND notified_at IS NULL
        ORDER BY restocked_at ASC
        LIMIT ?`,
      [STUCK_LIMIT],
    ),
    queryAll(
      db,
      `SELECT product_id, product_title, internal_notification_status, created_at
         FROM stock_waitlist
        WHERE internal_notification_status = 'failed'
           OR (internal_notification_status = 'pending' AND created_at < ?)
        ORDER BY created_at ASC
        LIMIT ?`,
      [anHourAgo, STUCK_LIMIT],
    ),
  ]);

  return {
    paidNotFulfilled,
    paymentHanging,
    waitlistRestocked,
    notificationFailed,
    total:
      paidNotFulfilled.length +
      paymentHanging.length +
      waitlistRestocked.length +
      notificationFailed.length,
  };
}

export async function loadWaitlist(db) {
  const [byStatus, topProducts] = await Promise.all([
    queryAll(db, 'SELECT status, COUNT(*) AS total FROM stock_waitlist GROUP BY status'),
    queryAll(
      db,
      `SELECT product_id, product_title, COUNT(*) AS total
         FROM stock_waitlist
        WHERE status = 'waiting'
        GROUP BY product_id, product_title
        ORDER BY total DESC
        LIMIT 10`,
    ),
  ]);
  return { byStatus, topProducts };
}

/**
 * Rastreo de Googlebot, NO visitas humanas. Es lo único de tráfico que el sitio
 * guarda por su cuenta (crawl_stats, escrito por el middleware). Las visitas
 * reales viven en GA4 y necesitan una credencial que el Worker no tiene.
 */
export async function loadCrawl(db, { now = Date.now() } = {}) {
  const since = isoDaysAgo(now, CRAWL_DAYS).slice(0, 10);
  const rows = await queryAll(
    db,
    `SELECT date,
            SUM(request_count) AS requests,
            SUM(CASE WHEN status >= 400 THEN request_count ELSE 0 END) AS errors,
            SUM(CASE WHEN verified = 1 THEN request_count ELSE 0 END) AS verified_googlebot
       FROM crawl_stats
      WHERE date >= ?
      GROUP BY date
      ORDER BY date DESC`,
    [since],
  );
  return { days: rows, since };
}

export async function loadCatalogSummary(ctx) {
  const catalog = await fetchCatalog(ctx);
  const items = Array.isArray(catalog?.items) ? catalog.items : [];
  let withStock = 0;
  let withoutImage = 0;
  let withoutIsbn = 0;
  for (const item of items) {
    if (Number(item?.available_quantity) > 0) withStock += 1;
    if (!Array.isArray(item?.pictures) || item.pictures.length === 0) withoutImage += 1;
    if (!item?.isbn) withoutIsbn += 1;
  }
  return {
    total: items.length,
    withStock,
    withoutImage,
    withoutIsbn,
    generatedAt: catalog?.generated_at || catalog?.generatedAt || null,
  };
}

export function environmentSummary(env) {
  return {
    appEnv: env?.APP_ENV || 'desconocido',
    checkoutEnabled: String(env?.CHECKOUT_ENABLED || '') === 'true',
    hasOrdersDb: Boolean(env?.ORDERS_DB),
    hasKv: Boolean(env?.AMADO_KV),
  };
}

export async function loadPanelData(context, { now = Date.now() } = {}) {
  const db = context?.env?.ORDERS_DB;
  const withDb = loader => (db
    ? section(() => loader(db))
    : Promise.resolve({ ok: false, error: 'ORDERS_DB no está disponible en este entorno.' }));

  const [orders, stuck, waitlist, crawl, catalog] = await Promise.all([
    withDb(database => loadOrdersOverview(database, { now })),
    withDb(database => loadStuck(database, { now })),
    withDb(database => loadWaitlist(database)),
    withDb(database => loadCrawl(database, { now })),
    section(() => loadCatalogSummary(context)),
  ]);

  return {
    generatedAt: new Date(now).toISOString(),
    environment: environmentSummary(context?.env),
    orders,
    stuck,
    waitlist,
    crawl,
    catalog,
  };
}
