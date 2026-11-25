/**
 * Entrega de informes y alarmas internos: próxima ventana diaria de las 20:00
 * de America/Montevideo (UTC-3). Resend conserva el correo hasta scheduled_at.
 * No se usa en correos transaccionales de clientes o avisos de venta.
 */
export function nextInternalEmailAt(now = new Date()) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new TypeError('Fecha inválida');
  const target = new Date(instant);
  target.setUTCHours(23, 0, 0, 0);
  if (target.getTime() <= instant.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  return target.toISOString();
}
