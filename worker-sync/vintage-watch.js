/**
 * Vigía en la nube de la campaña de Amado Vintage.
 *
 * La PC publica y escribe un recibo en D1 por cada alta. Este módulo, desde el
 * cron de 5 minutos del Worker, mira sólo esa huella: si hace demasiado que no
 * hay altas nuevas y nada lo explica (lista de SBS vencida, lista recién
 * cargada, campaña pausada o terminada), avisa por ntfy. Cubre lo que un
 * vigía en la PC no puede avisar: la PC apagada, dormida o sin internet.
 *
 * Sólo SELECT sobre D1 y un POST a ntfy.sh. No toca Mercado Libre ni la cola.
 * Un aviso por hora como máximo (reserva en KV), nunca lanza excepciones.
 */

const SELLER = '2341378249';
const RUN_ID = '23413782-4900-4000-8000-000000010000';
const NTFY_HOST = 'ntfy.sh';
const NOTIFY_TIMEOUT_MS = 5000;
const SUPPLIER_LIST_MAX_AGE_MS = 24 * 3600_000;
const IDLE_STATES = new Set(['paused', 'complete', 'complete_with_review']);

function minutes(env, key, fallback) {
  const value = Number(env?.[key]);
  return Number.isFinite(value) && value > 0 ? value * 60_000 : fallback * 60_000;
}

function ntfyUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== NTFY_HOST || url.username || url.password || url.search || url.hash) return null;
  if (!/^\/[A-Za-z0-9_-]{1,64}$/.test(url.pathname)) return null;
  return url.toString();
}

async function readState(db) {
  const [alta, feed, run] = await Promise.all([
    db.prepare("SELECT MAX(updated_at) AS at FROM ml_vintage_pub_receipts WHERE seller_id = ? AND state = 'published'").bind(SELLER).first(),
    db.prepare("SELECT source_date, created_at FROM sbs_supplier_feeds WHERE state = 'ready' ORDER BY created_at DESC LIMIT 1").first(),
    db.prepare('SELECT state FROM ml_vintage_pub_runs WHERE id = ?').bind(RUN_ID).first(),
  ]);
  return {
    lastAltaAt: Number(alta?.at) || null,
    feedSourceAt: feed?.source_date ? Date.parse(feed.source_date) : null,
    feedLoadedAt: Number(feed?.created_at) || null,
    runState: run?.state ?? null,
  };
}

/** Decide sin tocar la red: qué pasa y si merece aviso. */
export function assess(state, now, { stallMs, warmupMs, supplierGraceMs }) {
  if (IDLE_STATES.has(state.runState)) return { state: 'idle', reason: state.runState };
  if (state.feedSourceAt === null || state.lastAltaAt === null) return { state: 'unknown', reason: 'sin datos en D1' };
  const feedAge = now - state.feedSourceAt;
  if (feedAge > SUPPLIER_LIST_MAX_AGE_MS) {
    const late = feedAge - SUPPLIER_LIST_MAX_AGE_MS;
    if (late > supplierGraceMs) return { state: 'supplier_late', alert: 'supplier_late', ttl: 6 * 3600, title: 'Vintage: SBS no publica la lista', message: `La lista del proveedor lleva ${Math.round(late / 3600_000)} h vencida; la campaña espera.` };
    return { state: 'waiting_supplier', reason: 'lista SBS vencida, dentro del margen' };
  }
  if (state.feedLoadedAt && now - state.feedLoadedAt < warmupMs) return { state: 'warming_up', reason: 'lista nueva: escaneo del inventario' };
  const gap = now - state.lastAltaAt;
  if (gap > stallMs) return { state: 'stalled', alert: 'stalled', ttl: 3600, title: 'Vintage: sin altas nuevas', message: `Ninguna alta en ${Math.round(gap / 60_000)} min con lista vigente. Puede ser la PC apagada, sin internet o el publicador parado.` };
  return { state: 'ok', gapMinutes: Math.round(gap / 60_000) };
}

export async function notifyNtfy(env, title, message, { fetchFn = fetch } = {}) {
  const url = ntfyUrl(env?.VINTAGE_NOTIFY_URL);
  if (!url) return { sent: false, reason: 'bad_url' };
  try {
    const response = await fetchFn(url, { method: 'POST', headers: { Title: title, Priority: 'high' }, body: message, signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS) });
    return { sent: Boolean(response?.ok), status: response?.status ?? null };
  } catch (error) {
    return { sent: false, reason: error?.name || 'fetch_failed' };
  }
}

export async function checkVintageHeartbeat(env, { now = new Date(), fetchFn = fetch } = {}) {
  if (env?.VINTAGE_WATCH_ENABLED !== 'true') return { state: 'disabled' };
  if (!env.ORDERS_DB) return { state: 'unknown', reason: 'sin ORDERS_DB' };
  let verdict;
  try {
    verdict = assess(await readState(env.ORDERS_DB), now.getTime(), {
      stallMs: minutes(env, 'VINTAGE_WATCH_STALL_MINUTES', 45),
      warmupMs: minutes(env, 'VINTAGE_WATCH_WARMUP_MINUTES', 60),
      supplierGraceMs: minutes(env, 'VINTAGE_WATCH_SUPPLIER_GRACE_MINUTES', 240),
    });
  } catch (error) {
    return { state: 'error', reason: error?.message?.slice(0, 120) || 'd1' };
  }
  if (!verdict.alert) return verdict;
  const claimKey = `vintage:watch:alert:${verdict.alert}`;
  if (env.AMADO_KV) {
    if (await env.AMADO_KV.get(claimKey)) return { ...verdict, notified: false, reason: 'already_notified' };
    await env.AMADO_KV.put(claimKey, now.toISOString(), { expirationTtl: verdict.ttl });
  }
  const outcome = await notifyNtfy(env, verdict.title, verdict.message, { fetchFn });
  return { ...verdict, notified: outcome.sent, ...(outcome.sent ? {} : { reason: outcome.reason ?? `http_${outcome.status}` }) };
}
