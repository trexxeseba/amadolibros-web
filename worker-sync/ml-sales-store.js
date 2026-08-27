/**
 * RADAR DATA 2 (#276) — persistencia D1 y consultas de ventas por MLU.
 */

const UPSERT_SQL = `
INSERT INTO ml_order_items (
  order_id, item_id, quantity, unit_price, gross_price, currency_id,
  order_status, date_created, date_closed, date_last_updated,
  commercial_date, observed_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(order_id, item_id) DO UPDATE SET
  quantity=excluded.quantity,
  unit_price=excluded.unit_price,
  gross_price=excluded.gross_price,
  currency_id=excluded.currency_id,
  order_status=excluded.order_status,
  date_created=excluded.date_created,
  date_closed=excluded.date_closed,
  date_last_updated=excluded.date_last_updated,
  commercial_date=excluded.commercial_date,
  observed_at=excluded.observed_at
`;

function dbFrom(env) {
  if (!env?.ORDERS_DB || typeof env.ORDERS_DB.prepare !== 'function') {
    throw new Error('[ML sales] ORDERS_DB no disponible.');
  }
  return env.ORDERS_DB;
}

export async function upsertMlOrderItems(env, rows, { batchSize = 50 } = {}) {
  const db = dbFrom(env);
  const input = Array.isArray(rows) ? rows : [];
  let written = 0;

  for (let offset = 0; offset < input.length; offset += batchSize) {
    const chunk = input.slice(offset, offset + batchSize);
    const statements = chunk.map(row => db.prepare(UPSERT_SQL).bind(
      row.order_id,
      row.item_id,
      row.quantity,
      row.unit_price,
      row.gross_price ?? null,
      row.currency_id ?? null,
      row.order_status,
      row.date_created,
      row.date_closed ?? null,
      row.date_last_updated ?? null,
      row.commercial_date,
      row.observed_at,
    ));
    if (typeof db.batch === 'function') {
      await db.batch(statements);
    } else {
      for (const statement of statements) await statement.run();
    }
    written += chunk.length;
  }

  return { status: 'ok', written };
}

export async function writeMlSalesSyncState(env, {
  coverageFrom = null,
  coverageTo = null,
  lastSyncAt = new Date().toISOString(),
  status,
  orderCount = 0,
  itemRows = 0,
  error = null,
} = {}) {
  const db = dbFrom(env);
  await db.prepare(`
    INSERT INTO ml_sales_sync_state (
      id, coverage_from, coverage_to, last_sync_at, last_status,
      last_order_count, last_item_rows, last_error
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      coverage_from=excluded.coverage_from,
      coverage_to=excluded.coverage_to,
      last_sync_at=excluded.last_sync_at,
      last_status=excluded.last_status,
      last_order_count=excluded.last_order_count,
      last_item_rows=excluded.last_item_rows,
      last_error=excluded.last_error
  `).bind(
    coverageFrom,
    coverageTo,
    lastSyncAt,
    status || 'unknown',
    Number(orderCount) || 0,
    Number(itemRows) || 0,
    error ? String(error).slice(0, 400) : null,
  ).run();
}

export async function getMlSalesSyncState(env) {
  const db = dbFrom(env);
  const row = await db.prepare(`
    SELECT coverage_from, coverage_to, last_sync_at, last_status,
           last_order_count, last_item_rows, last_error
    FROM ml_sales_sync_state WHERE id = 1
  `).first();
  return row || null;
}

export async function getMlSalesWindows(env, itemId, {
  asOf = new Date().toISOString(),
} = {}) {
  const db = dbFrom(env);
  if (!itemId) throw new Error('[ML sales] itemId es requerido.');
  const row = await db.prepare(`
    SELECT
      SUM(CASE WHEN julianday(commercial_date) > julianday(?) - 7  THEN quantity ELSE 0 END) AS units_7,
      COUNT(DISTINCT CASE WHEN julianday(commercial_date) > julianday(?) - 7  THEN order_id END) AS orders_7,
      SUM(CASE WHEN julianday(commercial_date) > julianday(?) - 7  THEN unit_price * quantity ELSE 0 END) AS revenue_7,
      SUM(CASE WHEN julianday(commercial_date) > julianday(?) - 30 THEN quantity ELSE 0 END) AS units_30,
      COUNT(DISTINCT CASE WHEN julianday(commercial_date) > julianday(?) - 30 THEN order_id END) AS orders_30,
      SUM(CASE WHEN julianday(commercial_date) > julianday(?) - 30 THEN unit_price * quantity ELSE 0 END) AS revenue_30,
      SUM(CASE WHEN julianday(commercial_date) > julianday(?) - 90 THEN quantity ELSE 0 END) AS units_90,
      COUNT(DISTINCT CASE WHEN julianday(commercial_date) > julianday(?) - 90 THEN order_id END) AS orders_90,
      SUM(CASE WHEN julianday(commercial_date) > julianday(?) - 90 THEN unit_price * quantity ELSE 0 END) AS revenue_90,
      MAX(commercial_date) AS last_sale_at,
      COUNT(*) AS observed_rows
    FROM ml_order_items
    WHERE item_id = ?
      AND order_status = 'paid'
      AND julianday(commercial_date) <= julianday(?)
  `).bind(
    asOf, asOf, asOf,
    asOf, asOf, asOf,
    asOf, asOf, asOf,
    itemId, asOf,
  ).first();

  const state = await getMlSalesSyncState(env);
  const observedRows = Number(row?.observed_rows) || 0;
  const coverage = state ? {
    from: state.coverage_from || null,
    to: state.coverage_to || null,
    last_sync_at: state.last_sync_at || null,
    status: state.last_status || null,
  } : null;

  return {
    item_id: itemId,
    as_of: asOf,
    coverage,
    windows: {
      '7': {
        units: observedRows || state ? Number(row?.units_7) || 0 : null,
        orders: observedRows || state ? Number(row?.orders_7) || 0 : null,
        revenue: observedRows || state ? Number(row?.revenue_7) || 0 : null,
      },
      '30': {
        units: observedRows || state ? Number(row?.units_30) || 0 : null,
        orders: observedRows || state ? Number(row?.orders_30) || 0 : null,
        revenue: observedRows || state ? Number(row?.revenue_30) || 0 : null,
      },
      '90': {
        units: observedRows || state ? Number(row?.units_90) || 0 : null,
        orders: observedRows || state ? Number(row?.orders_90) || 0 : null,
        revenue: observedRows || state ? Number(row?.revenue_90) || 0 : null,
      },
    },
    last_sale_at: row?.last_sale_at || null,
    observed_rows: observedRows,
  };
}

export async function getMlOrderItemsForItem(env, itemId, { limit = 100 } = {}) {
  const db = dbFrom(env);
  if (!itemId) throw new Error('[ML sales] itemId es requerido.');
  const result = await db.prepare(`
    SELECT order_id, item_id, quantity, unit_price, gross_price, currency_id,
           order_status, date_created, date_closed, date_last_updated,
           commercial_date, observed_at
    FROM ml_order_items
    WHERE item_id = ?
    ORDER BY commercial_date DESC
    LIMIT ?
  `).bind(itemId, Math.min(500, Math.max(1, Number(limit) || 100))).all();
  return Array.isArray(result?.results) ? result.results : [];
}
