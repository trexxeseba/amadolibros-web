/**
 * worker-sync/visits-store.js
 *
 * RADAR DATA 1 (issue #275) — persistencia D1 de la serie diaria de
 * visitas (tabla item_daily_visits, migración 0010) y derivación de
 * ventanas 7/30/90 por query, sin guardar agregados redundantes.
 *
 * "Sin inventar ceros ante datos ausentes" (criterio de salida del issue):
 * si no hay ninguna fila para un item_id dentro de la ventana pedida,
 * `visits` es `null`, no 0. `days_with_data` siempre viaja junto al total
 * para que quien lea el resultado sepa si la ventana está completa o es
 * parcial (por ejemplo, 3 de 7 días si el sync arrancó hace poco).
 */

export async function upsertDailyVisits(env, rows) {
  const db = env?.ORDERS_DB;
  if (!db) return { status: 'skipped', reason: 'orders_db_missing', written: 0 };
  let written = 0;
  for (const row of rows) {
    await db.prepare(
      `INSERT INTO item_daily_visits (item_id, visit_date, visits, source, observed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(item_id, visit_date) DO UPDATE SET
         visits = excluded.visits,
         source = excluded.source,
         observed_at = excluded.observed_at`
    ).bind(row.item_id, row.visit_date, row.visits, row.source, row.observed_at).run();
    written++;
  }
  return { status: 'ok', written };
}

/**
 * Serie diaria cruda para un item_id, opcionalmente acotada a [from, to]
 * (inclusive, formato 'YYYY-MM-DD'). Es el "readout" para validar a mano
 * que un número 7/30/90 realmente sale de días concretos observados.
 */
export async function getDailyVisits(env, itemId, { from, to } = {}) {
  const db = env?.ORDERS_DB;
  if (!db || !itemId) return [];
  const conditions = ['item_id = ?'];
  const params = [itemId];
  if (from) { conditions.push('visit_date >= ?'); params.push(from); }
  if (to) { conditions.push('visit_date <= ?'); params.push(to); }
  const result = await db.prepare(
    `SELECT visit_date, visits, source, observed_at FROM item_daily_visits
     WHERE ${conditions.join(' AND ')} ORDER BY visit_date ASC`
  ).bind(...params).all();
  return result?.results || [];
}

function isoDateMinusDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - (days - 1));
  return date.toISOString().slice(0, 10);
}

/**
 * Ventanas 7/30/90 (configurable) derivadas de la serie diaria, tomando
 * `asOf` como el último día calendario a incluir (default: hoy UTC).
 */
export async function getVisitWindows(env, itemId, { asOf, windows = [7, 30, 90] } = {}) {
  const asOfDate = asOf || new Date().toISOString().slice(0, 10);
  const earliestFrom = isoDateMinusDays(asOfDate, Math.max(...windows));
  const rows = await getDailyVisits(env, itemId, { from: earliestFrom, to: asOfDate });

  const result = {};
  for (const windowDays of windows) {
    const from = isoDateMinusDays(asOfDate, windowDays);
    const inWindow = rows.filter(row => row.visit_date >= from && row.visit_date <= asOfDate);
    result[windowDays] = inWindow.length === 0
      ? { visits: null, days_with_data: 0, window_days: windowDays, data_through: null }
      : {
          visits: inWindow.reduce((sum, row) => sum + Number(row.visits || 0), 0),
          days_with_data: inWindow.length,
          window_days: windowDays,
          data_through: inWindow[inWindow.length - 1].visit_date,
        };
  }

  return { item_id: itemId, as_of: asOfDate, windows: result };
}
