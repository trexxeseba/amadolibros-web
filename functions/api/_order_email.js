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

function emailConfig(env) {
  const apiKey = cleanString(env?.RESEND_API_KEY);
  const from = cleanString(env?.SALES_NOTIFICATION_FROM);
  const internalTo = cleanString(env?.SALES_NOTIFICATION_TO)
    .split(',').map(value => value.trim()).filter(Boolean);
  if (!apiKey || !from) return null;
  return { apiKey, from, internalTo };
}

function deliveryText(order) {
  if (order.delivery_type === 'pickup') {
    return 'Retiro a pasos de Plaza Matriz. Esperá nuestra confirmación por WhatsApp antes de venir.';
  }
  return [order.address, order.locality, order.department].map(cleanString).filter(Boolean).join(', ');
}

function itemText(items) {
  return items.map(item => `${item.quantity} × ${item.title} — ${formatMoney(item.line_total_uyu)}`);
}

function itemRows(items) {
  return items.map(item => `<tr>
    <td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(item.title)}</td>
    <td style="padding:8px;border-bottom:1px solid #ddd;text-align:center">${escapeHtml(item.quantity)}</td>
    <td style="padding:8px;border-bottom:1px solid #ddd;text-align:right">${escapeHtml(formatMoney(item.line_total_uyu))}</td>
  </tr>`).join('');
}

function totalsText(order, payment) {
  const lines = [`Productos: ${formatMoney(order.products_total_uyu)}`];
  if (Number(order.pickup_discount_uyu) > 0) {
    lines.push(`Descuento por retiro: −${formatMoney(order.pickup_discount_uyu)}`);
  }
  if (Number(order.shipping_cost_uyu) > 0) {
    lines.push(`Envío: ${formatMoney(order.shipping_cost_uyu)}`);
  } else if (order.delivery_type === 'shipping') {
    lines.push('Envío: Gratis');
  }
  if (payment.method === 'bank_transfer') {
    lines.push(`Descuento por transferencia: −${formatMoney(payment.transfer_discount_uyu)}`);
    lines.push(`Total a transferir: ${formatMoney(payment.total_uyu)} UYU`);
  } else {
    lines.push(`Total pagado: ${formatMoney(order.payable_total_uyu)} UYU`);
  }
  return lines;
}

export function buildCustomerOrderEmail({ order, items, payment }) {
  const transfer = payment.method === 'bank_transfer';
  const subject = transfer
    ? `Recibimos tu pedido ${order.public_code} — pendiente de transferencia`
    : `Pago confirmado — pedido ${order.public_code}`;
  const heading = transfer ? 'Recibimos tu pedido' : 'Tu pago fue confirmado';
  const state = transfer
    ? 'El pedido queda pendiente hasta que Amado Libros confirme el comprobante por WhatsApp.'
    : 'El pago con Mercado Pago fue aprobado. Vamos a coordinar la entrega contigo.';
  const totals = totalsText(order, payment);
  const delivery = deliveryText(order);

  const text = [
    heading,
    '',
    `Pedido: ${order.public_code}`,
    `Cliente: ${order.buyer_name}`,
    '',
    'Libros:',
    ...itemText(items).map(line => `- ${line}`),
    '',
    ...totals,
    '',
    `Entrega: ${delivery}`,
    '',
    state,
    'Si necesitás ayuda, respondé este correo o escribinos por WhatsApp.',
  ].join('\n');

  const html = `<!doctype html><html lang="es"><body style="font-family:Arial,sans-serif;color:#222;line-height:1.5">
    <h1 style="font-size:22px">${escapeHtml(heading)}</h1>
    <p><strong>Pedido:</strong> ${escapeHtml(order.public_code)}<br>
       <strong>Cliente:</strong> ${escapeHtml(order.buyer_name)}</p>
    <table style="border-collapse:collapse;width:100%;max-width:700px">
      <thead><tr><th style="padding:8px;text-align:left;border-bottom:2px solid #999">Libro</th><th style="padding:8px;border-bottom:2px solid #999">Cant.</th><th style="padding:8px;text-align:right;border-bottom:2px solid #999">Total</th></tr></thead>
      <tbody>${itemRows(items)}</tbody>
    </table>
    <p>${totals.map(line => escapeHtml(line)).join('<br>')}</p>
    <p><strong>Entrega:</strong> ${escapeHtml(delivery)}</p>
    <p>${escapeHtml(state)}</p>
    <p>Si necesitás ayuda, respondé este correo o escribinos por WhatsApp.</p>
  </body></html>`;
  return { subject, text, html };
}

export function buildInternalTransferEmail({ order, items, payment }) {
  const subject = `Pedido por transferencia pendiente — ${order.public_code}`;
  const totals = totalsText(order, payment);
  const text = [
    `Nuevo pedido por transferencia: ${order.public_code}`,
    'ESTADO: pendiente de comprobante y confirmación.',
    '',
    `Cliente: ${order.buyer_name}`,
    `Teléfono: ${order.buyer_phone}`,
    `Correo: ${order.buyer_email}`,
    '',
    ...itemText(items).map(line => `- ${line}`),
    '',
    ...totals,
    `Entrega: ${deliveryText(order)}`,
  ].join('\n');
  const html = `<!doctype html><html lang="es"><body style="font-family:Arial,sans-serif;color:#222;line-height:1.5">
    <h1 style="font-size:22px">Pedido por transferencia pendiente</h1>
    <p><strong>${escapeHtml(order.public_code)}</strong> — pendiente de comprobante y confirmación.</p>
    <p><strong>Cliente:</strong> ${escapeHtml(order.buyer_name)}<br><strong>Teléfono:</strong> ${escapeHtml(order.buyer_phone)}<br><strong>Correo:</strong> ${escapeHtml(order.buyer_email)}</p>
    <ul>${itemText(items).map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
    <p>${totals.map(line => escapeHtml(line)).join('<br>')}</p>
    <p><strong>Entrega:</strong> ${escapeHtml(deliveryText(order))}</p>
  </body></html>`;
  return { subject, text, html };
}

function parseState(value) {
  try { return JSON.parse(value); } catch { return null; }
}

async function claim(db, eventId, orderId, eventType, now) {
  const payload = JSON.stringify({ status: 'sending', attempt: 1, attempted_at: now.toISOString() });
  const inserted = await db.prepare(
    'INSERT OR IGNORE INTO order_events (id,order_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?)'
  ).bind(eventId, orderId, eventType, payload, now.toISOString()).run();
  if (Number(inserted?.meta?.changes) > 0) return { ok: true, payload, attempt: 1 };

  const row = await db.prepare('SELECT payload_json FROM order_events WHERE id=?').bind(eventId).first();
  const state = parseState(row?.payload_json);
  if (state?.status === 'sent') return { ok: false, reason: 'already_sent' };
  const attemptedAt = Date.parse(state?.attempted_at || '');
  if (state?.status === 'sending' && Number.isFinite(attemptedAt) && now.getTime() - attemptedAt < CLAIM_STALE_MS) {
    return { ok: false, reason: 'in_progress' };
  }
  const attempt = Number.isInteger(state?.attempt) ? state.attempt + 1 : 1;
  const next = JSON.stringify({ status: 'sending', attempt, attempted_at: now.toISOString() });
  const updated = await db.prepare('UPDATE order_events SET payload_json=? WHERE id=? AND payload_json=?')
    .bind(next, eventId, row?.payload_json || '').run();
  return Number(updated?.meta?.changes) > 0
    ? { ok: true, payload: next, attempt }
    : { ok: false, reason: 'claim_lost' };
}

async function updateClaim(db, eventId, previous, state) {
  await db.prepare('UPDATE order_events SET payload_json=? WHERE id=? AND payload_json=?')
    .bind(JSON.stringify(state), eventId, previous).run();
}

async function postEmail({ config, to, email, idempotencyKey, fetchFn, timeoutMs }) {
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
      body: JSON.stringify({ from: config.from, to, ...email }),
      signal: controller.signal,
    });
    let data = null;
    try { data = await response.json(); } catch { /* opcional */ }
    if (response.ok && cleanString(data?.id)) return { ok: true, providerId: data.id };
    return { ok: false, retryable: response.status === 429 || response.status >= 500, code: `RESEND_HTTP_${response.status}` };
  } catch (error) {
    return { ok: false, retryable: true, code: error?.name === 'AbortError' ? 'RESEND_TIMEOUT' : 'RESEND_NETWORK_ERROR' };
  } finally {
    clearTimeout(timer);
  }
}

async function readItems(db, orderId) {
  const result = await db.prepare(
    'SELECT title,quantity,unit_price_uyu,line_total_uyu FROM order_items WHERE order_id=? ORDER BY created_at,id'
  ).bind(orderId).all();
  const items = Array.isArray(result?.results) ? result.results : [];
  if (items.length === 0) throw new Error('ORDER_ITEMS_UNAVAILABLE');
  return items;
}

function createTrackedSender({ fetchFn = globalThis.fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return async function send({ db, env, order, payment, now, audience }) {
    const config = emailConfig(env);
    const customer = audience === 'customer';
    const recipient = customer ? [cleanString(order.buyer_email).toLowerCase()] : config?.internalTo;
    if (!config || recipient.length === 0 || !recipient[0]) return { ok: false, skipped: true, code: 'EMAIL_CONFIG_MISSING' };

    const method = payment.method === 'bank_transfer' ? 'transfer' : 'mercado-pago';
    const eventId = `order-email:${audience}:${method}:${order.id}`;
    const eventType = customer ? 'customer_order_email' : 'internal_transfer_email';
    const claimed = await claim(db, eventId, order.id, eventType, now);
    if (!claimed.ok) return { ok: true, skipped: true, reason: claimed.reason };

    let items;
    try { items = await readItems(db, order.id); }
    catch {
      await updateClaim(db, eventId, claimed.payload, { status: 'failed', attempt: claimed.attempt, attempted_at: now.toISOString(), failure_code: 'ORDER_ITEMS_UNAVAILABLE' }).catch(() => {});
      return { ok: false, code: 'ORDER_ITEMS_UNAVAILABLE' };
    }
    const email = customer
      ? buildCustomerOrderEmail({ order, items, payment })
      : buildInternalTransferEmail({ order, items, payment });

    let result;
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
      result = await postEmail({ config, to: recipient, email, idempotencyKey: eventId, fetchFn, timeoutMs });
      if (result.ok || !result.retryable || attempt === MAX_SEND_ATTEMPTS) break;
      await sleep(250 * (2 ** (attempt - 1)));
    }
    const state = result?.ok
      ? { status: 'sent', attempt: claimed.attempt, attempted_at: now.toISOString(), sent_at: now.toISOString(), provider: 'resend', provider_id: result.providerId }
      : { status: 'failed', attempt: claimed.attempt, attempted_at: now.toISOString(), failure_code: cleanString(result?.code) || 'RESEND_ERROR' };
    await updateClaim(db, eventId, claimed.payload, state).catch(() => {});
    return result?.ok ? { ok: true, providerId: result.providerId } : { ok: false, code: state.failure_code };
  };
}

export function createOrderEmailService(options = {}) {
  const sendTracked = createTrackedSender(options);
  return {
    sendPaidCustomer: args => sendTracked({ ...args, audience: 'customer' }),
    async sendTransferNotifications(args) {
      const [customer, internal] = await Promise.all([
        sendTracked({ ...args, audience: 'customer' }),
        sendTracked({ ...args, audience: 'internal' }),
      ]);
      return { customer, internal };
    },
  };
}

export const orderEmailService = createOrderEmailService();
