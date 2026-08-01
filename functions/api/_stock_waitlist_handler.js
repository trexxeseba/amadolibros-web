import { verifyTurnstile } from './_turnstile.js';

const MAX_BODY_BYTES = 8 * 1024;
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const EMAIL_TIMEOUT_MS = 7000;
const PAGES_PREVIEW_HOSTNAME_RE = /^[^.]+\.amadolibros-web\.pages\.dev$/;
const previewSchemaPromises = new WeakMap();

const PREVIEW_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS stock_waitlist (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  product_title TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting','notified','cancelled')),
  source_url TEXT,
  internal_notification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (internal_notification_status IN ('pending','sent','failed','skipped')),
  internal_notification_id TEXT,
  internal_notification_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  restocked_at TEXT,
  notified_at TEXT
)`;

const PREVIEW_UNIQUE_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_waitlist_waiting_email_product
  ON stock_waitlist (product_id, lower(email))
  WHERE status = 'waiting'`;

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function safeErrorName(error) {
  return error && typeof error === 'object' && typeof error.name === 'string'
    ? error.name
    : 'Error';
}

async function ensurePreviewSchema(db) {
  let pending = previewSchemaPromises.get(db);
  if (!pending) {
    pending = (async () => {
      await db.prepare(PREVIEW_TABLE_SQL).bind().run();
      await db.prepare(PREVIEW_UNIQUE_INDEX_SQL).bind().run();
    })();
    previewSchemaPromises.set(db, pending);
  }
  try {
    await pending;
  } catch (error) {
    previewSchemaPromises.delete(db);
    throw error;
  }
}

function normalizeEmail(value) {
  const email = cleanString(value).toLowerCase();
  if (email.length < 5 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function resolveFormEnvironment(env) {
  const appEnv = cleanString(env?.APP_ENV);
  if (appEnv === 'preview') {
    return {
      ok: true,
      isAllowedHostname: hostname => PAGES_PREVIEW_HOSTNAME_RE.test(hostname),
    };
  }
  if (appEnv === 'production') {
    const allowed = cleanString(env?.ALLOWED_HOSTS)
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
    if (allowed.length === 0) return { ok: false };
    const allowedSet = new Set(allowed);
    return {
      ok: true,
      isAllowedHostname: hostname => allowedSet.has(hostname),
    };
  }
  return { ok: false };
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

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function buildStockWaitlistEmail({ product, email, sourceUrl }) {
  const subject = `Aviso de stock solicitado — ${product.title}`;
  const text = [
    'Nueva solicitud de aviso de stock',
    '',
    `Libro: ${product.title}`,
    `Mercado Libre ID: ${product.id}`,
    `Correo del cliente: ${email}`,
    `Ficha: ${sourceUrl}`,
  ].join('\n');
  const html = `<!doctype html>
<html lang="es">
  <body style="font-family:Arial,sans-serif;color:#222;line-height:1.45">
    <h1 style="font-size:22px">Nueva solicitud de aviso de stock</h1>
    <p><strong>Libro:</strong> ${escapeHtml(product.title)}<br>
       <strong>Mercado Libre ID:</strong> ${escapeHtml(product.id)}<br>
       <strong>Correo:</strong> ${escapeHtml(email)}</p>
    <p><a href="${escapeHtml(sourceUrl)}">Abrir ficha del libro</a></p>
  </body>
</html>`;
  return { subject, text, html };
}

async function sendInternalNotification({ env, product, email, sourceUrl, waitlistId, fetchFn }) {
  const config = resolveEmailConfig(env);
  if (!config) return { ok: false, skipped: true, code: 'EMAIL_CONFIG_MISSING' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);
  let response;
  try {
    response = await fetchFn(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `stock-waitlist/${waitlistId}`,
      },
      body: JSON.stringify({
        from: config.from,
        to: config.to,
        ...buildStockWaitlistEmail({ product, email, sourceUrl }),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    return {
      ok: false,
      code: error?.name === 'AbortError' ? 'RESEND_TIMEOUT' : 'RESEND_NETWORK_ERROR',
    };
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = await response.json(); } catch { /* respuesta opcional */ }
  if (response.ok && typeof data?.id === 'string' && data.id) {
    return { ok: true, providerId: data.id };
  }
  return { ok: false, code: `RESEND_HTTP_${response.status}` };
}

async function recordNotificationResult(db, waitlistId, result, now) {
  const status = result.ok ? 'sent' : result.skipped ? 'skipped' : 'failed';
  const providerId = result.ok ? result.providerId : null;
  const errorCode = result.ok ? null : cleanString(result.code).slice(0, 80) || 'RESEND_ERROR';
  await db.prepare(
    'UPDATE stock_waitlist SET internal_notification_status=?, internal_notification_id=?, ' +
    'internal_notification_error=?, updated_at=? WHERE id=?'
  ).bind(status, providerId, errorCode, now.toISOString(), waitlistId).run();
}

export function createStockWaitlistHandler({
  fetchCatalog,
  fetchPausedItem,
  verifyTurnstileToken = verifyTurnstile,
  fetchFn = globalThis.fetch,
  getNow = () => new Date(),
} = {}) {
  return async function onRequest(context) {
    const { request, env } = context;

    if (request.method !== 'POST') {
      return json({ error: 'Método no permitido.' }, 405, { Allow: 'POST' });
    }
    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
      return json({ error: 'Content-Type debe ser application/json.' }, 415);
    }

    const contentLength = Number.parseInt(request.headers.get('Content-Length') || '0', 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return json({ error: 'Solicitud demasiado grande.' }, 413);
    }

    let body;
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
        return json({ error: 'Solicitud demasiado grande.' }, 413);
      }
      body = JSON.parse(text);
    } catch {
      return json({ error: 'JSON inválido.' }, 400);
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json({ error: 'Solicitud inválida.' }, 400);
    }

    // Honeypot: los navegadores reales nunca completan este campo.
    // Se responde como éxito para no enseñar al bot cómo evadirlo.
    if (cleanString(body.company)) {
      return json({ ok: true, registered: true }, 201);
    }

    const productId = cleanString(body.product_id).toUpperCase();
    const email = normalizeEmail(body.email);
    if (!/^MLU\d+$/.test(productId)) {
      return json({ error: 'Libro inválido.' }, 400);
    }
    if (!email) {
      return json({ error: 'Ingresá un correo válido.' }, 400);
    }

    const formEnv = resolveFormEnvironment(env);
    if (!formEnv.ok) return json({ error: 'Servicio no disponible.' }, 503);

    const db = env?.ORDERS_DB;
    if (!db) return json({ error: 'Servicio no disponible.' }, 503);
    const tsSecret = cleanString(env?.TURNSTILE_SECRET_KEY);
    if (!tsSecret) {
      return json({ error: 'Servicio de verificación no configurado.', code: 'TS_NOT_CONFIGURED' }, 503);
    }

    const tsToken = cleanString(body.cf_turnstile_response);
    if (!tsToken) return json({ error: 'Verificación requerida.', code: 'TOKEN_MISSING' }, 403);
    if (tsToken.length > 2048) return json({ error: 'Token inválido.', code: 'TOKEN_INVALID' }, 403);

    const tsResult = await verifyTurnstileToken(
      tsToken,
      tsSecret,
      request.headers.get('CF-Connecting-IP') || '',
      { action: 'stock_waitlist', isAllowedHostname: formEnv.isAllowedHostname }
    );
    if (!tsResult.ok) {
      const serviceError = tsResult.code === 'SITEVERIFY_ERROR' || tsResult.code === 'SITEVERIFY_TIMEOUT';
      return json(
        { error: serviceError ? 'Servicio de verificación no disponible.' : 'Verificación fallida.', code: tsResult.code },
        serviceError ? 503 : 403
      );
    }

    const catalog = await fetchCatalog(context).catch(() => null);
    const activeCatalogAvailable = catalog && Array.isArray(catalog.items);
    let product = activeCatalogAvailable
      ? catalog.items.find(item => item?.id === productId)
      : null;
    if (!product && cleanString(env?.APP_ENV) === 'preview' && typeof fetchPausedItem === 'function') {
      product = await fetchPausedItem(context, productId).catch(() => null);
    }
    if (!product && !activeCatalogAvailable) {
      return json({ error: 'Catálogo no disponible. Intentá nuevamente.' }, 503);
    }
    if (!product) return json({ error: 'Libro no encontrado.' }, 404);
    const inStock = product.status === 'active' && Number(product.available_quantity) > 0;
    if (inStock) {
      return json({ error: 'Este libro ya está disponible.', code: 'ALREADY_IN_STOCK' }, 409);
    }

    // El token usado por el pipeline de Preview publica Pages pero no tiene
    // permisos de administración D1. El binding runtime sí puede escribir.
    // Por eso Preview inicializa idempotentemente solo su tabla propia.
    // Producción nunca usa este atajo: allí se exige aplicar 0003 antes del merge.
    if (cleanString(env?.APP_ENV) === 'preview') {
      try {
        await ensurePreviewSchema(db);
      } catch (error) {
        console.error('[stock-waitlist] Preview schema error', safeErrorName(error));
        return json({ error: 'Servicio no disponible.' }, 503);
      }
    }

    const now = getNow();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      return json({ error: 'Error interno. Intentá nuevamente.' }, 500);
    }
    const waitlistId = crypto.randomUUID();
    const requestedPath = cleanString(body.source_path);
    const sourcePath = /^\/libro\/MLU\d+(?:\/[a-z0-9-]+)?$/i.test(requestedPath)
      ? requestedPath
      : `/libro/${product.id}`;
    const sourceUrl = new URL(request.url).origin + sourcePath;

    let inserted;
    try {
      inserted = await db.prepare(
        'INSERT OR IGNORE INTO stock_waitlist ' +
        '(id,product_id,product_title,email,status,source_url,internal_notification_status,created_at,updated_at) ' +
        "VALUES (?,?,?,?,'waiting',?,'pending',?,?)"
      ).bind(
        waitlistId,
        product.id,
        cleanString(product.title).slice(0, 500) || product.id,
        email,
        sourceUrl,
        now.toISOString(),
        now.toISOString()
      ).run();
    } catch (error) {
      console.error('[stock-waitlist] D1 insert error', safeErrorName(error));
      return json({ error: 'No pudimos guardar el aviso. Intentá nuevamente.' }, 503);
    }

    if (Number(inserted?.meta?.changes) === 0) {
      return json({ ok: true, registered: true, already_registered: true }, 200);
    }

    const notificationPromise = (async () => {
      const result = await sendInternalNotification({
        env,
        product,
        email,
        sourceUrl,
        waitlistId,
        fetchFn,
      });
      try {
        await recordNotificationResult(db, waitlistId, result, getNow());
      } catch (error) {
        console.error('[stock-waitlist] notification state error', safeErrorName(error));
      }
    })();
    if (typeof context.waitUntil === 'function') context.waitUntil(notificationPromise);
    else await notificationPromise;

    return json({ ok: true, registered: true, already_registered: false }, 201);
  };
}
