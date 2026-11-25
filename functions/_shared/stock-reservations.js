// Reservas de stock entre compradores de la web.
//
// El catálogo trae el stock de la última sincronización con Mercado Libre.
// Entre una sincronización y la siguiente, la web no sabía qué había vendido
// ella misma: dos personas podían pagar el mismo ejemplar. Acá se descuenta,
// leyendo los pedidos que ya existen (no hay tabla nueva):
//
//   Venta firme   pedidos web pagados después de la foto del catálogo, y
//                 pagos pendientes (Abitab, RedPagos) de los últimos días.
//                 El ejemplar ya no está: se descuenta en el carrito y en el
//                 alta del pedido.
//   Reserva       pedidos abiertos de OTRA persona que todavía no vencieron
//                 (una hora). El ejemplar puede volver: no se muestra como
//                 agotado, se pide reintentar en unos minutos.
//
// Los pedidos abiertos de la misma persona (mismo correo o mismo teléfono) no
// cuentan: quien cambia la entrega o el medio de pago genera un pedido nuevo y
// no puede quedar bloqueado por su propio pedido anterior.
//
// No cambia precios, totales ni reglas de envío, y no toca Mercado Libre: una
// venta hecha en Mercado Libre se sigue viendo recién en la sincronización.

export const PENDING_HOLD_HOURS = 72;
// La sincronización tarda varios minutos en leer Mercado Libre: una venta web
// pagada justo antes de que termine puede no estar reflejada en la foto.
export const SYNC_MARGIN_MINUTES = 15;
// Sin fecha de catálogo se asume el peor caso: un día y un poco.
export const UNKNOWN_CATALOG_AGE_HOURS = 26;

const NOT_CANCELLED = "o.status <> 'cancelled' AND o.cancelled_at IS NULL";
const FIRM = "((o.payment_status = 'pending' AND o.updated_at > ?) OR (o.payment_status = 'approved' AND o.paid_at > ?))";
const HOLD = "(o.status = 'open' AND o.payment_status NOT IN ('approved','pending') AND o.expires_at > ?)";
const OTHER_BUYER = "(COALESCE(o.buyer_email,'') <> ? AND COALESCE(o.buyer_phone,'') <> ?)";

export function stockWindows({ now, catalogUpdatedAt }) {
  const nowMs = now.getTime();
  const catalogMs = Date.parse(catalogUpdatedAt || '');
  const soldSinceMs = Number.isFinite(catalogMs) && catalogMs <= nowMs
    ? catalogMs - SYNC_MARGIN_MINUTES * 60_000
    : nowMs - UNKNOWN_CATALOG_AGE_HOURS * 3_600_000;
  return {
    nowIso: now.toISOString(),
    pendingSince: new Date(nowMs - PENDING_HOLD_HOURS * 3_600_000).toISOString(),
    soldSince: new Date(soldSinceMs).toISOString(),
  };
}

async function sumByProduct(db, sql, productIds, binds) {
  const totals = new Map();
  for (let i = 0; i < productIds.length; i += 40) {
    const chunk = productIds.slice(i, i + 40);
    const result = await db.prepare(sql.replace('__IDS__', chunk.map(() => '?').join(',')))
      .bind(...chunk, ...binds).all();
    for (const row of Array.isArray(result?.results) ? result.results : []) {
      const quantity = Number(row.quantity);
      if (typeof row.product_id === 'string' && Number.isFinite(quantity) && quantity > 0) {
        totals.set(row.product_id, quantity);
      }
    }
  }
  return totals;
}

const SUM_SQL = where =>
  'SELECT oi.product_id AS product_id, SUM(oi.quantity) AS quantity ' +
  'FROM order_items oi JOIN orders o ON o.id = oi.order_id ' +
  `WHERE oi.product_id IN (__IDS__) AND ${NOT_CANCELLED} AND ${where} GROUP BY oi.product_id`;

/** Unidades ya vendidas por la web que la foto del catálogo todavía no refleja. */
export function loadFirmSold(db, productIds, windows) {
  return sumByProduct(db, SUM_SQL(FIRM), productIds, [windows.pendingSince, windows.soldSince]);
}

/** Unidades reservadas por pedidos abiertos de otras personas. */
export function loadHeldByOthers(db, productIds, windows, buyer) {
  return sumByProduct(db, SUM_SQL(`${HOLD} AND ${OTHER_BUYER}`), productIds,
    [windows.nowIso, buyer.email || '', buyer.phone || '']);
}

/** Copia del catálogo con el stock descontado en los productos indicados. */
export function reduceAvailability(catalogItems, soldByProduct) {
  if (!soldByProduct || soldByProduct.size === 0) return catalogItems;
  return catalogItems.map(item => {
    const sold = item && typeof item.id === 'string' ? soldByProduct.get(item.id) : 0;
    if (!sold) return item;
    const available = Number(item.available_quantity);
    if (!Number.isInteger(available)) return item;
    return { ...item, available_quantity: Math.max(0, available - sold) };
  });
}

/**
 * Candado atómico para el alta del pedido. Va al final del mismo lote que
 * inserta el pedido y sus libros: si, contando este pedido, lo comprometido
 * supera el stock del catálogo, la sentencia intenta insertar un evento con el
 * id del evento «created» que ya está en el lote, falla por clave repetida y
 * la base deshace el lote entero. Así dos altas simultáneas del último
 * ejemplar no pueden pasar las dos.
 */
export function stockGuardStatements(db, { orderId, createdEventId, createdAt, lines, windows, buyer }) {
  const sql =
    'INSERT INTO order_events (id,order_id,event_type,payload_json,created_at) ' +
    "SELECT ?,?,'stock_guard',NULL,? WHERE (" +
      'SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi JOIN orders o ON o.id = oi.order_id ' +
      `WHERE oi.product_id = ? AND ${NOT_CANCELLED} AND (${FIRM} OR (${HOLD} AND (o.id = ? OR ${OTHER_BUYER})))` +
    ') > ?';
  return lines.map(line => db.prepare(sql).bind(
    createdEventId, orderId, createdAt,
    line.product_id, windows.pendingSince, windows.soldSince, windows.nowIso,
    orderId, buyer.email || '', buyer.phone || '',
    line.catalog_available,
  ));
}

export function heldMessage(titles) {
  const names = titles.filter(Boolean).map(title => `«${title}»`);
  const subject = names.length === 0 ? 'uno de los libros de tu carrito'
    : names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} y ${names.at(-1)}`;
  return `En este momento otra persona está completando la compra de ${subject}. ` +
    'Si no la concreta, vuelve a estar disponible en unos minutos. ' +
    'Podés intentar de nuevo en un rato o escribirnos por WhatsApp y te avisamos.';
}
