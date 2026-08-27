/**
 * worker-sync/radar-store.js
 *
 * Persistencia idempotente de RADAR AMADO en D1 (tabla radar_alerts,
 * migración 0010). D1 es la fuente de verdad — Airtable (PR6 futuro) será
 * únicamente un espejo sincronizado desde acá, nunca al revés.
 *
 * Reglas de idempotencia:
 *   - La fila se identifica por `alert_type::item_id` (ver radarAlertId).
 *   - Si la alerta ya existía y sigue vigente: se actualiza en el lugar
 *     (severity/score/reasons/metrics/last_seen_at), nunca se duplica.
 *   - Si una alerta abierta no vuelve a calcularse en la corrida actual, se
 *     marca resolved (conserva first_seen_at y el resto del historial).
 *   - Si vuelve a aparecer más tarde, se reabre (status=open,
 *     resolved_at=NULL) conservando el first_seen_at original.
 */

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };

export function radarAlertId(alertType, itemId) {
  return `${alertType}::${itemId}`;
}

function safeParseArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeParseObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Cuenta cuántas personas esperan cada producto en stock_waitlist. Sólo
 * cuenta filas 'waiting' — notified/cancelled ya no son demanda activa.
 */
export async function getWaitlistCounts(env) {
  const counts = new Map();
  const db = env?.ORDERS_DB;
  if (!db) return counts;
  const result = await db.prepare(
    "SELECT product_id, COUNT(*) AS waiting_count FROM stock_waitlist WHERE status = 'waiting' GROUP BY product_id"
  ).bind().all();
  for (const row of (result?.results || [])) {
    counts.set(row.product_id, Number(row.waiting_count) || 0);
  }
  return counts;
}

/**
 * Escribe/actualiza cada alerta calculada y resuelve las que ya no aplican.
 * Nunca lanza si ORDERS_DB no está disponible: devuelve status 'skipped'
 * igual que el resto de los pasos opcionales de runSync.
 */
export async function persistRadarAlerts(env, alerts, { now = new Date().toISOString() } = {}) {
  const db = env?.ORDERS_DB;
  if (!db) {
    return { status: 'skipped', reason: 'orders_db_missing', examined: 0, open: 0, resolved: 0 };
  }

  const seenIds = new Set();
  for (const alert of alerts) {
    const id = radarAlertId(alert.alert_type, alert.item_id);
    seenIds.add(id);
    await db.prepare(
      `INSERT INTO radar_alerts (
         id, alert_type, item_id, isbn, title, severity, status,
         score, score_version, reasons_json, metrics_json,
         first_seen_at, last_seen_at, resolved_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         isbn = excluded.isbn,
         title = excluded.title,
         severity = excluded.severity,
         status = 'open',
         score = excluded.score,
         score_version = excluded.score_version,
         reasons_json = excluded.reasons_json,
         metrics_json = excluded.metrics_json,
         last_seen_at = excluded.last_seen_at,
         resolved_at = NULL`
    ).bind(
      id,
      alert.alert_type,
      alert.item_id,
      alert.isbn || null,
      alert.title,
      alert.severity,
      alert.score ?? null,
      alert.score_version ?? null,
      JSON.stringify(alert.reasons || []),
      JSON.stringify(alert.metrics || {}),
      now,
      now,
    ).run();
  }

  const openRows = await db.prepare("SELECT id FROM radar_alerts WHERE status = 'open'").bind().all();
  const openIds = (openRows?.results || []).map(row => row.id);
  let resolved = 0;
  for (const id of openIds) {
    if (seenIds.has(id)) continue;
    await db.prepare(
      "UPDATE radar_alerts SET status = 'resolved', resolved_at = ? WHERE id = ? AND status = 'open'"
    ).bind(now, id).run();
    resolved++;
  }

  return { status: 'ok', examined: alerts.length, open: seenIds.size, resolved };
}

/**
 * Lee las alertas vigentes (status='open') para el endpoint /radar/summary.
 */
export async function fetchOpenRadarAlerts(env) {
  const db = env?.ORDERS_DB;
  if (!db) return [];
  const result = await db.prepare(
    `SELECT id, alert_type, item_id, isbn, title, severity, score, score_version,
            reasons_json, metrics_json, first_seen_at, last_seen_at
     FROM radar_alerts WHERE status = 'open'`
  ).bind().all();
  return (result?.results || []).map(row => ({
    id: row.id,
    alert_type: row.alert_type,
    item_id: row.item_id,
    isbn: row.isbn || null,
    title: row.title,
    severity: row.severity,
    score: row.score ?? null,
    score_version: row.score_version || null,
    reasons: safeParseArray(row.reasons_json),
    metrics: safeParseObject(row.metrics_json),
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
  }));
}

function compareAlerts(a, b) {
  const scoreDiff = (b.score ?? -1) - (a.score ?? -1);
  if (scoreDiff !== 0) return scoreDiff;
  const severityDiff = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
  if (severityDiff !== 0) return severityDiff;
  return String(a.item_id).localeCompare(String(b.item_id));
}

// Orden de negocio: lo más urgente de resolver primero (ver ticket RADAR AMADO).
const SUMMARY_TYPE_ORDER = [
  'REPOSICION_URGENTE',
  'AGOTADO',
  'CLIENTES_ESPERANDO',
  'PUBLICACION_PAUSADA',
  'CORREGIR_ISBN',
];

/**
 * Agrupa alertas abiertas para una salida operativa, no técnica: conteos
 * por tipo + ítems concretos ordenados por prioridad dentro de cada tipo.
 */
export function summarizeRadarAlerts(alerts, { generatedAt = new Date().toISOString() } = {}) {
  const byType = new Map(SUMMARY_TYPE_ORDER.map(type => [type, []]));
  for (const alert of alerts) {
    if (!byType.has(alert.alert_type)) byType.set(alert.alert_type, []);
    byType.get(alert.alert_type).push(alert);
  }

  const counts = {};
  const items = {};
  for (const [type, list] of byType) {
    const sorted = [...list].sort(compareAlerts);
    counts[type] = sorted.length;
    items[type] = sorted;
  }

  return { generated_at: generatedAt, total_open: alerts.length, counts, items };
}
