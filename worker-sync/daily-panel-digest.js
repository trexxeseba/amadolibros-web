/**
 * Correo diario del panel: cada mañana (08:00 en Montevideo) le llega a quien
 * atiende la tienda lo que hay que hacer hoy, sin tener que abrir el panel
 * para enterarse. Es un resumen para ACTUAR:
 *
 *   - pedidos pagados que faltan despachar,
 *   - pedidos sin pagar, para escribirle al cliente,
 *   - cómo salió ayer.
 *
 * No incluye teléfonos ni direcciones: el correo viaja por mail y el detalle
 * vive detrás de la contraseña del panel. Solo código de pedido, nombre de
 * pila, monto y un enlace.
 *
 * Una vez por día: la reserva en KV evita duplicados si el cron se repite.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const EMAIL_TIMEOUT_MS = 7000;
const PANEL_URL = 'https://www.amadolibros.com/panel';
const UNPAID_WINDOW_DAYS = 7;
const MAX_ROWS = 15;
const URUGUAY_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC-3 todo el año

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function money(value) {
  return `$ ${new Intl.NumberFormat('es-UY', { maximumFractionDigits: 0 }).format(Number(value) || 0)}`;
}

/** Día de Montevideo (YYYY-MM-DD) y sus límites en UTC, para `now`. */
export function montevideoDay(now, daysAgo = 0) {
  const local = new Date(now.getTime() - URUGUAY_OFFSET_MS - daysAgo * 86_400_000);
  const date = local.toISOString().slice(0, 10);
  const startUtc = new Date(Date.parse(`${date}T00:00:00.000Z`) + URUGUAY_OFFSET_MS);
  return { date, startIso: startUtc.toISOString(), endIso: new Date(startUtc.getTime() + 86_400_000).toISOString() };
}

function firstName(name) {
  return cleanString(name).split(/\s+/)[0] || 'Cliente';
}

async function all(db, sql, params = []) {
  const { results } = await db.prepare(sql).bind(...params).all();
  return results || [];
}

export async function loadDigestData(db, now = new Date()) {
  const yesterday = montevideoDay(now, 1);
  const since = new Date(now.getTime() - UNPAID_WINDOW_DAYS * 86_400_000).toISOString();
  const [toShip, unpaid, sold, created] = await Promise.all([
    all(db, `SELECT public_code, buyer_name, delivery_type, payable_total_uyu, paid_at FROM orders
              WHERE payment_status = 'approved' AND fulfilled_at IS NULL AND cancelled_at IS NULL
              ORDER BY paid_at ASC LIMIT 100`),
    all(db, `SELECT public_code, buyer_name, delivery_type, payment_provider, payable_total_uyu, created_at FROM orders
              WHERE status = 'open' AND payment_status != 'approved' AND cancelled_at IS NULL AND created_at >= ?
              ORDER BY created_at DESC LIMIT 100`, [since]),
    all(db, `SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(paid_amount_uyu, payable_total_uyu)), 0) AS total FROM orders
              WHERE payment_status = 'approved' AND paid_at >= ? AND paid_at < ?`, [yesterday.startIso, yesterday.endIso]),
    all(db, `SELECT COUNT(*) AS n FROM orders WHERE created_at >= ? AND created_at < ?`, [yesterday.startIso, yesterday.endIso]),
  ]);
  return {
    yesterday,
    toShip,
    unpaid,
    soldCount: Number(sold[0]?.n || 0),
    soldTotal: Number(sold[0]?.total || 0),
    createdCount: Number(created[0]?.n || 0),
  };
}

const DELIVERY = { pickup: 'retiro', shipping: 'envío' };
const PROVIDER = { mercadopago: 'Mercado Pago', bank_transfer: 'transferencia' };

function orderLink(code) {
  return `${PANEL_URL}/pedido/${encodeURIComponent(code)}`;
}

function line(row, extra = '') {
  return `${row.public_code} · ${firstName(row.buyer_name)} · ${money(row.payable_total_uyu)} · ${DELIVERY[row.delivery_type] || row.delivery_type}${extra}`;
}

export function buildDigestEmail(data) {
  const ship = data.toShip;
  const unpaid = data.unpaid;
  const parts = [];
  if (ship.length) parts.push(`${ship.length} para despachar`);
  if (unpaid.length) parts.push(`${unpaid.length} sin pagar`);
  const subject = parts.length
    ? `Amado Libros — hoy: ${parts.join(' y ')}`
    : 'Amado Libros — hoy no hay nada pendiente';

  const text = [
    'Buen día. Esto es lo que hay para hacer hoy en la tienda.',
    '',
    `PARA DESPACHAR (${ship.length})`,
    ...(ship.length ? ship.slice(0, MAX_ROWS).map(r => `- ${line(r)} — ${orderLink(r.public_code)}`) : ['- Nada pendiente. ¡Todo despachado!']),
    ...(ship.length > MAX_ROWS ? [`  … y ${ship.length - MAX_ROWS} más en el panel.`] : []),
    '',
    `SIN PAGAR — escribile al cliente (${unpaid.length})`,
    ...(unpaid.length
      ? unpaid.slice(0, MAX_ROWS).map(r => `- ${line(r, r.payment_provider ? ` · ${PROVIDER[r.payment_provider] || r.payment_provider}` : '')} — ${orderLink(r.public_code)}`)
      : ['- Ninguno. Todos los pedidos están pagos.']),
    ...(unpaid.length > MAX_ROWS ? [`  … y ${unpaid.length - MAX_ROWS} más en el panel.`] : []),
    unpaid.length ? '  En cada pedido hay un botón para escribirle por WhatsApp con el mensaje ya armado.' : '',
    '',
    'AYER',
    `- Pedidos nuevos: ${data.createdCount}`,
    `- Ventas cobradas: ${data.soldCount}${data.soldCount ? ` (${money(data.soldTotal)})` : ''}`,
    '',
    `Abrir el panel: ${PANEL_URL}`,
  ].filter(item => item !== null).join('\n');

  const rowsHtml = (rows, extra) => rows.slice(0, MAX_ROWS).map(r => `
    <tr><td style="padding:6px 8px;border-bottom:1px solid #eee"><a href="${escapeHtml(orderLink(r.public_code))}" style="color:#a94e3d;font-weight:bold;text-decoration:none">${escapeHtml(r.public_code)}</a></td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(firstName(r.buyer_name))}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(money(r.payable_total_uyu))}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(DELIVERY[r.delivery_type] || r.delivery_type)}${extra ? ` · ${escapeHtml(extra(r))}` : ''}</td></tr>`).join('');

  const section = (title, count, rows, empty, extra) => `
    <h2 style="font-size:17px;margin:24px 0 6px">${escapeHtml(title)} <span style="color:#888;font-weight:normal">(${count})</span></h2>
    ${rows.length
      ? `<table style="border-collapse:collapse;width:100%;font-size:14px">${rowsHtml(rows, extra)}</table>${rows.length > MAX_ROWS ? `<p style="font-size:13px;color:#666">… y ${rows.length - MAX_ROWS} más en el panel.</p>` : ''}`
      : `<p style="color:#2e7d32;margin:4px 0">${escapeHtml(empty)}</p>`}`;

  const html = `<!doctype html><html lang="es"><body style="font-family:Arial,sans-serif;color:#222;line-height:1.5;max-width:640px;margin:0 auto;padding:16px">
    <h1 style="font-size:22px;margin:0 0 4px">Buen día 👋</h1>
    <p style="margin:0;color:#555">Esto es lo que hay para hacer hoy en la tienda.</p>
    ${section('Para despachar', ship.length, ship, 'Nada pendiente. ¡Todo despachado!')}
    ${section('Sin pagar: escribile al cliente', unpaid.length, unpaid, 'Ninguno. Todos los pedidos están pagos.', r => PROVIDER[r.payment_provider] || '')}
    ${unpaid.length ? '<p style="font-size:13px;color:#666">En cada pedido hay un botón para escribirle por WhatsApp con el mensaje ya armado.</p>' : ''}
    <h2 style="font-size:17px;margin:24px 0 6px">Ayer</h2>
    <p style="margin:4px 0">Pedidos nuevos: <strong>${data.createdCount}</strong><br>
       Ventas cobradas: <strong>${data.soldCount}</strong>${data.soldCount ? ` (${escapeHtml(money(data.soldTotal))})` : ''}</p>
    <p style="margin:24px 0"><a href="${PANEL_URL}" style="display:inline-block;padding:12px 20px;background:#a94e3d;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">Abrir el panel</a></p>
  </body></html>`;
  return { subject, text, html };
}

function recipients(env) {
  return cleanString(env?.DAILY_DIGEST_TO).split(/[,;]+/).map(item => item.trim()).filter(Boolean);
}

async function sendEmail({ apiKey, from, to, email, idempotencyKey }, fetchFn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);
  try {
    const response = await fetchFn(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ from, to, ...email }),
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, status: 0, error: error?.name || 'Error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Manda el correo del día. Devuelve un estado corto, nunca lanza.
 * `skipped`: ya se mandó hoy, o falta configuración. `failed`: Resend no lo
 * aceptó (la reserva se libera para que el segundo cron del día lo reintente).
 */
export async function sendDailyPanelDigest(env, { now = new Date(), fetchFn = globalThis.fetch, test = false } = {}) {
  const apiKey = cleanString(env?.RESEND_API_KEY);
  const from = cleanString(env?.SALES_NOTIFICATION_FROM);
  const to = recipients(env);
  if (!apiKey || !from || !to.length || !env?.ORDERS_DB) return { status: 'skipped', reason: 'config' };

  const today = montevideoDay(now).date;
  const claimKey = `digest:panel:${today}`;
  // Una prueba manual no gasta ni libera la reserva del día: el correo real de
  // las 08:03 sale igual.
  const useClaim = Boolean(env.AMADO_KV) && !test;
  if (useClaim) {
    if (await env.AMADO_KV.get(claimKey)) return { status: 'skipped', reason: 'already_sent' };
    await env.AMADO_KV.put(claimKey, now.toISOString(), { expirationTtl: 3 * 86_400 });
  }

  try {
    const data = await loadDigestData(env.ORDERS_DB, now);
    const email = buildDigestEmail(data);
    if (test) email.subject = `[PRUEBA] ${email.subject}`;
    const result = await sendEmail({ apiKey, from, to, email, idempotencyKey: test ? `panel-digest-test/${now.toISOString()}` : `panel-digest/${today}` }, fetchFn);
    if (result.ok) return { status: 'sent', toShip: data.toShip.length, unpaid: data.unpaid.length };
    if (useClaim) await env.AMADO_KV.delete(claimKey);
    console.warn('[panel digest] Resend no lo aceptó', { status: result.status, error: result.error });
    return { status: 'failed' };
  } catch (error) {
    if (useClaim) await env.AMADO_KV.delete(claimKey);
    console.warn('[panel digest] error', error?.name || 'Error');
    return { status: 'failed' };
  }
}
