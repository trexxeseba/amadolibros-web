/**
 * functions/panel/[[path]].js
 *
 * PANEL-BACKEND-1 — panel interno en /panel.
 *
 * Rutas:
 *   GET  /panel         → login si no hay sesión válida, tablero si la hay
 *   GET  /panel/pedido/<código> → la ficha del pedido: qué va en la caja,
 *                       a dónde va, el pago y el historial
 *   POST /panel/login   → Turnstile + contraseña → cookie de sesión firmada
 *   POST /panel/logout  → borra la cookie
 *
 * Reglas que este archivo no puede romper:
 * - Solo lectura. No hay ninguna escritura al catálogo, a los pedidos ni a
 *   Mercado Libre; el panel mira, no toca.
 * - Sin secrets configurados responde 503, nunca una versión "abierta".
 * - Todo lo que sale de D1 se escapa antes de entrar al HTML: los nombres y
 *   títulos los escribe gente de afuera y terminan en esta página.
 * - noindex + no-store en todas las respuestas, y ningún enlace público entra
 *   acá (no está en el sitemap ni en la navegación).
 */

import { verifyTurnstile } from '../api/_turnstile.js';
import {
  clearFailedLogins,
  clearedSessionCookieHeader,
  createSessionToken,
  deriveSessionSecret,
  hasValidSession,
  loginAttemptsExceeded,
  recordFailedLogin,
  resolvePanelConfig,
  sessionCookieHeader,
  timingSafeEqual,
} from '../_shared/panel-auth.js';
import { loadOrder, loadPanelData } from '../_shared/panel-data.js';

// Mismo patrón que functions/api/_stock_waitlist_handler.js: el panel no puede
// aceptar un hostname de Preview que el resto del sitio rechaza, ni al revés.
const PAGES_PREVIEW_HOSTNAME_RE = /^[^.]+\.amadolibros-web\.pages\.dev$/;
const TURNSTILE_ACTION = 'panel_login';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function htmlResponse(body, { status = 200, extraHeaders = {} } = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      ...extraHeaders,
    },
  });
}

function redirectToPanel(extraHeaders = {}) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: '/panel',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function resolveTurnstileEnvironment(env) {
  const appEnv = cleanString(env?.APP_ENV);
  if (appEnv === 'preview') {
    return { ok: true, isAllowedHostname: hostname => PAGES_PREVIEW_HOSTNAME_RE.test(hostname) };
  }
  if (appEnv === 'production') {
    const allowed = cleanString(env?.ALLOWED_HOSTS).split(',').map(v => v.trim()).filter(Boolean);
    if (allowed.length === 0) return { ok: false };
    const allowedSet = new Set(allowed);
    return { ok: true, isAllowedHostname: hostname => allowedSet.has(hostname) };
  }
  return { ok: false };
}

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `$ ${number.toLocaleString('es-UY')}`;
}

function shortDate(value) {
  const raw = cleanString(value);
  if (!raw) return '—';
  return escapeHtml(raw.slice(0, 16).replace('T', ' '));
}

function layout(title, body) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; padding:1.5rem; font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
         background:#f6f7f9; color:#1f2933; }
  main { max-width:1100px; margin:0 auto; }
  h1 { font-size:1.4rem; margin:0; }
  h2 { font-size:1.05rem; margin:0 0 .75rem; }
  .top { display:flex; justify-content:space-between; align-items:baseline; gap:1rem;
         flex-wrap:wrap; margin-bottom:1.25rem; }
  .muted { color:#6b7280; font-size:.85rem; }
  .card { background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:1rem 1.15rem;
          margin-bottom:1rem; }
  .card.alert { border-color:#f0b429; background:#fffbeb; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:.75rem; }
  .stat { background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:.75rem .9rem; }
  .stat b { display:block; font-size:1.5rem; line-height:1.2; }
  .stat span { color:#6b7280; font-size:.8rem; }
  .scroll { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; font-size:.85rem; }
  th,td { text-align:left; padding:.4rem .55rem; border-bottom:1px solid #eef0f3; white-space:nowrap; }
  th { color:#6b7280; font-weight:600; }
  .err { color:#b42318; }
  .ok { color:#087443; }
  form.login { max-width:340px; margin:12vh auto 0; }
  label { display:block; margin:.75rem 0 .25rem; font-weight:600; }
  input[type=password] { width:100%; padding:.55rem .65rem; border:1px solid #cbd2d9; border-radius:8px;
                         font-size:1rem; }
  button { margin-top:1rem; padding:.55rem 1.1rem; border:0; border-radius:8px; background:#1f2933;
           color:#fff; font-size:.95rem; cursor:pointer; }
  .logout { background:none; color:#6b7280; border:1px solid #cbd2d9; margin:0; padding:.35rem .8rem; }
  .empty { color:#6b7280; font-style:italic; font-size:.85rem; }
  .topbar { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem;
            flex-wrap:wrap; margin-bottom:1.25rem; }
  .back { display:inline-block; color:#6b7280; text-decoration:none; font-size:.85rem;
          margin-bottom:.35rem; }
  .back:hover { color:#1f2933; }
  .tag { border:1px solid #cbd2d9; border-radius:999px; padding:.2rem .7rem; font-size:.8rem;
         color:#6b7280; white-space:nowrap; }
  .tag.alerta { border-color:#f0b429; background:#fffbeb; color:#8a5200; font-weight:600; }
  dl { margin:0; display:grid; grid-template-columns:auto 1fr; gap:.35rem .9rem; font-size:.88rem; }
  dt { color:#6b7280; white-space:nowrap; }
  dd { margin:0; text-align:right; }
  dl.totales { margin-top:.9rem; padding-top:.75rem; border-top:1px solid #eef0f3; }
  .total { font-weight:700; font-size:1rem; color:#1f2933; }
  .direccion { margin:.85rem 0 0; padding:.7rem .8rem; background:#f6f7f9; border-radius:8px;
               font-size:.9rem; line-height:1.45; }
  .nota { margin:.6rem 0 0; padding:.6rem .8rem; border-left:3px solid #cbd2d9; color:#4b5563;
          font-style:italic; font-size:.88rem; }
  tbody tr a { color:inherit; text-decoration:none; display:block; }
  tbody tr:hover { background:#f6f7f9; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function loginPage({ siteKey, error = '' }) {
  const widget = siteKey
    ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}" data-action="${TURNSTILE_ACTION}" data-theme="light"></div>
       <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
    : '<p class="err">Falta configurar Turnstile para el panel.</p>';

  return layout('Panel — Amado Libros', `
<form class="login card" method="POST" action="/panel/login">
  <h1>Panel interno</h1>
  <p class="muted">Amado Libros</p>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
  <label for="panel-password">Contraseña</label>
  <input id="panel-password" name="password" type="password" autocomplete="current-password"
         required maxlength="200" autofocus>
  ${widget}
  <button type="submit">Entrar</button>
</form>`);
}

function statusList(rows, labelKey = 'status') {
  if (!rows.length) return '<p class="empty">Sin datos.</p>';
  return `<div class="grid">${rows.map(row => `
    <div class="stat"><b>${escapeHtml(row.total ?? 0)}</b><span>${escapeHtml(row[labelKey] ?? '—')}</span></div>
  `).join('')}</div>`;
}

function table(headers, rows, renderRow) {
  if (!rows.length) return '<p class="empty">Nada por acá. 👌</p>';
  return `<div class="scroll"><table>
    <thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(renderRow).join('')}</tbody>
  </table></div>`;
}

function sectionOrError(block, render) {
  if (!block?.ok) {
    return `<p class="err">No se pudo cargar: ${escapeHtml(block?.error || 'error desconocido')}</p>`;
  }
  return render(block.data);
}


const EVENT_LABEL = {
  preference_created: 'Pago iniciado',
  payment_approved: 'Pago aprobado',
  payment_pending: 'Pago pendiente',
  payment_rejected: 'Pago rechazado',
  payment_cancelled: 'Pago cancelado',
  payment_refunded: 'Pago devuelto',
  order_unavailable: 'Sin stock al confirmar',
  already_sent: 'Aviso ya enviado',
};

function deliveryWindow(order) {
  const day = shortDate(order.requested_delivery_date);
  if (day === '—') return 'Sin fecha pedida';
  const from = cleanString(order.requested_delivery_from);
  const to = cleanString(order.requested_delivery_to);
  return from && to ? `${day.slice(0, 10)}, de ${escapeHtml(from)} a ${escapeHtml(to)}` : day.slice(0, 10);
}

/**
 * La ficha de un pedido: qué va en la caja, a dónde va y qué le pasó.
 * Es la pantalla que se usa para despachar, así que lo primero es el contenido
 * y la dirección — no los identificadores internos.
 */
function orderPage(found) {
  const { order, items, events } = found;
  const units = items.reduce((total, item) => total + Number(item.quantity || 0), 0);
  const pickup = order.delivery_type === 'pickup';
  const pending = order.payment_status === 'approved' && !order.fulfilled_at;

  const body = `
<div class="topbar">
  <div>
    <a class="back" href="/panel">← Pedidos</a>
    <h1>${escapeHtml(order.public_code)}</h1>
    <p class="muted">${escapeHtml(order.buyer_name)} · ${escapeHtml(units)} libro${units === 1 ? '' : 's'} · ${shortDate(order.created_at)}</p>
  </div>
  <span class="tag ${pending ? 'alerta' : ''}">${pending ? 'Pagado sin despachar' : escapeHtml(order.status)}</span>
</div>

<section class="card">
  <h2>Qué va en la caja</h2>
  ${table(['Cant.', 'Libro', 'Publicación', 'Precio'], items, row => `
    <tr><td>${escapeHtml(row.quantity)}×</td>
        <td>${escapeHtml(row.title)}</td>
        <td>${escapeHtml(row.product_id)}</td>
        <td>${money(row.line_total_uyu)}</td></tr>`)}
  <dl class="totales">
    <dt>Libros</dt><dd>${money(order.products_total_uyu)}</dd>
    ${Number(order.shipping_cost_uyu) ? `<dt>Envío</dt><dd>${money(order.shipping_cost_uyu)}</dd>` : ''}
    ${Number(order.pickup_discount_uyu) ? `<dt>Descuento por retiro</dt><dd>−${money(order.pickup_discount_uyu)}</dd>` : ''}
    <dt class="total">Total</dt><dd class="total">${money(order.payable_total_uyu)}</dd>
  </dl>
</section>

<section class="card">
  <h2>${pickup ? 'Retira en el local' : 'A dónde va'}</h2>
  <dl>
    <dt>Entrega</dt><dd>${pickup ? 'Retiro' : 'Envío'}</dd>
    <dt>Teléfono</dt><dd>${escapeHtml(order.buyer_phone)}</dd>
    <dt>Correo</dt><dd>${escapeHtml(order.buyer_email)}</dd>
    <dt>Fecha pedida</dt><dd>${deliveryWindow(order)}</dd>
  </dl>
  ${pickup ? '' : `<p class="direccion">${escapeHtml(order.address)}<br>${escapeHtml(order.locality)}, ${escapeHtml(order.department)}</p>`}
  ${cleanString(order.delivery_notes) ? `<p class="nota">“${escapeHtml(order.delivery_notes)}”</p>` : ''}
</section>

<section class="card">
  <h2>Pago</h2>
  <dl>
    <dt>Estado</dt><dd>${escapeHtml(order.payment_status)}</dd>
    <dt>Medio</dt><dd>${escapeHtml(order.payment_provider) || '—'}</dd>
    <dt>ID de pago</dt><dd>${escapeHtml(order.payment_id) || '—'}</dd>
    <dt>Cobrado</dt><dd>${shortDate(order.paid_at)}</dd>
    <dt>Despachado</dt><dd>${shortDate(order.fulfilled_at)}</dd>
  </dl>
</section>

<section class="card">
  <h2>Historial</h2>
  ${table(['Qué pasó', 'Cuándo'], events, row => `
    <tr><td>${escapeHtml(EVENT_LABEL[row.event_type] || row.event_type)}</td>
        <td>${shortDate(row.created_at)}</td></tr>`)}
</section>`;

  return layout(`Pedido ${order.public_code}`, body);
}

function dashboardPage(data) {
  const env = data.environment;
  const stuckCount = data.stuck?.ok ? data.stuck.data.total : null;
  // Se cuenta aparte de `stuckCount`: viene del catálogo, no de D1, así que uno
  // puede estar disponible y el otro caído. La tarjeta se enciende con cualquiera.
  const missingImageCount = data.catalog?.ok ? (data.catalog.data.missingImage?.count || 0) : 0;

  return layout('Panel — Amado Libros', `
<div class="top">
  <div>
    <h1>Panel interno</h1>
    <p class="muted">
      Entorno ${escapeHtml(env.appEnv)} ·
      checkout ${env.checkoutEnabled ? '<span class="ok">encendido</span>' : '<span class="err">apagado</span>'} ·
      D1 ${env.hasOrdersDb ? '<span class="ok">ok</span>' : '<span class="err">sin binding</span>'} ·
      datos al ${shortDate(data.generatedAt)} UTC
    </p>
  </div>
  <form method="POST" action="/panel/logout"><button class="logout" type="submit">Salir</button></form>
</div>

<section class="card ${stuckCount || missingImageCount ? 'alert' : ''}">
  <h2>Qué quedó trancado${stuckCount ? ` (${stuckCount})` : ''}</h2>
  ${sectionOrError(data.stuck, stuck => `
    <h3 class="muted">Pagados sin despachar</h3>
    ${table(['Pedido', 'Comprador', 'Total', 'Pagado'], stuck.paidNotFulfilled, row => `
      <tr><td><a href="/panel/pedido/${encodeURIComponent(row.public_code)}">${escapeHtml(row.public_code)}</a></td><td>${escapeHtml(row.buyer_name)}</td>
          <td>${money(row.payable_total_uyu)}</td><td>${shortDate(row.paid_at)}</td></tr>`)}

    <h3 class="muted">Pago colgado hace más de una hora</h3>
    ${table(['Pedido', 'Comprador', 'Total', 'Creado'], stuck.paymentHanging, row => `
      <tr><td>${escapeHtml(row.public_code)}</td><td>${escapeHtml(row.buyer_name)}</td>
          <td>${money(row.payable_total_uyu)}</td><td>${shortDate(row.created_at)}</td></tr>`)}

    <h3 class="muted">Repuesto y todavía sin avisar al cliente</h3>
    ${table(['Libro', 'Cliente', 'Repuesto'], stuck.waitlistRestocked, row => `
      <tr><td>${escapeHtml(row.product_title)}</td><td>${escapeHtml(row.email)}</td>
          <td>${shortDate(row.restocked_at)}</td></tr>`)}

    <h3 class="muted">Avisos internos que fallaron</h3>
    ${table(['Libro', 'Estado', 'Creado'], stuck.notificationFailed, row => `
      <tr><td>${escapeHtml(row.product_title)}</td>
          <td>${escapeHtml(row.internal_notification_status)}</td>
          <td>${shortDate(row.created_at)}</td></tr>`)}
  `)}

  <h3 class="muted">Ficha sin imagen para Google${missingImageCount ? ` (${missingImageCount})` : ''}</h3>
  ${sectionOrError(data.catalog, catalog => {
    const missing = catalog.missingImage || { count: 0, items: [] };
    if (!missing.count) return '<p class="empty">Nada por acá. 👌</p>';
    return `
      <p class="muted">
        Estas fichas no tienen ninguna foto, así que salen a Google sin imagen.
        Es lo que Search Console reporta como «Falta el campo image».
        ${missing.count > missing.items.length
          ? `Se muestran las primeras ${missing.items.length} de ${missing.count}.`
          : ''}
      </p>
      ${table(['Libro', 'Estado', 'Ficha'], missing.items, row => `
        <tr><td>${escapeHtml(row.title)}</td><td>${escapeHtml(row.status)}</td>
            <td>${row.id
              ? `<a href="https://www.amadolibros.com/libro/${escapeHtml(row.id)}" rel="noreferrer">${escapeHtml(row.id)}</a>`
              : '—'}</td></tr>`)}`;
  })}
</section>

<section class="card">
  <h2>Pedidos</h2>
  ${sectionOrError(data.orders, orders => `
    <div class="grid">
      <div class="stat"><b>${escapeHtml(orders.paidLast30.total ?? 0)}</b><span>cobrados (30 días)</span></div>
      <div class="stat"><b>${money(orders.paidLast30.total_uyu)}</b><span>facturado (30 días)</span></div>
    </div>
    <h3 class="muted">Por estado</h3>
    ${statusList(orders.byStatus)}
    <h3 class="muted">Últimos ${orders.recent.length}</h3>
    ${table(['Pedido', 'Estado', 'Pago', 'Comprador', 'Entrega', 'Total', 'Creado'], orders.recent, row => `
      <tr><td><a href="/panel/pedido/${encodeURIComponent(row.public_code)}">${escapeHtml(row.public_code)}</a></td><td>${escapeHtml(row.status)}</td>
          <td>${escapeHtml(row.payment_status)}</td><td>${escapeHtml(row.buyer_name)}</td>
          <td>${escapeHtml(row.delivery_type)}</td><td>${money(row.payable_total_uyu)}</td>
          <td>${shortDate(row.created_at)}</td></tr>`)}
  `)}
</section>

<section class="card">
  <h2>Avisos de stock</h2>
  ${sectionOrError(data.waitlist, waitlist => `
    ${statusList(waitlist.byStatus)}
    <h3 class="muted">Libros más esperados</h3>
    ${table(['Libro', 'ID', 'Personas'], waitlist.topProducts, row => `
      <tr><td>${escapeHtml(row.product_title)}</td><td>${escapeHtml(row.product_id)}</td>
          <td>${escapeHtml(row.total)}</td></tr>`)}
  `)}
</section>

<section class="card">
  <h2>Productos</h2>
  ${sectionOrError(data.catalog, catalog => `
    <div class="grid">
      <div class="stat"><b>${escapeHtml(catalog.total)}</b><span>publicaciones activas</span></div>
      <div class="stat"><b>${escapeHtml(catalog.withStock)}</b><span>con stock</span></div>
      <div class="stat"><b>${escapeHtml(catalog.withoutImage)}</b><span>sin imagen</span></div>
      <div class="stat"><b>${escapeHtml(catalog.withoutIsbn)}</b><span>sin ISBN</span></div>
    </div>
    <p class="muted">Catálogo generado: ${shortDate(catalog.generatedAt)}</p>

    <h3 class="muted">Cuántos llegan a Google Shopping</h3>
    <div class="grid">
      <div class="stat"><b>${escapeHtml(catalog.feed.activeTotal)}</b><span>libros activos</span></div>
      <div class="stat"><b>${escapeHtml(catalog.feed.eligible)}</b><span>pasan la puerta comercial</span></div>
      <div class="stat ${catalog.feed.blocked ? 'alert' : ''}"><b>${escapeHtml(catalog.feed.blocked)}</b><span>quedan afuera</span></div>
    </div>
    ${catalog.feed.blockers.length
      ? `<p class="muted">Por qué quedan afuera:</p>
         ${table(['Motivo', 'Libros'], catalog.feed.blockers, row => `
           <tr><td>${escapeHtml(row.reason)}</td><td>${escapeHtml(row.total)}</td></tr>`)}`
      : ''}
    <p class="muted">
      Esta es sólo la primera puerta: precio, moneda, stock, enlace y que se reconozca
      como libro. Después hay una segunda —que la portada esté lista— que no se mide acá.
      O sea que la cantidad real de ofertas en Merchant es <b>igual o menor</b> a
      ${escapeHtml(catalog.feed.eligible)}, nunca mayor.
    </p>
  `)}
</section>

<section class="card">
  <h2>Rastreo de Google</h2>
  <p class="muted">
    Esto es Googlebot rastreando el sitio, no visitas de personas. Las visitas reales
    están en GA4 y necesitan una credencial que el panel todavía no tiene.
  </p>
  ${sectionOrError(data.crawl, crawl => table(
    ['Día', 'Requests', 'Errores', 'Googlebot verificado'],
    crawl.days,
    row => `<tr><td>${escapeHtml(row.date)}</td><td>${escapeHtml(row.requests ?? 0)}</td>
                <td>${escapeHtml(row.errors ?? 0)}</td>
                <td>${escapeHtml(row.verified_googlebot ?? 0)}</td></tr>`,
  ))}
</section>`);
}

function clientIp(request) {
  return cleanString(request?.headers?.get?.('cf-connecting-ip'));
}

async function handleLogin(context, config) {
  const { request, env } = context;
  const ip = clientIp(request);

  if (await loginAttemptsExceeded(env?.AMADO_KV, ip)) {
    return htmlResponse(
      loginPage({
        siteKey: cleanString(env?.STOCK_WAITLIST_TURNSTILE_SITE_KEY),
        error: 'Demasiados intentos fallidos. Probá de nuevo en 15 minutos.',
      }),
      { status: 429 },
    );
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return htmlResponse(
      loginPage({ siteKey: cleanString(env?.STOCK_WAITLIST_TURNSTILE_SITE_KEY), error: 'Formulario inválido.' }),
      { status: 400 },
    );
  }

  const siteKey = cleanString(env?.STOCK_WAITLIST_TURNSTILE_SITE_KEY);
  const fail = async (message, status = 401) => {
    await recordFailedLogin(env?.AMADO_KV, ip);
    return htmlResponse(loginPage({ siteKey, error: message }), { status });
  };

  const turnstileEnv = resolveTurnstileEnvironment(env);
  const turnstileSecret = cleanString(env?.TURNSTILE_SECRET_KEY);
  if (!turnstileEnv.ok || !turnstileSecret) {
    return htmlResponse(
      loginPage({ siteKey, error: 'El panel no está configurado para validar Turnstile.' }),
      { status: 503 },
    );
  }

  const turnstile = await verifyTurnstile(
    cleanString(form.get('cf-turnstile-response')),
    turnstileSecret,
    ip,
    { action: TURNSTILE_ACTION, isAllowedHostname: turnstileEnv.isAllowedHostname },
  );
  if (!turnstile.ok) return fail('No pudimos verificar que seas humano. Recargá y probá otra vez.');

  // La contraseña se compara en tiempo constante y el mensaje de error es el
  // mismo para "vacía" y "equivocada": nada de lo que responde el panel dice
  // qué tan cerca estuvo el intento.
  const submitted = form.get('password');
  if (!timingSafeEqual(typeof submitted === 'string' ? submitted : '', config.password)) {
    return fail('Contraseña incorrecta.');
  }

  await clearFailedLogins(env?.AMADO_KV, ip);
  const token = await createSessionToken(await deriveSessionSecret(config.password));
  return redirectToPanel({ 'Set-Cookie': sessionCookieHeader(token) });
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  // Pages sólo enruta /panel y /panel/* hasta acá; se normaliza la barra final.
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

  const config = resolvePanelConfig(context.env);
  if (!config.ok) {
    // Sin contraseña no hay panel: ni login ni tablero. Nunca "abierto por defecto".
    return htmlResponse(
      layout('Panel no disponible', '<main class="card"><h1>Panel no disponible</h1>'
        + '<p class="muted">Falta PANEL_PASSWORD en este entorno (mínimo 12 caracteres).</p></main>'),
      { status: 503 },
    );
  }

  if (path === '/panel/logout') {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    return redirectToPanel({ 'Set-Cookie': clearedSessionCookieHeader() });
  }

  if (path === '/panel/login') {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    return handleLogin(context, config);
  }

  const pedido = /^\/panel\/pedido\/([^/]+)$/.exec(path);
  if (pedido) {
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
    if (!(await hasValidSession(request, await deriveSessionSecret(config.password)))) {
      return htmlResponse(loginPage({
        siteKey: cleanString(context.env?.STOCK_WAITLIST_TURNSTILE_SITE_KEY),
      }));
    }
    const db = context.env?.ORDERS_DB;
    // Un pedido inexistente y un código inválido responden igual: la ficha no
    // sirve para averiguar qué códigos existen.
    const found = db ? await loadOrder(db, decodeURIComponent(pedido[1])) : null;
    if (!found) {
      return htmlResponse(
        layout('Pedido no encontrado', '<main class="card"><a class="back" href="/panel">← Pedidos</a>'
          + '<h1>Pedido no encontrado</h1><p class="muted">Revisá el código.</p></main>'),
        { status: 404 },
      );
    }
    return htmlResponse(orderPage(found));
  }

  if (path !== '/panel') return new Response('Not Found', { status: 404 });
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

  if (!(await hasValidSession(request, await deriveSessionSecret(config.password)))) {
    return htmlResponse(loginPage({
      siteKey: cleanString(context.env?.STOCK_WAITLIST_TURNSTILE_SITE_KEY),
    }));
  }

  const data = await loadPanelData(context);
  return htmlResponse(dashboardPage(data));
}
