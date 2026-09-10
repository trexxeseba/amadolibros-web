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
import { isEligibleForFeed } from '../feed.xml.js';

const RECENT_ORDERS_LIMIT = 20;
const STUCK_LIMIT = 25;
const CRAWL_DAYS = 7;
const MISSING_IMAGE_LIMIT = 25;

// El id va a parar a un href. Sólo se acepta la forma real de Mercado Libre;
// cualquier otra cosa queda en cadena vacía y el panel muestra el texto sin enlace.
function cleanId(value) {
  return /^MLU\d+$/.test(String(value || '')) ? String(value) : '';
}

/**
 * Por qué un libro activo no llega al feed de Google. La cuenta autorizada la
 * da isEligibleForFeed; esto sólo pone el motivo en palabras, en el mismo
 * orden en que esa función descarta. Hay un test que verifica que las dos
 * coincidan siempre: si alguien cambia la regla y no toca esto, falla.
 */
function feedBlockerReason(item) {
  if (!item?.permalink) return 'sin enlace a Mercado Libre';
  if (!/^MLU\d+$/.test(String(item?.id || ''))) return 'id inválido';
  if (!(Number(item?.available_quantity) > 0)) return 'sin stock';
  if (!(Number(item?.price) > 0)) return 'sin precio';
  if (String(item?.currency || item?.currency_id || '').trim().toUpperCase() !== 'UYU') {
    return 'sin moneda UYU';
  }
  return 'no se reconoce como libro';
}

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
  let withoutIsbn = 0;
  let withoutImage = 0;
  let feedEligible = 0;
  // Una ficha sin ninguna foto es la que sale a Google sin `image` en el
  // JSON-LD, y es lo que Search Console reporta como "Falta el campo image".
  // El contador ya existía; lo que faltaba era saber CUÁLES para poder actuar.
  const missingImageItems = [];
  const feedBlockers = new Map();

  for (const item of items) {
    const active = item?.status === 'active';
    const inStock = Number(item?.available_quantity) > 0;
    if (inStock) withStock += 1;
    if (!item?.isbn) withoutIsbn += 1;

    if (!Array.isArray(item?.pictures) || item.pictures.length === 0) {
      withoutImage += 1;
      missingImageItems.push({
        id: cleanId(item?.id),
        title: item?.title || '(sin título)',
        status: item?.status || '—',
        // Un activo con stock es plata parada; un pausado sin foto no le
        // importa a nadie hoy. Se ordena por eso para que el trabajo manual
        // de cargar fotos empiece por lo que vende.
        priority: active && inStock ? 0 : active ? 1 : 2,
      });
    }

    // Se usa la MISMA función que arma el feed, no una copia: si mañana cambia
    // la regla, este contador cambia con ella en vez de mentir.
    if (isEligibleForFeed(item)) feedEligible += 1;
    else if (active) {
      const reason = feedBlockerReason(item);
      feedBlockers.set(reason, (feedBlockers.get(reason) || 0) + 1);
    }
  }

  missingImageItems.sort((a, b) => a.priority - b.priority);
  const activeTotal = items.filter(item => item?.status === 'active').length;

  return {
    total: items.length,
    withStock,
    withoutImage,
    withoutIsbn,
    // `items` está recortado a MISSING_IMAGE_LIMIT: es una muestra para actuar,
    // no el listado completo. `withoutImage` sigue siendo el total real.
    missingImage: {
      count: withoutImage,
      items: missingImageItems.slice(0, MISSING_IMAGE_LIMIT),
      limit: MISSING_IMAGE_LIMIT,
    },
    // Sólo la puerta comercial del feed. La segunda puerta —que la portada
    // esté lista en R2— se mide aparte y necesita el manifest de portadas,
    // que pesa demasiado para cargarlo en cada vista del panel. O sea:
    // `eligible` es un techo, no la cantidad final de ofertas en Merchant.
    feed: {
      activeTotal,
      eligible: feedEligible,
      blocked: Math.max(0, activeTotal - feedEligible),
      blockers: [...feedBlockers.entries()]
        .map(([reason, total]) => ({ reason, total }))
        .sort((a, b) => b.total - a.total),
    },
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
