// Incidentes de pago: cobros de Mercado Pago que no se pudieron asignar a un
// pedido, cobros repetidos y devoluciones. Se anotan en payment_incidents y
// se avisa por correo al equipo. Anotar un incidente nunca cambia un pedido.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 7000;

const REASON_TEXT = Object.freeze({
  moneda_distinta: {
    title: 'cobro en otra moneda',
    detail: 'Mercado Pago informó el cobro en una moneda que no es pesos uruguayos.',
  },
  pedido_inexistente: {
    title: 'cobro sin pedido',
    detail: 'Mercado Pago cobró con un código de pedido que no existe en la base.',
  },
  importe_distinto: {
    title: 'importe distinto al del pedido',
    detail: 'El importe cobrado no coincide con el total del pedido.',
  },
  preferencia_distinta: {
    title: 'cobro de otra orden de pago',
    detail: 'El cobro corresponde a una orden de pago distinta a la que generó este pedido.',
  },
  referencia_distinta: {
    title: 'referencia que no coincide',
    detail: 'La orden de Mercado Pago tiene una referencia distinta al código del pedido.',
  },
  pago_fuera_de_la_orden: {
    title: 'cobro que no figura en la orden',
    detail: 'El cobro no figura entre los pagos de su orden en Mercado Pago.',
  },
  pago_duplicado: {
    title: 'pedido cobrado dos veces',
    detail: 'Entró un cobro aprobado para un pedido que ya estaba pagado. Hay un pago de más para devolver.',
  },
  pago_devuelto: {
    title: 'cobro devuelto o con contracargo',
    detail: 'Mercado Pago informó la devolución o el contracargo de este cobro.',
  },
});

const clean = value => (typeof value === 'string' ? value.trim() : '');
const money = value => (Number.isFinite(Number(value))
  ? `$${new Intl.NumberFormat('es-UY', { maximumFractionDigits: 2 }).format(Number(value))}`
  : 'sin dato');
const escapeHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function incidentId(incident) {
  return `mp:${incident.payment_id}:${incident.reason}`;
}

export function buildIncidentEmail(incident) {
  const text = REASON_TEXT[incident.reason] || { title: incident.reason, detail: '' };
  const applied = incident.reason === 'pago_duplicado' || incident.reason === 'pago_devuelto';
  const lines = [
    `Revisar un cobro de Mercado Pago: ${text.title}.`,
    '',
    text.detail,
    '',
    `Pedido: ${incident.public_code || 'sin código'}`,
    `Pago de Mercado Pago: ${incident.payment_id}`,
    `Estado en Mercado Pago: ${incident.mp_status || 'sin dato'}`,
    `Importe cobrado: ${money(incident.mp_amount_uyu)}`,
    `Total del pedido: ${incident.order_amount_uyu == null ? 'sin pedido' : money(incident.order_amount_uyu)}`,
    `Detectado por: ${incident.source === 'conciliacion' ? 'conciliación automática' : 'aviso de Mercado Pago'}`,
    '',
    applied
      ? 'El estado del pedido no se modificó por este aviso.'
      : 'El pedido NO se marcó como pagado. Buscá el pago en Mercado Pago y resolvé con el cliente.',
  ];
  return {
    subject: `Revisar cobro de Mercado Pago — ${text.title} — ${incident.public_code || incident.payment_id}`,
    text: lines.join('\n'),
    html: `<!doctype html><html lang="es"><body style="font-family:Arial,sans-serif;color:#222;line-height:1.45">${
      lines.map(line => (line ? `<p style="margin:6px 0">${escapeHtml(line)}</p>` : '')).join('')}</body></html>`,
  };
}

function emailConfig(env) {
  const apiKey = clean(env?.RESEND_API_KEY);
  const from = clean(env?.SALES_NOTIFICATION_FROM);
  const to = clean(env?.SALES_NOTIFICATION_TO).split(',').map(v => v.trim()).filter(Boolean);
  return apiKey && from && to.length > 0 ? { apiKey, from, to } : null;
}

async function sendIncidentEmail({ env, incident, fetchFn }) {
  const config = emailConfig(env);
  if (!config) return false;
  const email = buildIncidentEmail(incident);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchFn(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `payment-incident/${incidentId(incident)}`,
      },
      body: JSON.stringify({ from: config.from, to: config.to, subject: email.subject, text: email.text, html: email.html }),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function markNotified(db, id, now) {
  await db.prepare('UPDATE payment_incidents SET notified_at=? WHERE id=? AND notified_at IS NULL')
    .bind(now.toISOString(), id).run();
}

/**
 * Anota el incidente una sola vez (el id es pago + motivo) y, si es nuevo,
 * manda el correo. Si el correo no sale, queda sin `notified_at` y lo
 * reintenta la conciliación.
 */
export async function reportIncident({ db, env, incident, now = new Date(), source = 'webhook', notify = true, fetchFn = null }) {
  const id = incidentId(incident);
  const inserted = await db.prepare(
    'INSERT OR IGNORE INTO payment_incidents ' +
    '(id,payment_id,reason,public_code,order_id,mp_status,mp_amount_uyu,order_amount_uyu,source,created_at) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).bind(
    id, incident.payment_id, incident.reason, incident.public_code ?? null, incident.order_id ?? null,
    incident.mp_status ?? null,
    Number.isFinite(incident.mp_amount_uyu) ? incident.mp_amount_uyu : null,
    Number.isFinite(incident.order_amount_uyu) ? incident.order_amount_uyu : null,
    source, now.toISOString(),
  ).run();

  const isNew = Number(inserted?.meta?.changes) > 0;
  if (!isNew || !notify) return { recorded: isNew, notified: false };
  const sent = await sendIncidentEmail({ env, incident: { ...incident, source }, fetchFn: fetchFn || globalThis.fetch });
  if (sent) await markNotified(db, id, now);
  return { recorded: true, notified: sent };
}

/** Reintenta los correos de incidentes que quedaron sin avisar. */
export async function notifyPendingIncidents({ db, env, now = new Date(), fetchFn = null, limit = 10 }) {
  const result = await db.prepare(
    'SELECT id,payment_id,reason,public_code,order_id,mp_status,mp_amount_uyu,order_amount_uyu,source ' +
    'FROM payment_incidents WHERE notified_at IS NULL ORDER BY created_at LIMIT ?'
  ).bind(limit).all();
  let sent = 0;
  for (const incident of Array.isArray(result?.results) ? result.results : []) {
    if (await sendIncidentEmail({ env, incident, fetchFn: fetchFn || globalThis.fetch })) {
      await markNotified(db, incident.id, now);
      sent++;
    }
  }
  return { sent };
}
