// Señal de salud de ventas ML y compras, sin dependencias: la usan el Worker
// (correo diario, ruta de GPT) y las Pages Functions (Salud del panel).
const HOUR_MS = 3600000;

export async function readSalesHealth(db) {
  const out = { sales: null, purchases: null };
  if (!db || typeof db.prepare !== 'function') return out;
  try {
    const s = await db.prepare('SELECT updated_at,cursor_json,last_result_json FROM ml_sales_sync_state WHERE name=?').bind('orders').first();
    if (s) {
      const last = await db.prepare('SELECT MAX(date_created) AS last_order FROM ml_sales_orders').first().catch(() => null);
      out.sales = { updated_at: Number(s.updated_at), cursor: JSON.parse(s.cursor_json), last: s.last_result_json ? JSON.parse(s.last_result_json) : null, last_order: last?.last_order ?? null };
    }
  } catch { /* tablas todavía no creadas */ }
  try {
    const p = await db.prepare('SELECT COUNT(*) AS n,MAX(updated_at) AS last FROM purchase_orders').first();
    out.purchases = { documents: Number(p?.n || 0), last_import: p?.last ? Number(p.last) : null };
  } catch { /* tabla todavía no creada */ }
  return out;
}

const hours = ms => Math.round(ms / HOUR_MS);

// problemas: algo que hay que mirar. notas: estado informativo.
export function evaluateSalesHealth(h, now = Date.now()) {
  const problemas = [], notas = [];
  const s = h?.sales;
  if (!s) notas.push('Ventas ML: todavía sin datos.');
  else {
    // El cron libera el estado cada 5 minutos aunque no haya nada que leer.
    if (now - s.updated_at > 2 * HOUR_MS) problemas.push(`Ventas ML: el sync de órdenes no corre hace ${hours(now - s.updated_at)} h.`);
    if (Number(s.last?.errors_in_row || 0) >= 3) problemas.push(`Ventas ML: ${s.last.errors_in_row} errores seguidos (${s.last.code || 'error'}).`);
    if (s.cursor?.phase === 'backfill') notas.push('Ventas ML: carga inicial en curso.');
    const filter = s.cursor?.inc_filter;
    notas.push(`Ventas ML: última orden ${s.last_order ? s.last_order.slice(0, 10) : '—'}; cambios de estado ${filter?.name ? 'por filtro verificado' : 'por barrido semanal'}${filter?.reason === 'sweep_missed' ? ' (el filtro perdió actualizaciones)' : ''}.`);
  }
  const p = h?.purchases;
  if (p) notas.push(p.documents ? `Compras: ${p.documents} documentos, última carga hace ${Math.max(0, Math.round((now - p.last_import) / 86400000))} días.` : 'Compras: todavía no se cargó ningún documento.');
  return { problemas, notas };
}
