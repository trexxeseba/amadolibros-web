/**
 * functions/_shared/panel-order-actions.js
 *
 * Lo que se puede hacer con un pedido desde el panel, de a uno o en lote:
 *
 *   despachar   pagado sin despachar → despachado (fulfilled_at)
 *   deshacer    despachado → vuelve a pagado sin despachar (por un clic de más)
 *   cancelar    sólo pedidos SIN cobrar (abiertos o vencidos). Uno cobrado se
 *               devuelve primero en Mercado Pago; el panel no mueve plata.
 *   archivar    lo saca de las listas; no borra nada
 *   desarchivar lo vuelve a mostrar
 *
 * Nada se borra: un pedido es una venta, y lo que se quiere es que deje de
 * molestar en la lista, no perder el historial. Es lo mismo que hacen los
 * paneles de Shopify o Tiendanube.
 *
 * Cada UPDATE repite en el WHERE el estado del que parte, así un doble clic o
 * dos personas a la vez no pisan un cambio que llegó en el medio (un pago de
 * Mercado Pago, por ejemplo). El evento del historial sólo se escribe si el
 * pedido cambió de verdad.
 */

const ORDER_CODE_RE = /^AL-[0-9]{6}-[A-Z0-9]{6}$/;
export const MAX_BULK = 50;

export const ORDER_ACTIONS = {
  despachar: {
    event: 'panel_fulfilled',
    label: 'Marcado como despachado en el panel',
    hecho: n => `${n} pedido${n === 1 ? '' : 's'} marcado${n === 1 ? '' : 's'} como despachado${n === 1 ? '' : 's'}.`,
    set: 'status = \'fulfilled\', fulfilled_at = ?1, updated_at = ?1',
    where: "status = 'paid' AND payment_status = 'approved' AND fulfilled_at IS NULL",
  },
  deshacer: {
    event: 'panel_unfulfilled',
    label: 'Despacho deshecho en el panel',
    hecho: n => `${n} pedido${n === 1 ? '' : 's'} vuelve${n === 1 ? '' : 'n'} a «pagado sin despachar».`,
    set: 'status = \'paid\', fulfilled_at = NULL, updated_at = ?1',
    where: "status = 'fulfilled' AND payment_status = 'approved'",
  },
  cancelar: {
    event: 'panel_cancelled',
    label: 'Cancelado en el panel',
    hecho: n => `${n} pedido${n === 1 ? '' : 's'} cancelado${n === 1 ? '' : 's'}.`,
    set: 'status = \'cancelled\', cancelled_at = ?1, updated_at = ?1',
    where: "status IN ('open','expired') AND payment_status NOT IN ('approved','refunded')",
  },
  archivar: {
    event: 'panel_archived',
    label: 'Archivado en el panel',
    hecho: n => `${n} pedido${n === 1 ? '' : 's'} archivado${n === 1 ? '' : 's'}.`,
    set: 'archived_at = ?1, updated_at = ?1',
    where: 'archived_at IS NULL',
  },
  desarchivar: {
    event: 'panel_unarchived',
    label: 'Desarchivado en el panel',
    hecho: n => `${n} pedido${n === 1 ? '' : 's'} desarchivado${n === 1 ? '' : 's'}.`,
    set: 'archived_at = NULL, updated_at = ?1',
    where: 'archived_at IS NOT NULL',
  },
};

/** Qué acciones tiene sentido ofrecer para un pedido, en el orden en que se muestran. */
export function availableActions(order) {
  if (!order) return [];
  const out = [];
  const cobrado = order.payment_status === 'approved';
  if (order.status === 'paid' && cobrado && !order.fulfilled_at) out.push('despachar');
  if (order.status === 'fulfilled' && cobrado) out.push('deshacer');
  if (['open', 'expired'].includes(order.status) && !['approved', 'refunded'].includes(order.payment_status)) out.push('cancelar');
  out.push(order.archived_at ? 'desarchivar' : 'archivar');
  return out;
}

/** Limpia la lista de códigos que llega del formulario: válidos, sin repetir, con tope. */
export function cleanCodes(raw) {
  const list = (Array.isArray(raw) ? raw : [raw])
    .map(value => String(value ?? '').trim().toUpperCase())
    .filter(code => ORDER_CODE_RE.test(code));
  return [...new Set(list)].slice(0, MAX_BULK);
}

/**
 * Aplica una acción a uno o varios pedidos (por código público).
 * Devuelve { ok, changed, skipped, message }. `skipped` son los que no
 * estaban en el estado de partida: no es un error, simplemente no aplicaba.
 */
export async function applyOrderAction({ db, action, codes, now = new Date() }) {
  const spec = ORDER_ACTIONS[action];
  if (!spec) return { ok: false, changed: 0, skipped: 0, message: 'Acción desconocida.' };
  const list = cleanCodes(codes);
  if (!list.length) return { ok: false, changed: 0, skipped: 0, message: 'No elegiste ningún pedido.' };
  if (!db || typeof db.batch !== 'function') {
    return { ok: false, changed: 0, skipped: 0, message: 'La base de pedidos no está disponible en este entorno.' };
  }

  const at = now.toISOString();
  const statements = [];
  for (const code of list) {
    // El evento primero, condicionado al mismo WHERE: así sólo queda registro
    // de los pedidos que de verdad van a cambiar con el UPDATE de abajo.
    statements.push(db.prepare(
      'INSERT OR IGNORE INTO order_events (id, order_id, event_type, payload_json, created_at) ' +
      `SELECT ?2 || ':' || id || ':' || ?1, id, ?2, ?3, ?1 FROM orders WHERE public_code = ?4 AND ${spec.where}`,
    ).bind(at, spec.event, JSON.stringify({ source: 'panel', action }), code));
    statements.push(db.prepare(
      `UPDATE orders SET ${spec.set} WHERE public_code = ?2 AND ${spec.where}`,
    ).bind(at, code));
  }

  let results;
  try {
    results = await db.batch(statements);
  } catch {
    return { ok: false, changed: 0, skipped: 0, message: 'No se pudo guardar. Probá de nuevo en un momento.' };
  }
  const changed = results.filter((_, index) => index % 2 === 1)
    .reduce((total, result) => total + (Number(result?.meta?.changes) > 0 ? 1 : 0), 0);
  const skipped = list.length - changed;
  if (!changed) {
    return { ok: false, changed, skipped, message: 'Ningún pedido cambió: ya estaban así o su estado no lo permite. Recargá para ver cómo quedaron.' };
  }
  return {
    ok: true,
    changed,
    skipped,
    message: spec.hecho(changed) + (skipped ? ` ${skipped} no cambiaron porque su estado no lo permitía.` : ''),
  };
}

export const ORDER_ACTION_EVENT_LABEL = Object.fromEntries(
  Object.values(ORDER_ACTIONS).map(spec => [spec.event, spec.label]),
);
