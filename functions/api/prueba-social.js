// Ventas recientes de Mercado Libre para los carteles de prueba social.
// Lee las tablas ml_sales_* de D1 (las llena el Worker de sincronización).
// Devuelve solo título y antigüedad en días: nunca comprador, ciudad, pedido
// ni monto. Si no hay base o no hay ventas, responde lista vacía.

const DAY_MS = 86400000;
const WINDOW_DAYS = 14;

export function buildSales(rows, now = Date.now(), max = 8) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const titulo = String(row?.title ?? '').replace(/\s+/g, ' ').trim();
    const ms = Number(row?.date_created_ms);
    if (!titulo || !Number.isFinite(ms) || ms > now + 3600000) continue;
    const key = titulo.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ titulo, dias: Math.max(0, Math.floor((now - ms) / DAY_MS)) });
    if (out.length >= max) break;
  }
  return out;
}

export async function onRequest(ctx) {
  const headers = { 'cache-control': 'public,max-age=900', 'x-robots-tag': 'noindex' };
  const db = ctx?.env?.ORDERS_DB;
  if (!db) return Response.json({ ventas: [] }, { headers });
  const now = Date.now();
  try {
    const { results } = await db
      .prepare(
        `SELECT i.title AS title, o.date_created_ms AS date_created_ms
           FROM ml_sales_orders o JOIN ml_sales_items i ON i.order_id = o.order_id
          WHERE o.status = 'paid' AND o.date_created_ms >= ? AND i.title IS NOT NULL AND i.title <> ''
          ORDER BY o.date_created_ms DESC LIMIT 40`,
      )
      .bind(now - WINDOW_DAYS * DAY_MS)
      .all();
    return Response.json({ ventas: buildSales(results, now) }, { headers });
  } catch {
    return Response.json({ ventas: [] }, { headers });
  }
}
