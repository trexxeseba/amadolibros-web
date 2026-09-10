/**
 * functions/_shared/panel-notice.js
 *
 * Los dos avisos que una persona del equipo le manda al cliente desde la ficha
 * del pedido: "ya lo podés retirar" y "tu envío sale hoy".
 *
 * Es la primera vez que el panel le escribe a un cliente, así que las reglas
 * de cuándo NO se manda están acá, sueltas y sin efectos, para poder probarlas:
 *
 *   - el aviso de retiro necesita la dirección y los horarios cargados en
 *     Ajustes; sin eso el correo sería "vení a retirarlo" sin decir a dónde;
 *   - cada aviso corresponde a su tipo de entrega y no al otro;
 *   - un pedido sin correo del comprador no se puede avisar;
 *   - un pedido cancelado o vencido no se avisa.
 *
 * El envío en sí lo hace `createTrackedEmailSender`, que reclama el aviso en
 * `order_events` antes de mandarlo: un doble clic no manda dos correos, y el
 * intento queda en el historial del pedido salga bien o salga mal.
 *
 * Lo que NO hace: no toca el pedido. No lo marca despachado, no cambia estado,
 * no toca precio ni stock ni catálogo. Escribe una fila de historial y manda un
 * correo, nada más.
 */

const NOTICE_KIND = Object.freeze({
  PICKUP_READY: 'pickup_ready',
  SHIPPING_TODAY: 'shipping_today',
});

export const NOTICE_KINDS = Object.freeze(Object.values(NOTICE_KIND));

export const NOTICE_EVENT_TYPE = Object.freeze({
  [NOTICE_KIND.PICKUP_READY]: 'panel_pickup_ready_email',
  [NOTICE_KIND.SHIPPING_TODAY]: 'panel_shipping_today_email',
});

export const NOTICE_LABEL = Object.freeze({
  [NOTICE_KIND.PICKUP_READY]: 'Avisar que está listo para retirar',
  [NOTICE_KIND.SHIPPING_TODAY]: 'Avisar que el envío sale hoy',
});

// Estados en los que ya no tiene sentido avisarle nada al cliente.
const DEAD_STATUSES = new Set(['cancelled', 'expired']);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function paragraphs(lines) {
  return lines.filter(Boolean).map(line => `<p>${escapeHtml(line).replaceAll('\n', '<br>')}</p>`).join('');
}

/**
 * El id del aviso en `order_events`. Es fijo a propósito: es lo que hace que
 * el mismo aviso no salga dos veces para el mismo pedido.
 */
export function noticeEventId(kind, orderId) {
  return `panel-notice:${kind}:${orderId}`;
}

/**
 * Por qué este aviso no se puede mandar todavía, o cadena vacía si se puede.
 * Es pura: no lee KV ni la base, recibe todo armado. El texto que devuelve se
 * muestra tal cual en el panel, así que dice qué hacer, no qué falló.
 *
 * @param {object} input
 * @param {string} input.kind    uno de NOTICE_KINDS
 * @param {object} input.order   el pedido
 * @param {object} input.pickup  los datos de retiro cargados en Ajustes
 * @returns {string} motivo del bloqueo, o '' si se puede mandar
 */
export function noticeBlockedReason({ kind, order, pickup }) {
  if (!NOTICE_KINDS.includes(kind)) return 'Ese aviso no existe.';
  if (!cleanString(order?.buyer_email)) {
    return 'Este pedido no tiene correo del comprador, así que hay que avisarle por WhatsApp.';
  }
  if (DEAD_STATUSES.has(String(order?.status || ''))) {
    return 'El pedido está cancelado o vencido: no corresponde avisarle nada al cliente.';
  }

  if (kind === NOTICE_KIND.PICKUP_READY) {
    if (order?.delivery_type !== 'pickup') {
      return 'Este pedido es un envío, no un retiro.';
    }
    // El correo diría "vení a retirarlo" sin decir a dónde ni cuándo.
    if (!cleanString(pickup?.address) || !cleanString(pickup?.zone) || !cleanString(pickup?.hours)) {
      return 'Falta cargar la dirección, el barrio y los horarios en Ajustes.';
    }
    return '';
  }

  if (order?.delivery_type !== 'shipping') {
    return 'Este pedido es un retiro en el local, no un envío.';
  }
  return '';
}

export function buildPickupReadyEmail({ order, pickup }) {
  const code = cleanString(order?.public_code);
  const name = cleanString(order?.buyer_name);
  const days = Number(pickup?.holdDays) > 0 ? Number(pickup.holdDays) : null;

  const lines = [
    name ? `Hola ${name},` : 'Hola,',
    `Tu pedido ${code} ya está preparado y te espera en el local.`,
    `Dónde: ${pickup.address}, ${pickup.zone}`,
    `Cuándo: ${pickup.hours}`,
    days ? `Te lo guardamos ${days} día${days === 1 ? '' : 's'}. Si necesitás más tiempo, avisanos y lo dejamos apartado.` : '',
    'Vení con el número de pedido a mano. Si tenés cualquier duda, respondé este correo.',
    'Gracias por comprar en Amado Libros.',
  ];

  return {
    subject: `Tu pedido ${code} está listo para retirar`,
    text: lines.filter(Boolean).join('\n\n'),
    html: `<!doctype html><html lang="es"><body style="font-family:Arial,sans-serif;color:#222;line-height:1.5">
    <h1 style="font-size:22px">Tu pedido está listo para retirar</h1>
    ${paragraphs(lines)}
  </body></html>`,
  };
}

export function buildShippingTodayEmail({ order }) {
  const code = cleanString(order?.public_code);
  const name = cleanString(order?.buyer_name);
  const destino = [order?.address, order?.locality, order?.department]
    .map(cleanString).filter(Boolean).join(', ');

  const lines = [
    name ? `Hola ${name},` : 'Hola,',
    `Tu pedido ${code} sale hoy.`,
    destino ? `Va a: ${destino}` : '',
    'Cuando la agencia lo tenga en camino te vamos a poder dar más detalles. Si nadie va a estar en esa dirección, respondé este correo y lo coordinamos.',
    'Gracias por comprar en Amado Libros.',
  ];

  return {
    subject: `Tu pedido ${code} sale hoy`,
    text: lines.filter(Boolean).join('\n\n'),
    html: `<!doctype html><html lang="es"><body style="font-family:Arial,sans-serif;color:#222;line-height:1.5">
    <h1 style="font-size:22px">Tu pedido sale hoy</h1>
    ${paragraphs(lines)}
  </body></html>`,
  };
}

export function buildNoticeEmail({ kind, order, pickup }) {
  return kind === NOTICE_KIND.PICKUP_READY
    ? buildPickupReadyEmail({ order, pickup })
    : buildShippingTodayEmail({ order });
}

/**
 * Lee del historial ya cargado qué avisos salieron y cuáles fallaron, para que
 * la ficha muestre "ya avisado" en vez de ofrecer el botón otra vez.
 */
export function noticeStateFromEvents(events) {
  const state = {};
  for (const kind of NOTICE_KINDS) {
    const eventType = NOTICE_EVENT_TYPE[kind];
    const row = (Array.isArray(events) ? events : []).find(item => item?.event_type === eventType);
    if (!row) { state[kind] = { status: 'none' }; continue; }
    let parsed = null;
    try { parsed = JSON.parse(row.payload_json); } catch { parsed = null; }
    state[kind] = {
      status: cleanString(parsed?.status) || 'unknown',
      at: cleanString(parsed?.sent_at) || cleanString(parsed?.attempted_at) || cleanString(row.created_at),
      failureCode: cleanString(parsed?.failure_code),
    };
  }
  return state;
}

/**
 * Manda el aviso. Devuelve siempre `{ ok, message }` con el texto que se le
 * muestra a la persona: el panel no tiene que interpretar códigos.
 */
export async function sendNotice({ sendTrackedEmail, db, env, order, kind, pickup, now = new Date() }) {
  const blocked = noticeBlockedReason({ kind, order, pickup });
  if (blocked) return { ok: false, message: blocked };

  const result = await sendTrackedEmail({
    db,
    env,
    orderId: order.id,
    to: order.buyer_email,
    email: buildNoticeEmail({ kind, order, pickup }),
    eventId: noticeEventId(kind, order.id),
    eventType: NOTICE_EVENT_TYPE[kind],
    now,
  });

  if (result?.skipped && result.reason === 'already_sent') {
    return { ok: true, message: 'Ese aviso ya se le había mandado. No se manda de nuevo.' };
  }
  if (result?.skipped && result.reason === 'in_progress') {
    return { ok: true, message: 'El aviso se está mandando en este momento. Recargá en unos segundos.' };
  }
  if (result?.skipped && result.code === 'EMAIL_CONFIG_MISSING') {
    return { ok: false, message: 'Falta configurar el correo saliente en este entorno.' };
  }
  if (result?.ok) {
    return { ok: true, message: `Listo, le avisamos a ${order.buyer_email}.` };
  }
  return {
    ok: false,
    message: `No se pudo mandar el correo (${cleanString(result?.code) || 'error desconocido'}). `
      + 'Quedó anotado en el historial y podés reintentar.',
  };
}
