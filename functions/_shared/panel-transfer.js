/**
 * functions/_shared/panel-transfer.js
 *
 * «Transferencia recibida»: la única forma de que un pedido pagado por
 * transferencia deje de verse igual que uno abandonado. Lo marca una persona
 * del equipo desde la ficha del pedido cuando ve la plata en el banco.
 *
 * Qué hace, y nada más:
 *   - pasa el pedido a pagado (status='paid', payment_status='approved'),
 *     con payment_provider='bank_transfer', la fecha y el monto realmente
 *     cobrado (el total con el 12 % de descuento en libros);
 *   - deja una fila `transfer_confirmed` en el historial con el monto.
 *
 * Funciona aunque el pedido figure vencido: la transferencia suele llegar
 * después de la hora de reserva. No toca stock, catálogo ni Mercado Libre, y
 * no le escribe al cliente (eso se coordina por WhatsApp, como hasta ahora).
 */

import { calculateTransferTotals } from '../api/_orders_logic.js';

export const TRANSFER_CONFIRMED_EVENT = 'transfer_confirmed';
export const TRANSFER_PROVIDER = 'bank_transfer';

export function transferEventId(orderId) {
  return `transfer-confirmed:${orderId}`;
}

/** El monto que se cobra por transferencia, calculado con la regla del checkout. */
export function transferAmountFor(order) {
  const totals = calculateTransferTotals({
    productsTotal: Number(order?.products_total_uyu) || 0,
    pickupDiscount: Number(order?.pickup_discount_uyu) || 0,
    shippingCost: Number(order?.shipping_cost_uyu) || 0,
  });
  return {
    amount: totals.transferPayableTotal,
    discount: totals.transferDiscount,
    listTotal: Number(order?.payable_total_uyu) || 0,
  };
}

/**
 * Por qué no se puede marcar, o '' si se puede. Pura, para poder probarla.
 * El texto se muestra tal cual en el panel.
 */
export function transferBlockedReason(order) {
  if (!order) return 'Pedido no encontrado.';
  if (order.payment_status === 'approved') {
    return order.payment_provider === TRANSFER_PROVIDER
      ? 'Ya está marcado como transferencia recibida.'
      : 'Este pedido ya está cobrado por Mercado Pago.';
  }
  if (order.payment_status === 'refunded') return 'Este pedido tiene un pago devuelto.';
  if (order.status === 'cancelled') return 'El pedido está cancelado.';
  if (!['open', 'expired'].includes(order.status)) return 'El pedido no está pendiente de pago.';
  return '';
}

/**
 * Marca la transferencia. El UPDATE repite las condiciones de
 * `transferBlockedReason` para que un doble clic o dos personas a la vez no
 * pisen un pago de Mercado Pago que llegó en el medio, y el evento sólo se
 * inserta si el pedido quedó efectivamente cobrado por transferencia.
 */
export async function confirmTransfer({ db, order, now = new Date() }) {
  const blocked = transferBlockedReason(order);
  if (blocked) {
    const done = blocked.startsWith('Ya está marcado');
    return { ok: done, message: blocked };
  }
  if (!db || typeof db.batch !== 'function') {
    return { ok: false, message: 'La base de pedidos no está disponible en este entorno.' };
  }

  const at = now.toISOString();
  const { amount, discount, listTotal } = transferAmountFor(order);
  const payload = JSON.stringify({
    method: TRANSFER_PROVIDER,
    amount_uyu: amount,
    transfer_discount_uyu: discount,
    list_total_uyu: listTotal,
    previous_status: order.status,
  });

  let results;
  try {
    results = await db.batch([
      db.prepare(
        "UPDATE orders SET status='paid', payment_status='approved', payment_provider=?, " +
        'paid_amount_uyu=?, paid_at=?, updated_at=? ' +
        "WHERE id=? AND status IN ('open','expired') AND payment_status NOT IN ('approved','refunded')"
      ).bind(TRANSFER_PROVIDER, amount, at, at, order.id),
      db.prepare(
        'INSERT OR IGNORE INTO order_events (id,order_id,event_type,payload_json,created_at) ' +
        `SELECT ?,?,'${TRANSFER_CONFIRMED_EVENT}',?,? WHERE EXISTS ` +
        "(SELECT 1 FROM orders WHERE id=? AND payment_provider=? AND payment_status='approved')"
      ).bind(transferEventId(order.id), order.id, payload, at, order.id, TRANSFER_PROVIDER),
    ]);
  } catch {
    return { ok: false, message: 'No se pudo guardar. Probá de nuevo en un momento.' };
  }

  if (!(Number(results?.[0]?.meta?.changes) > 0)) {
    return { ok: false, message: 'El pedido cambió mientras tanto. Recargá la ficha para ver su estado.' };
  }
  return { ok: true, message: `Listo: transferencia de $ ${amount.toLocaleString('es-UY')} marcada como recibida.` };
}
