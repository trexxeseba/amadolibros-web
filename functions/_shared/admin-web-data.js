// Lectores de datos. Sin INSERT/UPDATE/DELETE, sin pedidos ni pagos externos.
import { CATALOG_URL, R2_BASE } from './catalog.js';
export const WEB_HOSTS = ['amadolibros.com', 'www.amadolibros.com'];
const unknown = (source, reason = 'Sin conectar') => ({ status: 'unavailable', source, reason });
const failed = source => unknown(source, 'No se pudo consultar. No equivale a cero.');

export function webPeriod(days, now = new Date()) {
  if (![7, 30].includes(Number(days))) throw new Error('INVALID_PERIOD');
  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Montevideo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const end = new Date(`${localDate}T00:00:00-03:00`);
  const start = new Date(end.getTime() - Number(days) * 86400000);
  const fmt = d => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Montevideo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  return { days: Number(days), start: start.toISOString(), end: end.toISOString(),
    startDate: fmt(start), endDate: fmt(new Date(end.getTime() - 1)), timeZone: 'America/Montevideo' };
}

export async function readWebOrders(env, period) {
  const source = 'Pedidos de la web · D1';
  if (!env.ORDERS_DB) return unknown(source);
  try {
    const range = 'julianday(created_at) >= julianday(?) AND julianday(created_at) < julianday(?)';
    const args = [period.start, period.end];
    const summary = await env.ORDERS_DB.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(payment_status = 'approved'),0) AS approved,
      COALESCE(SUM(payment_status = 'rejected'),0) AS rejected,
      COALESCE(SUM(status = 'open' AND payment_status IN ('not_started','pending')
        AND julianday(expires_at) > julianday(?)),0) AS pending
      FROM orders WHERE ${range}`).bind(new Date().toISOString(), ...args).first();
    if (!summary || !['total', 'approved', 'rejected', 'pending'].every(k => Number.isInteger(summary[k]) && summary[k] >= 0)) throw new Error('ORDERS_SHAPE');
    const result = await env.ORDERS_DB.prepare(`SELECT public_code,status,payment_status,delivery_type,created_at
      FROM orders WHERE ${range} ORDER BY created_at DESC LIMIT 50`).bind(...args).all();
    if (!Array.isArray(result.results) || result.success === false) throw new Error('ORDERS_ROWS');
    const rows = result.results.map(r => ({ code: r.public_code, status: r.status,
      paymentStatus: r.payment_status, delivery: r.delivery_type, createdAt: r.created_at }));
    return { status: 'ok', source, summary, rows, listed: rows.length, limit: 50,
      note: 'Pedidos creados en el período; estado actual. Pago rechazado no prueba una falla técnica. Se omiten datos personales e importes pendientes de conciliar.' };
  } catch { return failed(source); }
}

export async function readWebEmails(env, period) {
  const source = 'Correos de pedidos · eventos registrados';
  if (!env.ORDERS_DB) return unknown(source);
  try {
    const result = await env.ORDERS_DB.prepare(`SELECT
      CASE WHEN json_valid(payload_json) THEN
        CASE json_extract(payload_json,'$.status') WHEN 'sent' THEN 'sent'
        WHEN 'failed' THEN 'failed' WHEN 'sending' THEN 'sending' ELSE 'unknown' END
      ELSE 'unknown' END AS state, COUNT(*) AS total
      FROM order_events WHERE event_type IN ('customer_order_email','internal_transfer_email','sale_notification')
      AND julianday(created_at) >= julianday(?) AND julianday(created_at) < julianday(?) GROUP BY state`)
      .bind(period.start, period.end).all();
    if (!Array.isArray(result.results) || result.success === false) throw new Error('EMAILS_SHAPE');
    return { status: 'ok', source, rows: result.results.map(r => ({ state: r.state, total: r.total })),
      note: 'Enviado significa aceptado por el proveedor, no recibido en la bandeja. Sin evento no se puede confirmar un envío. Estados actuales de eventos creados en el período.' };
  } catch { return failed(source); }
}

async function getJson(url, fetchFn) {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(6000), redirect: 'error' });
  if (!response.ok) throw new Error('SOURCE_UNAVAILABLE');
  return response.json();
}

export async function readWebCatalog(query = '', page = 0, fetchFn = fetch) {
  const source = 'Catálogo público que consume la web';
  try {
    const catalog = await getJson(CATALOG_URL, fetchFn);
    if (!Array.isArray(catalog?.items)) throw new Error('CATALOG_SHAPE');
    const text = String(query).trim().slice(0, 120).toLocaleLowerCase('es');
    const filtered = catalog.items.filter(r => !text || [r.title, r.author, r.id, r.isbn].some(v => String(v || '').toLocaleLowerCase('es').includes(text)));
    const safePage = Math.max(0, Math.min(Number.isInteger(page) ? page : 0, Math.max(0, Math.ceil(filtered.length / 25) - 1)));
    return { status: 'ok', source, total: catalog.items.length, matched: filtered.length, page: safePage,
      pages: Math.ceil(filtered.length / 25), rows: filtered.slice(safePage * 25, safePage * 25 + 25).map(r => ({
        id: String(r.id || ''), title: String(r.title || ''), author: String(r.author || ''),
        price: typeof r.price === 'number' && Number.isFinite(r.price) ? r.price : null,
        stock: Number.isInteger(r.available_quantity) ? r.available_quantity : null,
        status: String(r.status || 'sin_datos'),
      })),
      note: 'Consulta de las publicaciones incluidas en el catálogo web. No representa libros únicos ni todas las publicaciones pausadas. Precio y stock se muestran según la fuente.' };
  } catch { return failed(source); }
}

export async function readWebSync(fetchFn = fetch, now = new Date()) {
  const source = 'Metadatos del catálogo web';
  try {
    const meta = await getJson(`${R2_BASE}/meta.json`, fetchFn);
    const updatedAt = meta.last_full_sync || meta.updated_at;
    if (!updatedAt || !Number.isFinite(Date.parse(updatedAt))) return unknown(source, 'Sin fecha verificable de actualización');
    const ageHours = (now.getTime() - Date.parse(updatedAt)) / 3600000;
    if (ageHours < -0.1) return unknown(source, 'La fuente informó una fecha futura');
    return { status: ageHours > 26 ? 'stale' : 'ok', source, updatedAt, ageHours,
      note: 'Más de 26 horas sin actualización genera una advertencia. La antigüedad por sí sola no confirma que el proceso esté trancado.' };
  } catch { return failed(source); }
}

const count = x => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
export const WEB_EVENTS = ['view_item', 'add_to_cart', 'begin_checkout', 'add_shipping_info', 'add_payment_info', 'purchase', 'checkout_error'];

export function validateWebAnalytics(raw, period, now = new Date()) {
  if (!raw || raw.version !== 1 || raw.property !== '543434807' || raw.scope !== 'web-only' ||
      JSON.stringify(raw.hosts) !== JSON.stringify(WEB_HOSTS) ||
      raw.period?.startDate !== period.startDate || raw.period?.endDate !== period.endDate ||
      raw.period?.timeZone !== 'America/Montevideo' ||
      !Number.isFinite(Date.parse(raw.extractedAt)) || Date.parse(raw.extractedAt) > now.getTime() + 60000 ||
      !count(raw.summary?.sessions) || !count(raw.summary?.users) || !count(raw.summary?.views) ||
      !WEB_EVENTS.every(k => count(raw.events?.[k]))) return null;
  const lists = {};
  for (const name of ['channels', 'devices', 'pages']) {
    if (!Array.isArray(raw[name]) || raw[name].length > 25 ||
        !raw[name].every(r => typeof r.label === 'string' && r.label.length <= 200 && count(r.count))) return null;
    // Listas de páginas sin query strings; nunca renderizar texto arbitrario como HTML.
    lists[name] = raw[name].map(r => ({ label: name === 'pages' ? r.label.split(/[?#]/)[0] : r.label, count: r.count }));
  }
  return { status: now.getTime() - Date.parse(raw.extractedAt) > 26 * 3600000 ? 'stale' : 'ok',
    source: 'Google Analytics 4 · sólo amadolibros.com', extractedAt: raw.extractedAt,
    summary: { sessions: raw.summary.sessions, users: raw.summary.users, views: raw.summary.views },
    events: Object.fromEntries(WEB_EVENTS.map(k => [k, raw.events[k]])), ...lists,
    note: 'Período cerrado hasta ayer. GA4 puede omitir visitas por consentimiento o bloqueadores y recibir datos con demora. Los pasos son conteos de eventos, no un embudo de personas ni una tasa de abandono. Cero errores significa cero eventos recibidos.' };
}

export async function readWebAnalytics(env, period, now = new Date()) {
  const source = 'Google Analytics 4 · sólo amadolibros.com';
  // Binding exclusivo del panel, no AMADO_KV compartido por preview/producción.
  if (!env.ADMIN_WEB_ANALYTICS_KV || !['preview', 'production'].includes(env.APP_ENV)) return unknown(source);
  try {
    // Ambos períodos se publican juntos; nunca mezclar dos actualizaciones.
    const bundle = await env.ADMIN_WEB_ANALYTICS_KV.get(`${env.APP_ENV}:ga4:web:v2`, 'json');
    if (bundle?.version !== 2 || bundle.environment !== env.APP_ENV ||
        ![7, 30].every(days => bundle.snapshots?.[days]?.extractedAt === bundle.updatedAt)) return unknown(source, 'Sin actualización completa de Analytics');
    const raw = bundle.snapshots[period.days];
    const value = validateWebAnalytics(raw, period, now);
    return value || unknown(source, 'Sin informe válido para este período y esta web');
  } catch { return failed(source); }
}
