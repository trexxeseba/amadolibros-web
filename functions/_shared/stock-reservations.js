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
// La misma persona (mismo correo o mismo teléfono) no queda bloqueada por su
// propio pedido anterior: quien cambia la entrega o el medio de pago genera un
// pedido nuevo. Pero sus pedidos SÍ cuentan para el stock. Si el ejemplar no
// alcanza para los dos, el pedido nuevo reemplaza al anterior: el anterior se
// cancela en el mismo lote que crea el nuevo, y su link de pago de Mercado
// Pago se vence antes. Nunca quedan dos pedidos abiertos de la misma persona
// por el último ejemplar.
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
const SAME_BUYER = "(COALESCE(o.buyer_email,'') = ? OR COALESCE(o.buyer_phone,'') = ?)";
// Todo lo comprometido de un producto: ventas firmes y pedidos abiertos de
// cualquiera, incluida la misma persona. Parámetros: producto, pendingSince,
// soldSince, nowIso.
const COMMITTED_SQL =
  '(SELECT COALESCE(SUM(ci.quantity),0) FROM order_items ci JOIN orders o ON o.id = ci.order_id ' +
  `WHERE ci.product_id = ? AND ${NOT_CANCELLED} AND (${FIRM} OR ${HOLD}))`;
// Pedidos abiertos de la misma persona, distintos del nuevo, que llevan el
// producto. Parámetros: nowIso, pedido nuevo, correo, teléfono, producto.
const OWN_OPEN_WITH_PRODUCT =
  `FROM orders o WHERE ${NOT_CANCELLED} AND ${HOLD} AND o.id <> ? AND ${SAME_BUYER} ` +
  'AND EXISTS (SELECT 1 FROM order_items x WHERE x.order_id = o.id AND x.product_id = ?)';

export const isLivePreference = id => typeof id === 'string' && id.length > 0 && !id.startsWith('creating:');

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

/**
 * Pedidos abiertos de la misma persona que llevan alguno de los productos:
 * una fila por pedido y producto, con el link de pago del pedido si lo tiene.
 */
export async function loadOwnOpen(db, productIds, windows, buyer) {
  const rows = [];
  for (let i = 0; i < productIds.length; i += 40) {
    const chunk = productIds.slice(i, i + 40);
    const result = await db.prepare(
      'SELECT o.id AS order_id, o.payment_preference_id AS preference_id, oi.product_id AS product_id, SUM(oi.quantity) AS quantity ' +
      'FROM order_items oi JOIN orders o ON o.id = oi.order_id ' +
      `WHERE oi.product_id IN (${chunk.map(() => '?').join(',')}) AND ${NOT_CANCELLED} AND ${HOLD} AND ${SAME_BUYER} ` +
      'GROUP BY o.id, oi.product_id'
    ).bind(...chunk, windows.nowIso, buyer.email || '', buyer.phone || '').all();
    for (const row of Array.isArray(result?.results) ? result.results : []) rows.push(row);
  }
  return rows;
}

/**
 * Pedidos propios que el pedido nuevo va a reemplazar: los que llevan un
 * producto cuyo stock no alcanza para el pedido nuevo más todo lo ya
 * comprometido. Es la misma cuenta que hace `supersedeStatements` en la base.
 */
export function ownOrdersToSupersede({ lines, firm, heldByOthers, ownOpen }) {
  const ownByProduct = new Map();
  for (const row of ownOpen) ownByProduct.set(row.product_id, (ownByProduct.get(row.product_id) || 0) + Number(row.quantity || 0));
  const tight = new Set(lines.filter(line => Number.isInteger(line.catalog_available) &&
    line.quantity + (firm.get(line.product_id) || 0) + (heldByOthers.get(line.product_id) || 0) +
      (ownByProduct.get(line.product_id) || 0) > line.catalog_available).map(line => line.product_id));
  const orders = new Map();
  for (const row of ownOpen) {
    if (tight.has(row.product_id)) orders.set(row.order_id, { id: row.order_id, preference_id: row.preference_id ?? null });
  }
  return [...orders.values()];
}

/**
 * Reemplazo de los pedidos propios, dentro del lote que crea el pedido nuevo
 * y antes del candado. Por cada libro: si lo comprometido (contando el pedido
 * nuevo) supera el stock, los pedidos abiertos de la misma persona que llevan
 * ese libro quedan anotados como reemplazados y cancelados. Un pedido
 * cancelado no puede pedir link de pago ni confirmarse por transferencia.
 */
export function supersedeStatements(db, { orderId, at, lines, windows, buyer }) {
  const email = buyer.email || '';
  const phone = buyer.phone || '';
  const payload = JSON.stringify({ replaced_by: orderId });
  const statements = [];
  for (const line of lines) {
    const own = [windows.nowIso, orderId, email, phone, line.product_id];
    const committed = [line.product_id, windows.pendingSince, windows.soldSince, windows.nowIso, line.catalog_available];
    statements.push(db.prepare(
      'INSERT OR IGNORE INTO order_events (id,order_id,event_type,payload_json,created_at) ' +
      `SELECT 'superseded:' || o.id, o.id, 'superseded', ?, ? ${OWN_OPEN_WITH_PRODUCT} AND ${COMMITTED_SQL} > ?`
    ).bind(payload, at, ...own, ...committed));
    statements.push(db.prepare(
      "UPDATE orders SET status = 'cancelled', cancelled_at = ?, updated_at = ? " +
      `WHERE id IN (SELECT o.id ${OWN_OPEN_WITH_PRODUCT}) AND ${COMMITTED_SQL} > ?`
    ).bind(at, at, ...own, ...committed));
  }
  return statements;
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
 *
 * Cuenta los pedidos abiertos de cualquiera, también los de la misma persona:
 * los que había que reemplazar ya los canceló `supersedeStatements`.
 */
export function stockGuardStatements(db, { orderId, createdEventId, createdAt, lines, windows }) {
  const sql =
    'INSERT INTO order_events (id,order_id,event_type,payload_json,created_at) ' +
    "SELECT ?,?,'stock_guard',NULL,? WHERE (" +
      'SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi JOIN orders o ON o.id = oi.order_id ' +
      `WHERE oi.product_id = ? AND ${NOT_CANCELLED} AND (${FIRM} OR ${HOLD})` +
    ') > ?';
  return lines.map(line => db.prepare(sql).bind(
    createdEventId, orderId, createdAt,
    line.product_id, windows.pendingSince, windows.soldSince, windows.nowIso,
    line.catalog_available,
  ));
}

export function ownPaymentMessage() {
  return 'Ya tenés un pago iniciado por este libro. Podés terminarlo en la pestaña de Mercado Pago ' +
    'o intentar de nuevo en unos minutos. Si preferís, escribinos por WhatsApp y te ayudamos.';
}

export function heldMessage(titles) {
  const names = titles.filter(Boolean).map(title => `«${title}»`);
  const subject = names.length === 0 ? 'uno de los libros de tu carrito'
    : names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} y ${names.at(-1)}`;
  return `En este momento otra persona está completando la compra de ${subject}. ` +
    'Si no la concreta, vuelve a estar disponible en unos minutos. ' +
    'Podés intentar de nuevo en un rato o escribirnos por WhatsApp y te avisamos.';
}
