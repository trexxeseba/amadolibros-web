/**
 * functions/_shared/panel-insights.js
 *
 * Lo que el tablero no mostraba aunque el dato ya estaba en D1:
 *
 *   - ventas de Mercado Libre (el canal que más vende; el tablero sólo sumaba
 *     la web),
 *   - búsquedas de la web que no encontraron nada,
 *   - qué cambió en el catálogo en cada sync,
 *   - avisos de stock pedidos por WhatsApp,
 *   - cómo va la campaña de Amado Vintage.
 *
 * Reglas:
 * - Sólo SELECT. La única escritura del módulo es marcar un aviso de WhatsApp
 *   como «ya le escribí», y la dispara un botón del panel.
 * - Cada cargador es independiente: si una tabla todavía no existe en un
 *   entorno, ese recuadro dice «no se pudo cargar» y el resto anda.
 * - Ventas ML se cuentan con los MISMOS estados que el motor de reposición
 *   (COUNTED_STATUSES de ml-sales.js), para que los dos no digan cosas
 *   distintas.
 * - Vintage es otro vendedor (2341378249). Se lee su huella en D1 igual que el
 *   vigía del Worker, sin pasar por el lote: el estado del lote descubre stock
 *   y escribe, y una pantalla de lectura no tiene por qué hacerlo.
 */

import { COUNTED_STATUSES, SALES_SELLER_ID } from '../../worker-sync/ml-sales.js';
import { assess } from '../../worker-sync/vintage-watch.js';
import { normalizePhone } from './meta-capi.js';

const DAY_MS = 86_400_000;
const COUNTED_SQL = COUNTED_STATUSES.map(s => `'${s}'`).join(',');
const SEARCH_MISS_DAYS = 30;
const SEARCH_MISS_LIMIT = 20;
const CATALOG_CHANGE_DAYS = 7;
const WHATSAPP_LIMIT = 50;

export const VINTAGE_SELLER_ID = '2341378249';
export const VINTAGE_RUN_ID = '23413782-4900-4000-8000-000000010000';

async function queryAll(db, sql, params = []) {
  const statement = db.prepare(sql);
  const bound = params.length ? statement.bind(...params) : statement;
  const { results } = await bound.all();
  return Array.isArray(results) ? results : [];
}

/** Inicio del día de hoy en Montevideo (UTC-3 todo el año), en ms. */
function montevideoDayStart(now) {
  const date = new Date(now - 3 * 3600_000).toISOString().slice(0, 10);
  return Date.parse(`${date}T03:00:00Z`);
}

/**
 * Ventas ML: lo cobrado en 30 días, cuántos libros, y la serie por mes para
 * ponerla al lado de la web en el gráfico.
 *
 * El mes sale de la fecha de la orden tal como la manda ML (hora de
 * Montevideo); la web usa la fecha de pago. Para un gráfico mensual alcanza.
 * Sólo se suma lo cobrado en pesos: si aparece otra moneda se cuenta aparte
 * y se avisa, nunca se mezcla.
 */
export async function loadMlSales(db, { now = Date.now(), months = 12 } = {}) {
  const desde = new Date(now);
  desde.setUTCDate(1);
  desde.setUTCHours(0, 0, 0, 0);
  desde.setUTCMonth(desde.getUTCMonth() - (months - 1));
  const last30 = now - 30 * DAY_MS;

  const [porMes, ultimos30, libros30, otraMoneda, cobertura] = await Promise.all([
    queryAll(db, `SELECT substr(date_created, 1, 7) AS month, COUNT(*) AS orders,
                         COALESCE(SUM(total_amount), 0) AS total_uyu
                    FROM ml_sales_orders
                   WHERE seller_id = ? AND status IN (${COUNTED_SQL}) AND currency_id = 'UYU'
                     AND date_created_ms >= ?
                   GROUP BY month`, [SALES_SELLER_ID, desde.getTime() - DAY_MS]),
    queryAll(db, `SELECT COUNT(*) AS orders, COALESCE(SUM(total_amount), 0) AS total_uyu
                    FROM ml_sales_orders
                   WHERE seller_id = ? AND status IN (${COUNTED_SQL}) AND currency_id = 'UYU'
                     AND date_created_ms >= ?`, [SALES_SELLER_ID, last30]),
    queryAll(db, `SELECT COALESCE(SUM(i.quantity), 0) AS units
                    FROM ml_sales_items i JOIN ml_sales_orders o ON o.order_id = i.order_id
                   WHERE o.seller_id = ? AND o.status IN (${COUNTED_SQL}) AND o.date_created_ms >= ?`,
    [SALES_SELLER_ID, last30]),
    queryAll(db, `SELECT COUNT(*) AS orders FROM ml_sales_orders
                   WHERE seller_id = ? AND status IN (${COUNTED_SQL})
                     AND COALESCE(currency_id, '') != 'UYU' AND date_created_ms >= ?`,
    [SALES_SELLER_ID, last30]),
    queryAll(db, 'SELECT MIN(date_created_ms) AS first_ms FROM ml_sales_orders WHERE seller_id = ?',
      [SALES_SELLER_ID]),
  ]);

  const firstMs = Number(cobertura[0]?.first_ms) || null;
  return {
    byMonth: new Map(porMes.map(row => [String(row.month), {
      orders: Number(row.orders) || 0,
      total_uyu: Math.round(Number(row.total_uyu) || 0),
    }])),
    last30: {
      orders: Number(ultimos30[0]?.orders) || 0,
      total_uyu: Math.round(Number(ultimos30[0]?.total_uyu) || 0),
      units: Number(libros30[0]?.units) || 0,
      otherCurrencyOrders: Number(otraMoneda[0]?.orders) || 0,
    },
    // Si la carga de ventas empezó después del primer mes del gráfico, los
    // meses anteriores no son cero: no hay dato. Se dice.
    coveredFrom: firstMs ? new Date(firstMs).toISOString().slice(0, 10) : null,
    partial: !firstMs || firstMs > desde.getTime(),
  };
}

/** La serie de la web con la de ML al lado, mes por mes. */
export function mergeRevenue(web, ml) {
  const months = (web?.months || []).map(fila => {
    const delMes = ml?.byMonth?.get(fila.month);
    return { ...fila, ml_uyu: delMes?.total_uyu || 0, ml_orders: delMes?.orders || 0 };
  });
  return {
    months,
    max: months.reduce((mayor, fila) => Math.max(mayor, fila.total_uyu + fila.ml_uyu), 0),
    withMl: Boolean(ml),
    mlCoveredFrom: ml?.partial ? ml.coveredFrom : null,
  };
}

/**
 * Lo que la gente buscó en la web y no encontró. `search_misses` guarda una
 * fila por día y búsqueda, ya normalizada y sin bots.
 */
export async function loadSearchMisses(db, { now = Date.now() } = {}) {
  const desde = new Date(now - SEARCH_MISS_DAYS * DAY_MS - 3 * 3600_000).toISOString().slice(0, 10);
  const [top, total] = await Promise.all([
    queryAll(db, `SELECT query, SUM(count) AS total, MAX(last_seen) AS last_seen, COUNT(*) AS days
                    FROM search_misses
                   WHERE date >= ?
                   GROUP BY query
                   ORDER BY total DESC, last_seen DESC
                   LIMIT ?`, [desde, SEARCH_MISS_LIMIT]),
    queryAll(db, `SELECT COUNT(DISTINCT query) AS queries, COALESCE(SUM(count), 0) AS searches
                    FROM search_misses WHERE date >= ?`, [desde]),
  ]);
  return {
    days: SEARCH_MISS_DAYS,
    top,
    queries: Number(total[0]?.queries) || 0,
    searches: Number(total[0]?.searches) || 0,
  };
}

function parseSamples(raw) {
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/**
 * Qué cambió en el catálogo en la última semana, sync por sync. Las muestras
 * (hasta unas pocas altas, bajas y cambios de precio) son las del último sync
 * que tuvo algún cambio: es el que vale la pena mirar.
 */
export async function loadCatalogChanges(db, { now = Date.now() } = {}) {
  const desde = new Date(now - CATALOG_CHANGE_DAYS * DAY_MS).toISOString();
  const rows = await queryAll(db, `SELECT synced_at, total_items, available_items, added, removed,
                                          price_up, price_down, out_of_stock, back_in_stock,
                                          baseline, samples_json
                                     FROM catalog_sync_log
                                    WHERE synced_at >= ?
                                    ORDER BY synced_at DESC
                                    LIMIT 200`, [desde]);
  // Un sync sin catálogo anterior (baseline = 0) no tiene contra qué comparar:
  // contarlo sumaría todo el catálogo como «altas».
  const comparables = rows.filter(row => Number(row.baseline) === 1);
  const suma = campo => comparables.reduce((total, row) => total + (Number(row[campo]) || 0), 0);
  const conCambios = comparables.find(row => ['added', 'removed', 'price_up', 'price_down']
    .some(campo => Number(row[campo]) > 0));
  const samples = conCambios ? parseSamples(conCambios.samples_json) : {};
  return {
    days: CATALOG_CHANGE_DAYS,
    syncs: rows.length,
    lastSync: rows[0] || null,
    totals: {
      added: suma('added'),
      removed: suma('removed'),
      price_up: suma('price_up'),
      price_down: suma('price_down'),
      out_of_stock: suma('out_of_stock'),
      back_in_stock: suma('back_in_stock'),
    },
    samplesFrom: conCambios?.synced_at || null,
    samples: {
      added: Array.isArray(samples.added) ? samples.added : [],
      removed: Array.isArray(samples.removed) ? samples.removed : [],
      price_changes: Array.isArray(samples.price_changes) ? samples.price_changes : [],
    },
  };
}

/** El mensaje que se le manda a quien pidió el aviso. El panel no lo envía: lo arma. */
export function whatsappRestockLink(row) {
  const phone = normalizePhone(row?.whatsapp);
  if (!phone) return '';
  const titulo = String(row?.product_title || '').trim();
  const texto = `Hola! Te escribo de Amado Libros: volvió a estar disponible${titulo ? ` «${titulo}»` : ' el libro que nos pediste'}. ¿Querés que te lo reservemos?`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(texto)}`;
}

/**
 * Avisos pedidos por WhatsApp que siguen esperando. Cuáles ya se pueden
 * avisar se decide en el tablero, cruzando con el stock del catálogo.
 */
export async function loadWhatsappWaitlist(db) {
  const rows = await queryAll(db, `SELECT id, product_id, product_title, whatsapp, created_at
                                     FROM stock_waitlist_whatsapp
                                    WHERE status = 'waiting'
                                    ORDER BY created_at ASC
                                    LIMIT ?`, [WHATSAPP_LIMIT]);
  return { waiting: rows };
}

/** «Ya le escribí»: saca el aviso de la lista. Sólo pasa de esperando a contactado. */
export async function markWhatsappContacted(db, id, { now = new Date() } = {}) {
  const clean = String(id || '').trim();
  if (!clean || clean.length > 100) return { ok: false };
  const result = await db.prepare(`UPDATE stock_waitlist_whatsapp
                                      SET status = 'contacted', updated_at = ?
                                    WHERE id = ? AND status = 'waiting'`)
    .bind(now.toISOString(), clean).run();
  return { ok: Number(result?.meta?.changes) === 1 };
}

/**
 * Amado Vintage en una tarjeta: publicadas contra el objetivo, altas de hoy
 * y de la semana, casos para revisar y si la lista de SBS está vigente. El
 * veredicto («anda», «trabado», «esperando a SBS») es el mismo que usa el
 * vigía del Worker para avisar por ntfy.
 */
export async function loadVintage(db, { now = Date.now() } = {}) {
  const hoy = montevideoDayStart(now);
  const [publicadas, ultima, objetivo, corrida, revisar, lista] = await Promise.all([
    queryAll(db, `SELECT COUNT(*) AS total,
                         SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS today,
                         SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS week
                    FROM ml_vintage_pub_receipts
                   WHERE seller_id = ? AND state = 'published'`,
    [hoy, now - 7 * DAY_MS, VINTAGE_SELLER_ID]),
    queryAll(db, `SELECT MAX(updated_at) AS at FROM ml_vintage_pub_receipts
                   WHERE seller_id = ? AND state = 'published'`, [VINTAGE_SELLER_ID]),
    queryAll(db, 'SELECT target_published FROM ml_vintage_pub_run_targets WHERE run_id = ?', [VINTAGE_RUN_ID]),
    queryAll(db, 'SELECT state FROM ml_vintage_pub_runs WHERE id = ?', [VINTAGE_RUN_ID]),
    queryAll(db, `SELECT COUNT(*) AS total FROM ml_vintage_pub_jobs
                   WHERE run_id = ? AND state IN ('review', 'uncertain')`, [VINTAGE_RUN_ID]),
    queryAll(db, `SELECT source_date, created_at FROM sbs_supplier_feeds
                   WHERE state = 'ready' ORDER BY created_at DESC LIMIT 1`),
  ]);

  const feed = lista[0] || null;
  const estado = {
    lastAltaAt: Number(ultima[0]?.at) || null,
    feedSourceAt: feed?.source_date ? Date.parse(feed.source_date) : null,
    feedLoadedAt: Number(feed?.created_at) || null,
    runState: corrida[0]?.state ?? null,
  };
  const veredicto = assess(estado, now, { stallMs: 45 * 60_000, warmupMs: 60 * 60_000, supplierGraceMs: 240 * 60_000 });
  return {
    published: Number(publicadas[0]?.total) || 0,
    today: Number(publicadas[0]?.today) || 0,
    week: Number(publicadas[0]?.week) || 0,
    target: Number(objetivo[0]?.target_published) || null,
    runState: estado.runState,
    review: Number(revisar[0]?.total) || 0,
    feedSourceDate: feed?.source_date || null,
    feedFresh: estado.feedSourceAt !== null && now - estado.feedSourceAt <= DAY_MS,
    lastAltaAt: estado.lastAltaAt,
    verdict: veredicto.state,
  };
}
