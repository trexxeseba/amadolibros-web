/**
 * RADAR DATA 2 (#276) — lectura de ventas reales de Mercado Libre.
 *
 * Usa el OAuth rotativo de worker-sync y mlGet(), por lo que hereda retry,
 * backoff y tratamiento de HTTP 206 como respuesta exitosa (Response.ok).
 * No persiste ni expone PII de compradores.
 */

import { createSyncRetryBudget, mlGet } from './meli-catalog.js';

export const DEFAULT_ORDER_PAGE_LIMIT = 50;
export const DEFAULT_MAX_ORDER_PAGES = 200;
const DATE_FIELDS = new Set(['closed', 'last_updated', 'created']);

function normalizedIso(value) {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) throw new Error(`[ML sales] Fecha inválida: ${value}`);
  return new Date(parsed).toISOString();
}

export function buildSellerOrdersUrl({
  sellerId,
  dateFrom,
  dateTo,
  status = 'paid',
  dateField = 'closed',
  offset = 0,
  limit = DEFAULT_ORDER_PAGE_LIMIT,
} = {}) {
  if (!sellerId) throw new Error('[ML sales] sellerId es requerido.');
  if (!dateFrom || !dateTo) throw new Error('[ML sales] dateFrom y dateTo son requeridos.');
  if (!DATE_FIELDS.has(dateField)) throw new Error(`[ML sales] dateField inválido: ${dateField}`);
  const params = new URLSearchParams({
    seller: String(sellerId),
    [`order.date_${dateField}.from`]: normalizedIso(dateFrom),
    [`order.date_${dateField}.to`]: normalizedIso(dateTo),
    sort: 'date_desc',
    offset: String(Math.max(0, Number(offset) || 0)),
    limit: String(Math.min(50, Math.max(1, Number(limit) || DEFAULT_ORDER_PAGE_LIMIT))),
  });
  if (status) params.set('order.status', String(status));
  return `https://api.mercadolibre.com/orders/search?${params.toString()}`;
}

export async function fetchSellerOrdersPage(accessToken, options = {}) {
  const {
    retryBudget = createSyncRetryBudget(),
    mlGetDeps = {},
    ...query
  } = options;
  const url = buildSellerOrdersUrl(query);
  return mlGet(url, accessToken, { ...mlGetDeps, retryBudget });
}

export async function fetchSellerOrders(accessToken, {
  sellerId,
  dateFrom,
  dateTo,
  status = 'paid',
  dateField = 'closed',
  limit = DEFAULT_ORDER_PAGE_LIMIT,
  maxPages = DEFAULT_MAX_ORDER_PAGES,
  retryBudget = createSyncRetryBudget(),
  mlGetDeps = {},
} = {}) {
  const orders = [];
  let offset = 0;
  let pages = 0;
  let total = null;

  while (pages < maxPages) {
    const payload = await fetchSellerOrdersPage(accessToken, {
      sellerId,
      dateFrom,
      dateTo,
      status,
      dateField,
      offset,
      limit,
      retryBudget,
      mlGetDeps,
    });
    const results = Array.isArray(payload?.results) ? payload.results : [];
    const paging = payload?.paging || {};
    if (Number.isFinite(Number(paging.total))) total = Number(paging.total);
    orders.push(...results);
    pages++;

    if (results.length === 0) break;
    offset += results.length;
    if (total != null && offset >= total) break;
    if (results.length < Math.min(50, Math.max(1, Number(limit) || DEFAULT_ORDER_PAGE_LIMIT))) break;
  }

  if (pages >= maxPages && total != null && offset < total) {
    throw new Error(`[ML sales] Paginación incompleta: ${offset}/${total} órdenes tras ${maxPages} páginas.`);
  }

  const deduped = new Map();
  for (const order of orders) {
    if (order?.id == null) continue;
    deduped.set(String(order.id), order);
  }
  return {
    orders: [...deduped.values()],
    pages,
    total_reported: total,
  };
}

function finiteMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Convierte órdenes a filas por order_id/item_id. Si una orden repite el
 * mismo item_id, agrega cantidades y calcula precio unitario ponderado para
 * conservar la clave idempotente (order_id, item_id).
 *
 * También normaliza órdenes que ya no estén `paid`: el mantenimiento consulta
 * por `date_last_updated` sin filtro de estado para que una cancelación/cambio
 * posterior reemplace la fila anterior y deje de contarse en los agregados.
 */
export function normalizeMlOrderItems(orders, { observedAt = new Date().toISOString() } = {}) {
  const rows = new Map();

  for (const order of orders || []) {
    if (order?.id == null) continue;
    const orderId = String(order.id);
    const orderStatus = String(order.status || 'unknown');
    const dateCreated = order.date_created || null;
    if (!dateCreated) continue;
    const dateClosed = order.date_closed || null;
    const dateLastUpdated = order.date_last_updated || null;
    const commercialDate = dateClosed || order.paid_date || dateCreated;

    for (const line of order.order_items || []) {
      const itemId = line?.item?.id ? String(line.item.id) : null;
      const quantity = Number(line?.quantity);
      const unitPrice = finiteMoney(line?.unit_price);
      if (!itemId || !Number.isFinite(quantity) || quantity <= 0 || unitPrice == null) continue;
      const grossPrice = finiteMoney(line?.gross_price);
      const currencyId = line?.currency_id || order.currency_id || null;
      const key = `${orderId}::${itemId}`;
      const lineRevenue = unitPrice * quantity;
      const grossRevenue = grossPrice == null ? null : grossPrice * quantity;
      const existing = rows.get(key);

      if (!existing) {
        rows.set(key, {
          order_id: orderId,
          item_id: itemId,
          quantity,
          unit_price: unitPrice,
          gross_price: grossPrice,
          currency_id: currencyId,
          order_status: orderStatus,
          date_created: dateCreated,
          date_closed: dateClosed,
          date_last_updated: dateLastUpdated,
          commercial_date: commercialDate,
          observed_at: observedAt,
          _revenue: lineRevenue,
          _gross_revenue: grossRevenue,
        });
        continue;
      }

      existing.quantity += quantity;
      existing._revenue += lineRevenue;
      existing.unit_price = existing._revenue / existing.quantity;
      if (grossRevenue != null) {
        existing._gross_revenue = (existing._gross_revenue || 0) + grossRevenue;
        existing.gross_price = existing._gross_revenue / existing.quantity;
      }
      if (dateLastUpdated && (!existing.date_last_updated || dateLastUpdated > existing.date_last_updated)) {
        existing.date_last_updated = dateLastUpdated;
      }
    }
  }

  return [...rows.values()].map(({ _revenue, _gross_revenue, ...row }) => row);
}

export function summarizeNormalizedSales(rows) {
  const byItem = new Map();
  for (const row of rows || []) {
    if (row.order_status && row.order_status !== 'paid') continue;
    const current = byItem.get(row.item_id) || { item_id: row.item_id, units: 0, revenue: 0, last_sale_at: null };
    current.units += Number(row.quantity) || 0;
    current.revenue += (Number(row.unit_price) || 0) * (Number(row.quantity) || 0);
    if (!current.last_sale_at || row.commercial_date > current.last_sale_at) current.last_sale_at = row.commercial_date;
    byItem.set(row.item_id, current);
  }
  return [...byItem.values()].sort((a, b) => b.units - a.units || String(a.item_id).localeCompare(String(b.item_id)));
}
