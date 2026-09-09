// Receptor entre servicios. Desactivado por defecto. Nunca usa la base de pedidos.
const MAX_BODY = 16384;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const states = { ALERT_FAILURE: 'confirmed', ALERT_FAILURE_REMAIN: 'confirmed', ALERT_DEGRADED_FAILURE: 'confirmed',
  ALERT_DEGRADED: 'degraded', ALERT_DEGRADED_REMAIN: 'degraded', ALERT_FAILURE_DEGRADED: 'degraded',
  ALERT_RECOVERY: 'recovered', ALERT_DEGRADED_RECOVERY: 'recovered' };
const encoder = new TextEncoder();
const reply = (status, code) => Response.json({ code }, { status, headers: {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow' } });
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');

async function boundedBody(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY) throw new Error('BODY_LIMIT');
  if (!request.body) throw new Error('BODY_INVALID');
  const reader = request.body.getReader();
  const chunks = []; let length = 0;
  const timer = setTimeout(() => reader.cancel('BODY_TIMEOUT').catch(() => {}), 6000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY) { await reader.cancel(); throw new Error('BODY_LIMIT'); }
      chunks.push(value);
    }
  } finally { clearTimeout(timer); reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export function normalizeCheckly(raw, registry, environment, now = new Date()) {
  const keys = ['version', 'checkId', 'resultId', 'alertType', 'occurredAt'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== keys.length ||
      !keys.every(k => Object.hasOwn(raw, k)) || raw.version !== 1 ||
      !['checkId','resultId','alertType'].every(k => typeof raw[k] === 'string') || !UUID.test(raw.checkId) || !UUID.test(raw.resultId) ||
      !Object.hasOwn(states, raw.alertType) || typeof raw.occurredAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw.occurredAt)) throw new Error('EVENT_INVALID');
  const stamp = Date.parse(raw.occurredAt);
  if (!Number.isFinite(stamp) || stamp > now.getTime() + 60000 || now.getTime() - stamp > 72 * 3600000) throw new Error('EVENT_TIME_INVALID');
  const check = registry?.[raw.checkId];
  if (!check || check.environment !== environment || !['portadas', 'banners', 'navegacion', 'catalogo', 'sync', 'google_imagen'].includes(check.component) ||
      typeof check.path !== 'string' || check.path.length > 300 || !/^\/(?:[a-zA-Z0-9_/-]*)$/.test(check.path) ||
      check.path.startsWith('//') || new URL(check.path, 'https://www.amadolibros.com').pathname !== check.path) throw new Error('CHECK_NOT_ALLOWED');
  return { deliveryId: `${raw.checkId}:${raw.resultId}:${raw.alertType}`, checkId: raw.checkId,
    environment, component: check.component, path: check.path, state: states[raw.alertType],
    occurredAt: new Date(stamp).toISOString(), receivedAt: now.toISOString() };
}

export async function receiveCheckly(request, env, now = new Date()) {
  const url = new URL(request.url);
  if (env.MONITOR_ENABLED === 'true' && env.MONITOR_ENV === 'preview' && url.protocol === 'https:' &&
      url.hostname === env.MONITOR_HOST && url.pathname === '/_monitor-test' && !url.search && request.method === 'GET' &&
      env.MONITOR_ACCEPTANCE_MODE === 'enabled') {
    try {
      const mode = await env.MONITOR_DB?.prepare("SELECT value FROM monitor_config WHERE key = 'acceptance_mode'").first();
      if (!['failure','recovery'].includes(mode?.value)) return reply(503, 'FIXTURE_STATE_UNAVAILABLE');
      return reply(mode.value === 'failure' ? 503 : 200, 'ISOLATED_ACCEPTANCE_FIXTURE');
    } catch { return reply(503, 'FIXTURE_STATE_UNAVAILABLE'); }
  }
  if (env.MONITOR_ENABLED !== 'true' || !['preview', 'production'].includes(env.MONITOR_ENV) ||
      url.protocol !== 'https:' || !env.MONITOR_HOST || url.hostname !== env.MONITOR_HOST ||
      url.pathname !== '/webhooks/checkly' || url.search) return reply(404, 'NOT_FOUND');
  if (request.method !== 'POST') return reply(405, 'POST_REQUIRED');
  if (!env.MONITOR_DB || env.MONITOR_DB === env.ORDERS_DB || !env.MONITOR_RATE_LIMITER ||
      typeof env.CHECKLY_WEBHOOK_SECRET !== 'string' || env.CHECKLY_WEBHOOK_SECRET.length < 32) return reply(503, 'NOT_CONFIGURED');
  try {
    const limit = await env.MONITOR_RATE_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
    if (limit?.success !== true) return reply(429, 'RATE_LIMIT');
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return reply(415, 'JSON_REQUIRED');
    const signature = request.headers.get('x-checkly-signature');
    if (!/^[a-f0-9]{64}$/.test(signature || '')) return reply(401, 'INVALID_SIGNATURE');
    const bytes = await boundedBody(request);
    const key = await crypto.subtle.importKey('raw', encoder.encode(env.CHECKLY_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const signed = Uint8Array.from(signature.match(/../g), x => parseInt(x, 16));
    if (!await crypto.subtle.verify('HMAC', key, signed, bytes)) return reply(401, 'INVALID_SIGNATURE');
    let event;
    try { event = normalizeCheckly(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), JSON.parse(env.MONITOR_CHECKS_JSON || '{}'), env.MONITOR_ENV, now); }
    catch { return reply(400, 'INVALID_EVENT'); }
    const digest = hex(await crypto.subtle.digest('SHA-256', bytes));
    // Un INSERT atómico: el id único hace inocuos los reintentos concurrentes.
    await env.MONITOR_DB.prepare(`INSERT INTO monitor_events
      (delivery_id,check_id,environment,component,page_path,state,occurred_at,received_at,payload_hash)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(delivery_id) DO NOTHING`)
      .bind(event.deliveryId, event.checkId, event.environment, event.component, event.path, event.state, event.occurredAt, event.receivedAt, digest).run();
    const stored = await env.MONITOR_DB.prepare('SELECT payload_hash FROM monitor_events WHERE delivery_id = ?').bind(event.deliveryId).first();
    if (!stored) return reply(503, 'STORAGE_UNAVAILABLE');
    if (stored.payload_hash !== digest) return reply(409, 'DELIVERY_CONFLICT');
    return reply(202, 'ACCEPTED');
  } catch (error) { return reply(error.message === 'BODY_LIMIT' ? 413 : 503, error.message === 'BODY_LIMIT' ? 'BODY_LIMIT' : 'INGEST_UNAVAILABLE'); }
}

export async function pruneMonitorEvents(env, now = new Date()) {
  if (env.MONITOR_ENABLED !== 'true' || !env.MONITOR_DB || env.MONITOR_DB === env.ORDERS_DB) return;
  const cutoff = new Date(now.getTime() - 30 * 86400000).toISOString();
  // Conservar siempre el último estado, incluso una falla abierta antigua o una recuperación
  // que impide que un fallo anterior reaparezca. Sólo el historial intermedio vence.
  return env.MONITOR_DB.prepare(`DELETE FROM monitor_events WHERE delivery_id IN (
    SELECT delivery_id FROM (
      SELECT delivery_id,occurred_at,ROW_NUMBER() OVER(PARTITION BY environment,check_id ORDER BY occurred_at DESC,
        CASE state WHEN 'confirmed' THEN 2 WHEN 'degraded' THEN 1 ELSE 0 END DESC, delivery_id DESC) AS position
      FROM monitor_events
    ) WHERE occurred_at < ? AND position > 1 LIMIT 5000
  )`).bind(cutoff).run();
}
export default { fetch: (request, env) => receiveCheckly(request, env),
  scheduled: (_event, env, context) => context.waitUntil(pruneMonitorEvents(env)) };
