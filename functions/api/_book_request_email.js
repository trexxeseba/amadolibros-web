const ENDPOINT = 'https://api.resend.com/emails';

const clean = value => typeof value === 'string' ? value.trim() : '';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

export function buildBookRequestEmail({ value, code }) {
  const contact = value.reply_contact;
  const rows = [
    ['Código', code], ['Libro o búsqueda', value.query],
    ['Autor, editorial o ISBN', value.author_isbn], ['Formato', value.format],
    ['Idioma', value.language],
    ['Presupuesto UYU', value.budget_uyu === null ? '' : value.budget_uyu],
    ['Otros datos', value.details],
    [contact.type === 'email' ? 'Responder por correo' : 'Responder por WhatsApp', contact.value],
  ].filter(([, value]) => value !== null && value !== '');
  return {
    subject: `Nueva búsqueda de libro · ${code}`,
    text: ['Solicitud recibida desde la web de Amado Libros.', ...rows.map(([label, value]) => `${label}: ${value}`)].join('\n'),
    html: `<h1>Nueva búsqueda de libro</h1><p>Solicitud recibida desde la web de Amado Libros.</p><dl>${rows.map(([label, value]) => `<dt><strong>${escape(label)}</strong></dt><dd>${escape(value)}</dd>`).join('')}</dl>`,
    ...(contact.type === 'email' ? { reply_to: contact.value } : {}),
  };
}

export function createBookRequestNotifier({ fetchFn = fetch, timeoutMs = 7000 } = {}) {
  return async function notify({ env, value, code, requestId }) {
    const apiKey = clean(env?.RESEND_API_KEY);
    const from = clean(env?.SALES_NOTIFICATION_FROM);
    const to = clean(env?.SALES_NOTIFICATION_TO).split(',').map(clean).filter(Boolean);
    if (!apiKey || !from || !to.length) return { ok: false, code: 'EMAIL_CONFIG_MISSING' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `book-request-${requestId}` },
        body: JSON.stringify({ from, to, ...buildBookRequestEmail({ value, code }) }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      return response.ok && typeof data?.id === 'string' && data.id
        ? { ok: true } : { ok: false, code: 'EMAIL_DELIVERY_FAILED' };
    } catch {
      return { ok: false, code: 'EMAIL_DELIVERY_FAILED' };
    } finally {
      clearTimeout(timer);
    }
  };
}

export const notifyBookRequest = createBookRequestNotifier();
