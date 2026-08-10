const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const EMAIL_TIMEOUT_MS = 7000;
const MAX_SEND_ATTEMPTS = 3;
const CLAIM_STALE_MS = 30 * 60 * 1000;
const QUERY_LIMIT = 500;

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
  const canonicalOrigin = cleanString(env?.CANONICAL_ORIGIN).replace(/\/$/, '');
  if (!apiKey || !from || canonicalOrigin !== 'https://www.amadolibros.com') return null;
  return { apiKey, from, canonicalOrigin };
}

function productUrl(config, row, product) {
  const fallback = `${config.canonicalOrigin}/libro/${encodeURIComponent(product.id)}`;
  const stored = cleanString(row.source_url);
  if (!stored) return fallback;
  try {
    const url = new URL(stored);
    const expectedPath = `/libro/${encodeURIComponent(product.id)}`;
    if (url.origin !== config.canonicalOrigin || (url.pathname !== expectedPath && !url.pathname.startsWith(`${expectedPath}/`))) {
      return fallback;
    }
    return url.toString();
  } catch {
    return fallback;
  }
}

export function buildRestockEmail({ row, product, url }) {
  const stock = Number(product.available_quantity);
  const price = Math.round(Number(product.price));
  const transferPrice = Math.round(price * 0.88);
  const oneLeft = stock === 1;
  const stockLine = oneLeft
    ? 'Hay 1 ejemplar disponible.'
    : `Hay ${stock} ejemplares disponibles.`;
  const subject = `Volvió “${product.title}” — compralo antes de que se agote`;
  const text = [
    `Volvió “${product.title}”`,
    '',
    'El libro que estabas esperando ya está disponible en Amado Libros.',
    stockLine,
    `Precio vigente: ${formatMoney(price)}`,
    `Por transferencia: ${formatMoney(transferPrice)} (12% menos)`,
    'También podés pagar con tarjeta o Mercado Pago.',
    '',
    `Comprar ahora: ${url}`,
    '',
    'La disponibilidad se confirma al momento de completar el pedido.',
  ].join('\n');
  const html = `<!doctype html><html lang="es"><body style="font-family:Arial,sans-serif;color:#222;line-height:1.5">
    <h1 style="font-size:22px">Volvió “${escapeHtml(product.title)}”</h1>
    <p>El libro que estabas esperando ya está disponible en Amado Libros.</p>
    <p><strong>${escapeHtml(stockLine)}</strong><br>
       Precio vigente: ${escapeHtml(formatMoney(price))}<br>
       <strong>Por transferencia: ${escapeHtml(formatMoney(transferPrice))} (12% menos)</strong><br>
       También podés pagar con tarjeta o Mercado Pago.</p>
    <p><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 18px;background:#a94e3d;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">Comprar ahora</a></p>
    <p style="font-size:13px;color:#666">La disponibilidad se confirma al momento de completar el pedido.</p>
  </body></html>`;
  return { subject, text, html };
}

async function claimRow(db, row, now) {
  const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
  const result = await db.prepare(
    "UPDATE stock_waitlist SET customer_notification_status='sending', " +
    'customer_notification_attempts=customer_notification_attempts+1, ' +
    'last_notification_attempt_at=?, restocked_at=COALESCE(restocked_at,?), updated_at=? ' +
    "WHERE id=? AND status='waiting' AND (" +
    "customer_notification_status IN ('pending','failed') OR " +
    "(customer_notification_status='sending' AND (last_notification_attempt_at IS NULL OR last_notification_attempt_at<?)))"
  ).bind(now.toISOString(), now.toISOString(), now.toISOString(), row.id, staleBefore).run();
  return Number(result?.meta?.changes) > 0;
}

async function sendEmail({ config, row, email, fetchFn, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `stock-restocked/${row.id}`,
      },
      body: JSON.stringify({ from: config.from, to: [row.email], ...email }),
      signal: controller.signal,
    });
    let data = null;
    try { data = await response.json(); } catch { /* opcional */ }
    if (response.ok && cleanString(data?.id)) return { ok: true, providerId: data.id };
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

async function finishRow(db, row, result, now) {
  if (result.ok) {
    await db.prepare(
      "UPDATE stock_waitlist SET status='notified', customer_notification_status='sent', " +
      'customer_notification_id=?, customer_notification_error=NULL, notified_at=?, updated_at=? ' +
      "WHERE id=? AND customer_notification_status='sending'"
    ).bind(result.providerId, now.toISOString(), now.toISOString(), row.id).run();
    return;
  }
  await db.prepare(
    "UPDATE stock_waitlist SET customer_notification_status='failed', " +
    'customer_notification_error=?, updated_at=? ' +
    "WHERE id=? AND status='waiting' AND customer_notification_status='sending'"
  ).bind(cleanString(result.code).slice(0, 80) || 'RESEND_ERROR', now.toISOString(), row.id).run();
}

export function createStockWaitlistProcessor({
  fetchFn = globalThis.fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  getNow = () => new Date(),
  timeoutMs = EMAIL_TIMEOUT_MS,
} = {}) {
  return async function processStockWaitlist(env, catalog) {
    const config = emailConfig(env);
    if (!config) return { status: 'skipped', reason: 'email_config_missing', examined: 0, matched: 0, sent: 0, failed: 0 };
    const db = env?.ORDERS_DB;
    if (!db) return { status: 'skipped', reason: 'orders_db_missing', examined: 0, matched: 0, sent: 0, failed: 0 };

    const items = Array.isArray(catalog?.items) ? catalog.items : [];
    const available = new Map(items
      .filter(item => item?.status === 'active' && Number(item.available_quantity) > 0 && Number(item.price) > 0)
      .map(item => [item.id, item]));

    const queryNow = getNow();
    if (!(queryNow instanceof Date) || Number.isNaN(queryNow.getTime())) {
      return { status: 'error', reason: 'invalid_clock', examined: 0, matched: 0, sent: 0, failed: 0 };
    }
    const staleBefore = new Date(queryNow.getTime() - CLAIM_STALE_MS).toISOString();
    const result = await db.prepare(
      "SELECT id,product_id,product_title,email,source_url,customer_notification_status,last_notification_attempt_at " +
      "FROM stock_waitlist WHERE status='waiting' AND (" +
      "customer_notification_status IN ('pending','failed') OR " +
      "(customer_notification_status='sending' AND (last_notification_attempt_at IS NULL OR last_notification_attempt_at<?))) " +
      'ORDER BY created_at LIMIT ?'
    ).bind(staleBefore, QUERY_LIMIT).all();
    const rows = Array.isArray(result?.results) ? result.results : [];
    const matched = rows.filter(row => available.has(row.product_id));
    let sent = 0;
    let failed = 0;

    for (const row of matched) {
      let claimed = false;
      try {
        const now = getNow();
        if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('INVALID_CLOCK');
        claimed = await claimRow(db, row, now);
        if (!claimed) continue;
        const product = available.get(row.product_id);
        const url = productUrl(config, row, product);
        const email = buildRestockEmail({ row, product, url });
        let sendResult;
        for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
          sendResult = await sendEmail({ config, row, email, fetchFn, timeoutMs });
          if (sendResult.ok || !sendResult.retryable || attempt === MAX_SEND_ATTEMPTS) break;
          await sleep(250 * (2 ** (attempt - 1)));
        }
        await finishRow(db, row, sendResult, getNow());
        if (sendResult.ok) sent++;
        else failed++;
      } catch (error) {
        failed++;
        console.error(`[Stock waitlist] Fila ${row.id}: ${error?.message || 'Error'}`);
        if (claimed) {
          await finishRow(db, row, { ok: false, code: 'PROCESSING_ERROR' }, getNow()).catch(() => {});
        }
      }
    }

    return {
      status: failed > 0 ? 'partial' : 'ok',
      examined: rows.length,
      matched: matched.length,
      sent,
      failed,
      truncated: rows.length === QUERY_LIMIT,
    };
  };
}

export const processStockWaitlist = createStockWaitlistProcessor();
