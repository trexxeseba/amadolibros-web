const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 7000;
const MAX_SEND_ATTEMPTS = 3;
const CLAIM_STALE_MS = 5 * 60 * 1000;

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatMoney(value) {
  return `$${new Intl.NumberFormat('es-UY', { maximumFractionDigits: 0 }).format(Number(value) || 0)}`;
}

function resolveEmailConfig(env) {
  const apiKey = cleanString(env?.RESEND_API_KEY);
  const from = cleanString(env?.SALES_NOTIFICATION_FROM);
  const to = cleanString(env?.SALES_NOTIFICATION_TO)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  if (!apiKey || !from || to.length === 0) return null;
  return { apiKey, from, to };
}

function deliveryLines(order) {
  if (order.delivery_type === 'pickup') {
    // PICKUP-CX-1: el comprador acepto esperar la confirmacion. Este aviso
    // recuerda que avisarle es una accion pendiente nuestra. No se afirma que
    // se le mando un mail: el checkout no pide direccion de correo.
    return [
      'Entrega: PICK UP',
      'PICK UP — ACCIÓN PENDIENTE: avisar al cliente por WhatsApp cuando el ' +
      'pedido esté pronto. El cliente fue informado de que no debe concurrir ' +
      'antes de recibir la confirmación.',
    ];
  }

  const lines = [
    'Entrega: Envío',
    `Dirección: ${cleanString(order.address) || 'Sin dato'}`,
    `Localidad: ${cleanString(order.locality) || 'Sin dato'}`,
    `Departamento: ${cleanString(order.department) || 'Sin dato'}`,
  ];

  if (order.requested_delivery_date) {
    const time = order.requested_delivery_from && order.requested_delivery_to
      ? `, de ${order.requested_delivery_from} a ${order.requested_delivery_to}`
      : '';
    lines.push(`Fecha solicitada: ${order.requested_delivery_date}${time}`);
  }
  if (order.delivery_notes) lines.push(`Notas: ${order.delivery_notes}`);
  return lines;
}

export function buildSaleEmail({ order, items, payment }) {
  const itemLines = items.map(item =>
    `${item.quantity} × ${item.title} — ${formatMoney(item.line_total_uyu)}`
  );
  const delivery = deliveryLines(order);
  const subject = `Nueva venta web — ${order.public_code}`;

  const text = [
    `Nueva venta web confirmada: ${order.public_code}`,
    '',
    `Cliente: ${order.buyer_name}`,
    `Teléfono: ${order.buyer_phone}`,
    '',
    'Libros:',
    ...itemLines.map(line => `- ${line}`),
    '',
    `Productos: ${formatMoney(order.products_total_uyu)}`,
    `Descuento por retiro: ${formatMoney(order.pickup_discount_uyu)}`,
    `Envío: ${formatMoney(order.shipping_cost_uyu)}`,
    `Total pagado: ${formatMoney(order.payable_total_uyu)} UYU`,
    `Mercado Pago: aprobado (pago ${payment.id})`,
    '',
    ...delivery,
  ].join('\n');

  const itemRows = items.map(item => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(item.title)}</td>
      <td style="padding:8px;border-bottom:1px solid #ddd;text-align:center">${escapeHtml(item.quantity)}</td>
      <td style="padding:8px;border-bottom:1px solid #ddd;text-align:right">${escapeHtml(formatMoney(item.line_total_uyu))}</td>
    </tr>`).join('');

  const deliveryHtml = delivery
    .map(line => `<li style="margin:4px 0">${escapeHtml(line)}</li>`)
    .join('');

  const html = `<!doctype html>
<html lang="es">
  <body style="font-family:Arial,sans-serif;color:#222;line-height:1.45">
    <h1 style="font-size:22px">Nueva venta web confirmada</h1>
    <p><strong>Pedido:</strong> ${escapeHtml(order.public_code)}</p>
    <p><strong>Cliente:</strong> ${escapeHtml(order.buyer_name)}<br>
       <strong>Teléfono:</strong> ${escapeHtml(order.buyer_phone)}</p>
    <table style="border-collapse:collapse;width:100%;max-width:700px">
      <thead>
        <tr>
          <th style="padding:8px;text-align:left;border-bottom:2px solid #999">Libro</th>
          <th style="padding:8px;text-align:center;border-bottom:2px solid #999">Cant.</th>
          <th style="padding:8px;text-align:right;border-bottom:2px solid #999">Total</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>
    <p>
      Productos: ${escapeHtml(formatMoney(order.products_total_uyu))}<br>
      Descuento por retiro: ${escapeHtml(formatMoney(order.pickup_discount_uyu))}<br>
      Envío: ${escapeHtml(formatMoney(order.shipping_cost_uyu))}<br>
      <strong>Total pagado: ${escapeHtml(formatMoney(order.payable_total_uyu))} UYU</strong><br>
      Mercado Pago: aprobado (pago ${escapeHtml(payment.id)})
    </p>
    <ul>${deliveryHtml}</ul>
  </body>
</html>`;

  return { subject, text, html };
}

function parseEventState(payload) {
  try {
    const value = JSON.parse(payload);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

async function claimNotification(db, orderId, now) {
  const eventId = `sale-email:${orderId}`;
  const initialPayload = JSON.stringify({
    status: 'sending',
    attempt: 1,
    attempted_at: now.toISOString(),
  });
  const inserted = await db.prepare(
    "INSERT OR IGNORE INTO order_events (id,order_id,event_type,payload_json,created_at) VALUES (?,?,'sale_notification',?,?)"
  ).bind(eventId, orderId, initialPayload, now.toISOString()).run();

  if (Number(inserted?.meta?.changes) > 0) {
    return { claimed: true, eventId, attempt: 1, claimPayload: initialPayload };
  }

  const existing = await db.prepare(
    'SELECT payload_json FROM order_events WHERE id=?'
  ).bind(eventId).first();
  if (!existing) return { claimed: false, reason: 'claim_missing' };

  const state = parseEventState(existing.payload_json);
  if (state?.status === 'sent') return { claimed: false, reason: 'already_sent' };

  const attemptedAt = Date.parse(state?.attempted_at || '');
  const isFreshClaim = state?.status === 'sending' &&
    Number.isFinite(attemptedAt) &&
    now.getTime() - attemptedAt < CLAIM_STALE_MS;
  if (isFreshClaim) return { claimed: false, reason: 'in_progress' };

  const attempt = Number.isInteger(state?.attempt) && state.attempt > 0
    ? state.attempt + 1
    : 1;
  const retryPayload = JSON.stringify({
    status: 'sending',
    attempt,
    attempted_at: now.toISOString(),
  });
  const updated = await db.prepare(
    'UPDATE order_events SET payload_json=? WHERE id=? AND payload_json=?'
  ).bind(retryPayload, eventId, existing.payload_json).run();

  if (Number(updated?.meta?.changes) === 0) {
    return { claimed: false, reason: 'claim_lost' };
  }
  return { claimed: true, eventId, attempt, claimPayload: retryPayload };
}

async function updateClaim(db, claim, payload) {
  const nextPayload = JSON.stringify(payload);
  await db.prepare(
    'UPDATE order_events SET payload_json=? WHERE id=? AND payload_json=?'
  ).bind(nextPayload, claim.eventId, claim.claimPayload).run();
}

function safeFailureCode(value) {
  const code = cleanString(value);
  return /^[A-Z0-9_:-]{1,80}$/.test(code) ? code : 'RESEND_ERROR';
}

async function postToResend({ config, email, idempotencyKey, fetchFn, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        from: config.from,
        to: config.to,
        subject: email.subject,
        text: email.text,
        html: email.html,
      }),
      signal: controller.signal,
    });

    let data = null;
    try { data = await response.json(); } catch { /* body opcional */ }

    if (response.ok && typeof data?.id === 'string' && data.id) {
      return { ok: true, providerId: data.id };
    }
    return {
      ok: false,
      retryable: response.status === 429 || response.status >= 500,
      code: `RESEND_HTTP_${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      code: error?.name === 'AbortError' ? 'RESEND_TIMEOUT' : 'RESEND_NETWORK_ERROR',
    };
  } finally {
    clearTimeout(timer);
  }
}

export function createSaleNotificationSender({
  fetchFn = globalThis.fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  return async function sendSaleNotification({ db, env, order, payment, now }) {
    const config = resolveEmailConfig(env);
    if (!config) {
      console.warn('[sale-notification] configuración ausente', {
        order_id: order.id,
      });
      return { ok: false, skipped: true, code: 'EMAIL_CONFIG_MISSING' };
    }

    let claim;
    try {
      claim = await claimNotification(db, order.id, now);
    } catch (error) {
      console.error('[sale-notification] no se pudo registrar el intento', {
        order_id: order.id,
        error: error?.name || 'Error',
      });
      return { ok: false, code: 'EMAIL_CLAIM_ERROR' };
    }
    if (!claim.claimed) return { ok: true, skipped: true, reason: claim.reason };

    let items;
    try {
      const result = await db.prepare(
        'SELECT title,quantity,unit_price_uyu,line_total_uyu FROM order_items WHERE order_id=? ORDER BY created_at,id'
      ).bind(order.id).all();
      items = Array.isArray(result?.results) ? result.results : [];
      if (items.length === 0) throw new Error('OrderItemsMissing');
    } catch (error) {
      await updateClaim(db, claim, {
        status: 'failed',
        attempt: claim.attempt,
        attempted_at: now.toISOString(),
        failure_code: 'ORDER_ITEMS_UNAVAILABLE',
      }).catch(() => {});
      console.error('[sale-notification] no se pudieron leer los libros', {
        order_id: order.id,
        error: error?.name || 'Error',
      });
      return { ok: false, code: 'ORDER_ITEMS_UNAVAILABLE' };
    }

    const email = buildSaleEmail({ order, items, payment });
    const idempotencyKey = `sale-notification/${order.id}`;
    let result = null;

    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
      result = await postToResend({
        config,
        email,
        idempotencyKey,
        fetchFn,
        timeoutMs,
      });
      if (result.ok || !result.retryable || attempt === MAX_SEND_ATTEMPTS) break;
      await sleep(250 * (2 ** (attempt - 1)));
    }

    if (result?.ok) {
      await updateClaim(db, claim, {
        status: 'sent',
        attempt: claim.attempt,
        attempted_at: now.toISOString(),
        sent_at: now.toISOString(),
        provider: 'resend',
        provider_id: result.providerId,
      }).catch(error => {
        console.error('[sale-notification] correo enviado pero no se pudo confirmar en D1', {
          order_id: order.id,
          error: error?.name || 'Error',
        });
      });
      return { ok: true, providerId: result.providerId };
    }

    const failureCode = safeFailureCode(result?.code);
    await updateClaim(db, claim, {
      status: 'failed',
      attempt: claim.attempt,
      attempted_at: now.toISOString(),
      failure_code: failureCode,
    }).catch(() => {});
    console.error('[sale-notification] Resend no confirmó el correo', {
      order_id: order.id,
      code: failureCode,
    });
    return { ok: false, code: failureCode };
  };
}

export const sendSaleNotification = createSaleNotificationSender();
