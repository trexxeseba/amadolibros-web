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
 *   POST /panel/pedido/<código>/avisar → le manda al cliente el aviso de
 *                       retiro o de envío
 *   GET  /panel/ajustes → datos de retiro que salen en el correo al cliente
 *   POST /panel/ajustes → los guarda en KV
 *   POST /panel/logout  → borra la cookie
 *
 * Reglas que este archivo no puede romper:
 * - El panel NO toca el catálogo, los pedidos ni Mercado Libre. Precio, stock,
 *   título, slug, imágenes y estado del pedido se leen y nunca se escriben.
 *   Lo único que el panel escribe son los datos de retiro en KV y una fila de
 *   historial por cada aviso que le manda a un cliente. Un aviso no despacha
 *   el pedido ni le cambia el estado: sólo manda un correo y lo anota.
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
import { revenueChart, revenueTable } from '../_shared/panel-chart.js';
import { loadPickup, pickupComplete, savePickup } from '../_shared/panel-settings.js';
import {
  NOTICE_EVENT_TYPE,
  NOTICE_KINDS,
  NOTICE_LABEL,
  noticeBlockedReason,
  noticeStateFromEvents,
  sendNotice,
} from '../_shared/panel-notice.js';
import { createTrackedEmailSender } from '../api/_order_email.js';

const sendTrackedEmail = createTrackedEmailSender();

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

/**
 * Sólo el día. En la tabla del tablero la hora no aporta nada a la mirada
 * rápida y empuja la última columna fuera de la tarjeta: la fecha terminaba
 * cortada a la mitad. La hora exacta está en la ficha del pedido.
 */
function shortDay(value) {
  const raw = cleanString(value);
  if (!raw) return '—';
  return escapeHtml(raw.slice(0, 10));
}

function shortDate(value) {
  const raw = cleanString(value);
  if (!raw) return '—';
  return escapeHtml(raw.slice(0, 16).replace('T', ' '));
}

/**
 * El menú lateral. Sólo lleva a lugares que existen: el tablero, la pantalla
 * de ajustes y las secciones de esta misma página. Un menú con "Clientes" o
 * "Marketing" que no abre nada se ve bien en una captura y estorba al usarlo.
 */
function sidebar(activo = 'tablero') {
  const items = [
    { id: 'tablero', href: '/panel', texto: 'Tablero', icono: '▦' },
    { id: 'pendientes', href: '/panel#pendientes', texto: 'Para hacer', icono: '◉' },
    { id: 'pedidos', href: '/panel#pedidos', texto: 'Pedidos', icono: '❑' },
    { id: 'catalogo', href: '/panel#catalogo', texto: 'Catálogo', icono: '❏' },
    { id: 'ajustes', href: '/panel/ajustes', texto: 'Ajustes', icono: '✧' },
  ];
  return `<nav class="lateral" aria-label="Secciones del panel">
  <a class="marca" href="/panel"><b>Amado</b><span>Libros</span></a>
  <ul>
    ${items.map(item => `<li><a href="${item.href}"
      class="${item.id === activo ? 'aqui' : ''}"
      ${item.id === activo ? 'aria-current="page"' : ''}
      ><i aria-hidden="true">${item.icono}</i>${escapeHtml(item.texto)}</a></li>`).join('')}
  </ul>
  <form class="salir" method="POST" action="/panel/logout">
    <button class="logout" type="submit">Salir</button>
  </form>
</nav>`;
}

function layout(title, body, { nav = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  /* Paleta de librería: papel, tinta y un solo acento. El panel se usa parado
     atrás del mostrador con el celular en la mano, así que lo primero tiene que
     ser legible de un vistazo y el resto tiene que poder plegarse. */
  :root {
    color-scheme: light dark;
    --papel:#faf8f5; --tarjeta:#fff; --borde:#e7e2da; --borde-suave:#f0ece5;
    --tinta:#241f1a; --tinta-media:#6b6157; --tinta-suave:#938a80;
    --acento:#9c3d2e; --acento-suave:#fdf3f1;
    --ok:#1f6b4a; --ok-suave:#eef7f2;
    --error:#b42318; --error-suave:#fef3f2;
    --alerta:#8a5200; --alerta-suave:#fdf6e7; --alerta-borde:#e8c26a;
    --sombra:0 1px 2px rgba(36,31,26,.05), 0 4px 12px rgba(36,31,26,.04);
    --radio:14px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --papel:#191715; --tarjeta:#222020; --borde:#35312d; --borde-suave:#2c2926;
      --tinta:#f2ede7; --tinta-media:#a89f95; --tinta-suave:#7d746b;
      --acento:#e08a76; --acento-suave:#2e211d;
      --ok:#6cc79b; --ok-suave:#1c2a24;
      --error:#f0917f; --error-suave:#2e1c1a;
      --alerta:#e8c26a; --alerta-suave:#2b2418; --alerta-borde:#5c4a24;
      --sombra:0 1px 2px rgba(0,0,0,.3), 0 4px 12px rgba(0,0,0,.2);
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--papel); color:var(--tinta);
         font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
         -webkit-font-smoothing:antialiased; }
  main { max-width:1080px; margin:0 auto; padding:0 1.25rem 4rem; }
  a { color:var(--acento); }

  /* ── Cabecera ───────────────────────────────────────────────────── */
  .top, .topbar { display:flex; justify-content:space-between; align-items:center;
                  gap:1rem; flex-wrap:wrap;
                  padding:1.35rem 0 1.15rem; margin-bottom:1.5rem;
                  border-bottom:1px solid var(--borde); }
  .topbar { align-items:flex-start; }
  h1 { font-size:1.5rem; letter-spacing:-.02em; margin:0; font-weight:650; }
  h2 { font-size:1.05rem; letter-spacing:-.01em; margin:0 0 .9rem; font-weight:650; }
  h3 { font-size:.8rem; font-weight:650; text-transform:uppercase;
       letter-spacing:.06em; color:var(--tinta-suave);
       margin:1.6rem 0 .55rem; }
  h3:first-of-type { margin-top:.5rem; }
  .muted { color:var(--tinta-media); font-size:.875rem; }
  p.muted { margin:.3rem 0 0; }
  .acciones { display:flex; gap:.5rem; align-items:center; }

  /* ── Tarjetas ───────────────────────────────────────────────────── */
  .card { background:var(--tarjeta); border:1px solid var(--borde);
          border-radius:var(--radio); padding:1.35rem 1.5rem;
          margin-bottom:1.1rem; box-shadow:var(--sombra); }
  .card.alert { border-color:var(--alerta-borde); background:var(--alerta-suave); }
  .card.alert > h2::before { content:"● "; color:var(--alerta); }

  /* Lo informativo se pliega: la página tiene que empezar corta. */
  details.card { padding:0; }
  details.card > summary { list-style:none; cursor:pointer; padding:1.1rem 1.5rem;
                           font-size:1.05rem; font-weight:650; letter-spacing:-.01em;
                           display:flex; justify-content:space-between; align-items:center;
                           gap:1rem; }
  details.card > summary::-webkit-details-marker { display:none; }
  details.card > summary::after { content:"▾"; color:var(--tinta-suave);
                                  font-size:.8rem; transition:transform .15s; }
  details.card[open] > summary::after { transform:rotate(180deg); }
  details.card > summary:hover { color:var(--acento); }
  details.card > .cuerpo { padding:0 1.5rem 1.35rem; }
  details.card > summary .resumen { color:var(--tinta-suave); font-weight:400;
                                    font-size:.85rem; margin-left:auto; }

  /* ── Menú lateral ───────────────────────────────────────────────── */
  body.con-lateral { display:flex; align-items:flex-start; }
  body.con-lateral main { flex:1; min-width:0; max-width:1080px; padding-top:.5rem; }
  .lateral { position:sticky; top:0; width:200px; flex:none; height:100vh;
             background:var(--tarjeta); border-right:1px solid var(--borde);
             display:flex; flex-direction:column; padding:1.35rem 0 1rem; }
  .marca { display:block; padding:0 1.25rem 1.35rem; text-decoration:none;
           color:var(--tinta); letter-spacing:-.02em; line-height:1.15; }
  .marca b { display:block; font-size:1.15rem; font-weight:700; }
  .marca span { color:var(--tinta-suave); font-size:.85rem; }
  .lateral ul { list-style:none; margin:0; padding:0 .6rem; flex:1;
                display:flex; flex-direction:column; gap:.15rem; }
  .lateral a:not(.marca) { display:flex; align-items:center; gap:.65rem;
    padding:.55rem .65rem; border-radius:9px; text-decoration:none;
    color:var(--tinta-media); font-size:.9rem; font-weight:500; }
  .lateral a:not(.marca):hover { background:var(--papel); color:var(--tinta); }
  .lateral a.aqui { background:var(--acento-suave); color:var(--acento); font-weight:650; }
  .lateral i { font-style:normal; font-size:.9rem; width:1.1rem; text-align:center; }
  .salir { padding:0 1.25rem; margin:0; }
  .salir button { width:100%; margin:0; }

  /* ── Tarjetas de indicadores ────────────────────────────────────── */
  .tarjetas { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr));
              gap:.8rem; margin-bottom:1.1rem; }
  .tarjetas > .err { grid-column:1/-1; margin:0; padding:1rem 1.15rem; font-size:.9rem;
                     border:1px solid var(--error); border-radius:var(--radio);
                     background:var(--error-suave); }
  .kpi { background:var(--tarjeta); border:1px solid var(--borde);
         border-radius:var(--radio); padding:1rem 1.15rem; box-shadow:var(--sombra);
         display:flex; flex-direction:column; gap:.15rem; }
  .kpi span { color:var(--tinta-media); font-size:.78rem; font-weight:600;
              text-transform:uppercase; letter-spacing:.05em; }
  .kpi b { font-size:1.75rem; font-weight:650; letter-spacing:-.03em; line-height:1.15; }
  .kpi small { color:var(--tinta-suave); font-size:.8rem; }
  .kpi-alerta { border-color:var(--alerta-borde); }
  .kpi-alerta b { color:var(--alerta); }

  /* ── Gráfico ────────────────────────────────────────────────────── */
  .card-cabeza { display:flex; justify-content:space-between; align-items:baseline;
                 gap:1rem; margin-bottom:1rem; }
  .card-cabeza h2 { margin:0; }
  figure.grafico { margin:0; }
  figure.grafico svg { width:100%; height:auto; display:block; overflow:visible; }
  /* La grilla y el eje son recesivos: la barra es el dato, no la regla. */
  .grilla { stroke:var(--borde-suave); stroke-width:1; }
  .base { stroke:var(--borde); stroke-width:1; }
  .barra { fill:var(--acento); }
  .blanco { fill:transparent; }
  .mes:hover .barra { filter:brightness(1.15); }
  .mes:hover .blanco { fill:var(--acento-suave); }
  .eje { fill:var(--tinta-suave); font-size:10px; text-anchor:middle;
         font-variant-numeric:tabular-nums; }
  .valor { fill:var(--tinta); font-size:11px; font-weight:650; text-anchor:middle; }
  .tabla-datos { margin-top:1rem; }
  .tabla-datos > summary { cursor:pointer; color:var(--tinta-media);
                           font-size:.85rem; padding:.3rem 0; }
  .tabla-datos > summary:hover { color:var(--acento); }

  /* ── Pastillas de estado ────────────────────────────────────────── */
  /* Color Y palabra: el color solo nunca alcanza. */
  .pastilla { display:inline-block; padding:.15rem .55rem; border-radius:999px;
              font-size:.78rem; font-weight:600; white-space:nowrap;
              border:1px solid transparent; }
  .p-bien   { background:var(--ok-suave);     color:var(--ok);     border-color:var(--ok); }
  .p-aviso  { background:var(--alerta-suave); color:var(--alerta); border-color:var(--alerta-borde); }
  .p-serio  { background:#fdf0e9;             color:#a1500f;       border-color:#e8b48f; }
  .p-grave  { background:var(--error-suave);  color:var(--error);  border-color:var(--error); }
  .p-neutro { background:var(--papel);        color:var(--tinta-media); border-color:var(--borde); }

  /* ── Números ────────────────────────────────────────────────────── */
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
          gap:.7rem; margin:.2rem 0 .4rem; }
  .stat { background:var(--papel); border:1px solid var(--borde-suave);
          border-radius:10px; padding:.85rem .95rem; }
  .stat b { display:block; font-size:1.6rem; line-height:1.15; font-weight:650;
            letter-spacing:-.03em; font-variant-numeric:tabular-nums; }
  .stat span { color:var(--tinta-media); font-size:.78rem; }
  .stat.alert { border-color:var(--alerta-borde); background:var(--alerta-suave); }
  .stat.alert b { color:var(--alerta); }

  /* ── Tablas ─────────────────────────────────────────────────────── */
  .scroll { overflow-x:auto; margin:0 -.35rem; padding:0 .35rem; }
  table { border-collapse:collapse; width:100%; font-size:.875rem; }
  th, td { text-align:left; padding:.6rem .7rem; white-space:nowrap; }
  th { color:var(--tinta-suave); font-weight:650; font-size:.72rem;
       text-transform:uppercase; letter-spacing:.06em;
       border-bottom:1px solid var(--borde); }
  td { border-bottom:1px solid var(--borde-suave); font-variant-numeric:tabular-nums; }
  tbody tr:last-child td { border-bottom:0; }
  tbody tr:hover { background:var(--acento-suave); }
  tbody tr a { color:var(--acento); text-decoration:none; font-weight:600; }
  tbody tr a:hover { text-decoration:underline; }

  /* ── Estados ────────────────────────────────────────────────────── */
  .err { color:var(--error); }
  .ok { color:var(--ok); }
  .empty { color:var(--tinta-suave); font-size:.875rem; margin:.4rem 0; }
  .tag { border:1px solid var(--borde); border-radius:999px; padding:.25rem .75rem;
         font-size:.78rem; color:var(--tinta-media); white-space:nowrap;
         background:var(--tarjeta); }
  .tag.alerta { border-color:var(--alerta-borde); background:var(--alerta-suave);
                color:var(--alerta); font-weight:650; }

  /* ── Botones ────────────────────────────────────────────────────── */
  button { margin-top:1rem; padding:.6rem 1.15rem; border:0; border-radius:9px;
           background:var(--acento); color:#fff; font:inherit; font-size:.9rem;
           font-weight:600; cursor:pointer; }
  button:hover { filter:brightness(1.08); }
  button[disabled] { background:var(--borde); color:var(--tinta-suave); cursor:not-allowed;
                     filter:none; }
  .logout, .linkbtn { background:none; color:var(--tinta-media);
                      border:1px solid var(--borde); margin:0;
                      padding:.4rem .85rem; text-decoration:none;
                      font-size:.85rem; font-weight:500; border-radius:9px; }
  .logout:hover, .linkbtn:hover { color:var(--tinta); border-color:var(--tinta-suave);
                                  filter:none; }
  .back { display:inline-block; color:var(--tinta-media); text-decoration:none;
          font-size:.85rem; margin-bottom:.4rem; }
  .back:hover { color:var(--acento); }

  /* ── Formularios ────────────────────────────────────────────────── */
  form.login { max-width:360px; margin:14vh auto 0; }
  label { display:block; margin:.85rem 0 .3rem; font-weight:600; font-size:.875rem; }
  input[type=password], form.card input[type=text], form.card input[type=number],
  form.card textarea {
    width:100%; max-width:32rem; padding:.65rem .75rem; border:1px solid var(--borde);
    border-radius:9px; font:inherit; font-size:.95rem;
    background:var(--tarjeta); color:var(--tinta); }
  input:focus-visible, button:focus-visible, summary:focus-visible {
    outline:2px solid var(--acento); outline-offset:2px; }
  form.card textarea { resize:vertical; }
  form.card input[type=number] { max-width:7rem; }

  /* ── Ficha de pedido ────────────────────────────────────────────── */
  dl { margin:0; display:grid; grid-template-columns:auto 1fr; gap:.45rem 1rem;
       font-size:.9rem; }
  dt { color:var(--tinta-media); white-space:nowrap; }
  dd { margin:0; text-align:right; font-variant-numeric:tabular-nums; }
  dl.totales { margin-top:1rem; padding-top:.85rem; border-top:1px solid var(--borde); }
  .total { font-weight:700; font-size:1.05rem; color:var(--tinta); }
  .direccion { margin:.9rem 0 0; padding:.8rem .9rem; background:var(--papel);
               border:1px solid var(--borde-suave); border-radius:10px;
               font-size:.9rem; line-height:1.5; }
  .nota { margin:.7rem 0 0; padding:.65rem .9rem; border-left:3px solid var(--acento);
          background:var(--acento-suave); border-radius:0 8px 8px 0;
          color:var(--tinta-media); font-style:italic; font-size:.88rem; }

  /* ── Avisos ─────────────────────────────────────────────────────── */
  .ok-box { border-color:var(--ok); background:var(--ok-suave); color:var(--ok); }
  p.ok-box, section.card p.err, details.card p.err, .aviso-hecho {
    padding:.7rem .9rem; border-radius:10px; margin:.85rem 0 0; font-size:.9rem; }
  section.card p.err, details.card p.err { background:var(--error-suave); color:var(--error); }
  .aviso-hecho { background:var(--ok-suave); color:var(--ok); }
  section.card form { margin-top:1rem; }
  section.card form + form { padding-top:1rem; border-top:1px solid var(--borde-suave); }
  section.card form .muted, section.card form p { margin:0; font-size:.88rem; }

  /* ── Lista de pendientes ────────────────────────────────────────── */
  .hoy { margin-bottom:1.6rem; }
  .hoy-cabeza { display:flex; align-items:center; gap:.6rem; margin-bottom:.75rem; }
  .hoy-cabeza h2 { margin:0; font-size:1.15rem; }
  .cuenta { background:var(--acento); color:#fff; border-radius:999px;
            min-width:1.6rem; height:1.6rem; padding:0 .5rem;
            display:inline-flex; align-items:center; justify-content:center;
            font-size:.82rem; font-weight:700; font-variant-numeric:tabular-nums; }
  .cuenta-cero { background:var(--ok-suave); color:var(--ok); font-weight:600; }
  .mas { margin-top:.7rem; }

  .tareas { list-style:none; margin:0; padding:0;
            display:flex; flex-direction:column; gap:.5rem; }
  .tarea { display:flex; align-items:center; gap:1rem;
           background:var(--tarjeta); border:1px solid var(--borde);
           border-left:4px solid var(--borde); border-radius:12px;
           padding:.8rem 1rem; box-shadow:var(--sombra); }
  /* El color va en una barrita al costado, no llenando la tarjeta entera:
     con cinco cosas pendientes, cinco bloques de color cansan la vista. */
  .tarea.t-alta  { border-left-color:var(--acento); }
  .tarea.t-media { border-left-color:var(--alerta-borde); }
  .tarea.t-baja  { border-left-color:var(--borde); }
  .tarea-texto { display:flex; flex-direction:column; gap:.15rem; min-width:0; flex:1; }
  .tarea-texto b { font-weight:600; font-size:.95rem; letter-spacing:-.01em; }
  .tarea-texto .muted { font-size:.82rem; overflow:hidden;
                        text-overflow:ellipsis; white-space:nowrap; }
  .tarea .linkbtn { flex:none; }

  /* ── Cifras ─────────────────────────────────────────────────────── */
  .cifras { display:flex; flex-wrap:wrap; gap:.4rem 2rem;
            padding:.9rem 1.15rem; margin-bottom:1.1rem;
            background:var(--tarjeta); border:1px solid var(--borde);
            border-radius:var(--radio); box-shadow:var(--sombra); }
  .cifras div { display:flex; align-items:baseline; gap:.4rem; }
  .cifras b { font-size:1.05rem; font-weight:650; letter-spacing:-.02em;
              font-variant-numeric:tabular-nums; }
  .cifras span { color:var(--tinta-media); font-size:.8rem; }

  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) .p-serio {
      background:#2b1d15; color:#e8a06f; border-color:#5c3a24; }
  }

  /* En pantalla chica el lateral se acuesta arriba y se desplaza solo: un
     menú fijo de 200px sobre 390 se come media pantalla. */
  @media (max-width:820px) {
    body.con-lateral { display:block; }
    .lateral { position:static; width:auto; height:auto; flex-direction:row;
               align-items:center; gap:.5rem; padding:.7rem .9rem;
               border-right:0; border-bottom:1px solid var(--borde); }
    .marca { padding:0 .5rem 0 0; flex:none; }
    .marca b { font-size:1rem; }
    .marca span { display:none; }
    /* Sólo corre el menú, no la barra entera: si corriera la barra, «Salir»
       quedaba fuera de la pantalla y había que arrastrar para encontrarlo. */
    .lateral ul { flex-direction:row; padding:0; flex:1; gap:.3rem; min-width:0;
                  overflow-x:auto; scrollbar-width:none; }
    .lateral ul::-webkit-scrollbar { display:none; }
    .lateral li { flex:none; }
    .lateral a:not(.marca) { white-space:nowrap; padding:.4rem .6rem; }
    .lateral i { display:none; }
    .salir { padding:0; flex:none; }
    .salir button { padding:.4rem .8rem; }

    /* El gráfico no se achica hasta ser ilegible: se corre. A 340px de ancho,
       doce meses en 720 de viewBox dejan las etiquetas en 5px. */
    /* direction:rtl arranca el corrimiento del lado derecho: en el celular
       lo primero que se ve son los meses recientes, que son los que importan,
       y se arrastra hacia atrás para ver el historial. El SVG vuelve a ltr
       para que las barras no se den vuelta. */
    figure.grafico { overflow-x:auto; direction:rtl; }
    figure.grafico svg { min-width:600px; direction:ltr; }
  }

  @media (max-width:640px) {
    main { padding:0 .9rem 3rem; }
    .card { padding:1.1rem 1.15rem; }
    details.card > summary { padding:1rem 1.15rem; }
    details.card > .cuerpo { padding:0 1.15rem 1.1rem; }
    /* En el celular el subtítulo de la sección plegada empuja el título a dos
       líneas y no aporta nada: el título ya dice qué es. */
    details.card > summary .resumen { display:none; }
    /* En el celular la fila de tarea se apila: el botón abajo y a lo ancho,
       que es donde cae el pulgar. */
    .tarea { flex-direction:column; align-items:stretch; gap:.6rem; }
    .tarea .linkbtn { text-align:center; }
    .cifras { gap:.5rem 1.4rem; }
    h1 { font-size:1.3rem; }
  }
</style>
</head>
<body class="${nav ? 'con-lateral' : ''}">${nav}<main>${body}</main></body>
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

function statusList(rows, diccionario = ORDER_STATUS_LABEL, labelKey = 'status') {
  if (!rows.length) return '<p class="empty">Sin datos.</p>';
  return `<div class="grid">${rows.map(row => `
    <div class="stat"><b>${escapeHtml(row.total ?? 0)}</b><span>${label(diccionario, row[labelKey])}</span></div>
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


// Los valores crudos vienen de los CHECK de migrations/ y están en inglés.
// El panel lo usa gente, no la base: se traducen. Lo que no esté en el
// diccionario se muestra tal cual, nunca en blanco.
const ORDER_STATUS_LABEL = {
  open: 'abierto', paid: 'pagado', cancelled: 'cancelado',
  expired: 'vencido', fulfilled: 'despachado',
};
const PAYMENT_STATUS_LABEL = {
  not_started: 'sin empezar', pending: 'pendiente', approved: 'aprobado',
  rejected: 'rechazado', refunded: 'devuelto', cancelled: 'cancelado',
};
const DELIVERY_LABEL = { pickup: 'retiro', shipping: 'envío' };
const WAITLIST_STATUS_LABEL = {
  waiting: 'esperando', notified: 'avisados', cancelled: 'cancelados',
  pending: 'pendientes', sent: 'enviados', failed: 'fallidos', skipped: 'omitidos',
};

function label(diccionario, valor) {
  const clave = String(valor ?? '').trim();
  return escapeHtml(diccionario[clave] || clave || '—');
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
  [NOTICE_EVENT_TYPE.pickup_ready]: 'Se le avisó que está listo para retirar',
  [NOTICE_EVENT_TYPE.shipping_today]: 'Se le avisó que el envío sale hoy',
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
function noticeCard(order, events, pickup, flash) {
  const sent = noticeStateFromEvents(events);

  const botones = NOTICE_KINDS.map(kind => {
    const blocked = noticeBlockedReason({ kind, order, pickup });
    // Un aviso que no corresponde a este tipo de entrega no se muestra en
    // gris: directamente no está. La ficha de un retiro no ofrece "sale hoy".
    if (blocked === 'Este pedido es un envío, no un retiro.'
      || blocked === 'Este pedido es un retiro en el local, no un envío.') return '';

    const estado = sent[kind];
    if (estado.status === 'sent') {
      return `<p class="aviso-hecho">${escapeHtml(NOTICE_LABEL[kind])}: ya se le avisó`
        + ` el ${shortDate(estado.at)}.</p>`;
    }

    const falta = blocked
      ? `<p class="muted">${escapeHtml(blocked)}`
        + (blocked.includes('Ajustes') ? ' <a href="/panel/ajustes">Cargarlos ahora</a>.' : '')
        + '</p>'
      : '';
    const fallo = estado.status === 'failed'
      ? `<p class="err">El intento anterior falló (${escapeHtml(estado.failureCode) || 'sin código'}). Podés reintentar.</p>`
      : '';

    return `<form method="POST" action="/panel/pedido/${encodeURIComponent(order.public_code)}/avisar">
      <input type="hidden" name="kind" value="${escapeHtml(kind)}">
      ${fallo}${falta}
      <button type="submit"${blocked ? ' disabled' : ''}>${escapeHtml(NOTICE_LABEL[kind])}</button>
    </form>`;
  }).join('');

  if (!botones) return '';

  return `
<section class="card">
  <h2>Avisarle al cliente</h2>
  <p class="muted">Se manda a ${escapeHtml(order.buyer_email) || '—'}. Cada aviso sale una sola vez.</p>
  ${flash ? `<p class="${flash.ok ? 'ok-box' : 'err'}">${escapeHtml(flash.message)}</p>` : ''}
  ${botones}
</section>`;
}

function orderPage(found, { pickup, flash = null } = {}) {
  const { order, items, events } = found;
  const units = items.reduce((total, item) => total + Number(item.quantity || 0), 0);
  const esRetiro = order.delivery_type === 'pickup';
  const pending = order.payment_status === 'approved' && !order.fulfilled_at;

  const body = `
<div class="topbar">
  <div>
    <a class="back" href="/panel">← Pedidos</a>
    <h1>${escapeHtml(order.public_code)}</h1>
    <p class="muted">${escapeHtml(order.buyer_name)} · ${escapeHtml(units)} libro${units === 1 ? '' : 's'} · ${shortDate(order.created_at)}</p>
  </div>
  <span class="tag ${pending ? 'alerta' : ''}">${pending ? 'Pagado sin despachar' : label(ORDER_STATUS_LABEL, order.status)}</span>
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
  <h2>${esRetiro ? 'Retira en el local' : 'A dónde va'}</h2>
  <dl>
    <dt>Entrega</dt><dd>${esRetiro ? 'Retiro' : 'Envío'}</dd>
    <dt>Teléfono</dt><dd>${escapeHtml(order.buyer_phone)}</dd>
    <dt>Correo</dt><dd>${escapeHtml(order.buyer_email)}</dd>
    <dt>Fecha pedida</dt><dd>${deliveryWindow(order)}</dd>
  </dl>
  ${esRetiro ? '' : `<p class="direccion">${escapeHtml(order.address)}<br>${escapeHtml(order.locality)}, ${escapeHtml(order.department)}</p>`}
  ${cleanString(order.delivery_notes) ? `<p class="nota">“${escapeHtml(order.delivery_notes)}”</p>` : ''}
</section>

<section class="card">
  <h2>Pago</h2>
  <dl>
    <dt>Estado</dt><dd>${label(PAYMENT_STATUS_LABEL, order.payment_status)}</dd>
    <dt>Medio</dt><dd>${escapeHtml(order.payment_provider) || '—'}</dd>
    <dt>ID de pago</dt><dd>${escapeHtml(order.payment_id) || '—'}</dd>
    <dt>Cobrado</dt><dd>${shortDate(order.paid_at)}</dd>
    <dt>Despachado</dt><dd>${shortDate(order.fulfilled_at)}</dd>
  </dl>
</section>

${noticeCard(order, events, pickup, flash)}

<section class="card">
  <h2>Historial</h2>
  ${table(['Qué pasó', 'Cuándo'], events, row => `
    <tr><td>${escapeHtml(EVENT_LABEL[row.event_type] || row.event_type)}</td>
        <td>${shortDate(row.created_at)}</td></tr>`)}
</section>`;

  return layout(`Pedido ${order.public_code}`, body);
}


/**
 * Ajustes: los datos de retiro que el equipo carga y que despues salen en el
 * correo al cliente. Es la unica pantalla del panel que escribe, y escribe
 * solo estos cuatro campos en KV.
 */
function settingsPage(pickup, { saved = false, error = '' } = {}) {
  const falta = !pickupComplete(pickup);
  return layout('Ajustes - Amado Libros', `
<div class="topbar">
  <div>
    <a class="back" href="/panel">&larr; Pedidos</a>
    <h1>Ajustes</h1>
    <p class="muted">Lo que se escribe acá aparece en los correos que recibe el cliente.</p>
  </div>
</div>

${saved ? '<p class="card ok-box">Guardado.</p>' : ''}
${error ? `<p class="card err">No se pudo guardar: ${escapeHtml(error)}</p>` : ''}
${falta ? '<p class="card alert">Falta completar dirección, barrio u horarios. Hasta que estén, el aviso de retiro no se puede enviar.</p>' : ''}

<form class="card" method="POST" action="/panel/ajustes">
  <h2>Retiro en el local</h2>

  <label for="address">Dirección</label>
  <input id="address" name="address" type="text" maxlength="160" autocomplete="off"
         placeholder="Calle y número, apartamento o local" value="${escapeHtml(pickup.address)}">

  <label for="zone">Barrio y ciudad</label>
  <input id="zone" name="zone" type="text" maxlength="120" autocomplete="off"
         placeholder="Pocitos, Montevideo" value="${escapeHtml(pickup.zone)}">

  <label for="hours">Horarios</label>
  <textarea id="hours" name="hours" maxlength="240" rows="3"
            placeholder="Lunes a viernes de 10 a 18, sábados de 10 a 13">${escapeHtml(pickup.hours)}</textarea>

  <label for="holdDays">Días que se guarda el pedido</label>
  <input id="holdDays" name="holdDays" type="number" min="1" max="90" value="${escapeHtml(pickup.holdDays)}">
  <p class="muted">Se le dice al cliente en el correo de retiro.</p>

  <button type="submit">Guardar</button>
</form>`);
}

async function handleSettingsSave(context) {
  const { request } = context;
  // La cookie de sesión es SameSite=Strict, así que un POST desde otro sitio
  // ni siquiera la lleva. El origen se verifica igual, por las dudas.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    return new Response('Forbidden', { status: 403 });
  }

  const form = await request.formData();
  const result = await savePickup(context.env, {
    address: form.get('address'),
    zone: form.get('zone'),
    hours: form.get('hours'),
    holdDays: form.get('holdDays'),
  });

  return htmlResponse(settingsPage(result.pickup, {
    saved: result.ok,
    error: result.ok ? '' : result.error,
  }), { status: result.ok ? 200 : 500 });
}

/**
 * Una fila de trabajo: qué hay que hacer, sobre quién, y por dónde se hace.
 * Reemplaza a las cuatro tablas que había antes. Una tabla con encabezados
 * para mostrar dos filas es un informe; esto es una lista de cosas para hacer.
 */
function tarea({ urgencia = 'media', que, quien, detalle = '', enlace = null, accion = 'Abrir' }) {
  return `<li class="tarea t-${urgencia}">
    <div class="tarea-texto">
      <b>${que}</b>
      <span class="muted">${quien}${detalle ? ` · ${detalle}` : ''}</span>
    </div>
    ${enlace ? `<a class="linkbtn" href="${enlace}">${escapeHtml(accion)}</a>` : ''}
  </li>`;
}

/**
 * Todo lo que necesita que alguien haga algo, en un solo lugar y ordenado por
 * urgencia. Antes estaba repartido en cuatro tablas y una lista aparte, y
 * había que leerlas todas para saber si había algo pendiente.
 */
function tareasPendientes(data) {
  const filas = [];

  if (data.stuck?.ok) {
    const stuck = data.stuck.data;
    for (const row of stuck.paidNotFulfilled) {
      filas.push(tarea({
        urgencia: 'alta',
        que: `Despachar ${escapeHtml(row.public_code)}`,
        quien: escapeHtml(row.buyer_name),
        detalle: `${money(row.payable_total_uyu)} · pagado ${shortDate(row.paid_at)}`,
        enlace: `/panel/pedido/${encodeURIComponent(row.public_code)}`,
        accion: 'Ver pedido',
      }));
    }
    for (const row of stuck.waitlistRestocked) {
      filas.push(tarea({
        urgencia: 'alta',
        que: 'Avisar que llegó',
        quien: escapeHtml(row.product_title),
        detalle: `${escapeHtml(row.email)} · repuesto ${shortDate(row.restocked_at)}`,
      }));
    }
    for (const row of stuck.paymentHanging) {
      filas.push(tarea({
        urgencia: 'media',
        que: `Pago sin resolver · ${escapeHtml(row.public_code)}`,
        quien: escapeHtml(row.buyer_name),
        detalle: `${money(row.payable_total_uyu)} · desde ${shortDate(row.created_at)}`,
      }));
    }
    for (const row of stuck.notificationFailed) {
      filas.push(tarea({
        urgencia: 'media',
        que: 'Aviso interno que falló',
        quien: escapeHtml(row.product_title),
        detalle: label(WAITLIST_STATUS_LABEL, row.internal_notification_status),
      }));
    }
  }

  const missing = data.catalog?.ok ? (data.catalog.data.missingImage || { count: 0, items: [] }) : null;
  if (missing?.count) {
    for (const row of missing.items) {
      filas.push(tarea({
        urgencia: row.priority === 0 ? 'alta' : 'baja',
        que: 'Falta la foto',
        quien: escapeHtml(row.title),
        detalle: label({ active: 'activo', paused: 'pausado', closed: 'cerrado' }, row.status),
        enlace: row.id ? `https://www.amadolibros.com/libro/${escapeHtml(row.id)}` : null,
        accion: 'Ver ficha',
      }));
    }
  }

  return { filas, missing };
}

/** La píldora de estado. Color Y palabra: el color solo nunca alcanza. */
function pastilla(diccionario, valor, tono) {
  return `<span class="pastilla p-${tono}">${label(diccionario, valor)}</span>`;
}

function tonoPedido(status) {
  if (status === 'fulfilled') return 'bien';
  if (status === 'paid') return 'aviso';
  if (status === 'cancelled' || status === 'expired') return 'grave';
  return 'neutro';
}

function tonoPago(status) {
  if (status === 'approved') return 'bien';
  if (status === 'pending' || status === 'not_started') return 'aviso';
  if (status === 'rejected' || status === 'cancelled') return 'grave';
  if (status === 'refunded') return 'serio';
  return 'neutro';
}

function dashboardPage(data) {
  const env = data.environment;
  const { filas, missing } = tareasPendientes(data);
  const totalTareas = (data.stuck?.ok ? data.stuck.data.total : 0) + (missing?.count || 0);
  const rotas = [
    !data.stuck?.ok ? data.stuck?.error : null,
    !data.catalog?.ok ? data.catalog?.error : null,
  ].filter(Boolean);
  const pagadosSinDespachar = data.stuck?.ok ? data.stuck.data.paidNotFulfilled.length : null;

  return layout('Panel — Amado Libros', `
<header class="top">
  <div>
    <h1>Tablero</h1>
    <p class="muted">
      ${escapeHtml(env.appEnv)} ·
      checkout ${env.checkoutEnabled ? '<span class="ok">encendido</span>' : '<span class="err">apagado</span>'} ·
      D1 ${env.hasOrdersDb ? '<span class="ok">ok</span>' : '<span class="err">sin binding</span>'} ·
      ${shortDate(data.generatedAt)} UTC
    </p>
  </div>
  <a class="linkbtn" href="/panel/ajustes">Ajustes</a>
</header>

${sectionOrError(data.orders, orders => `
<section class="tarjetas">
  <article class="kpi">
    <span>Facturado · 30 días</span>
    <b>${money(orders.paidLast30.total_uyu)}</b>
    <small>${escapeHtml(orders.paidLast30.total ?? 0)} pedido${Number(orders.paidLast30.total) === 1 ? '' : 's'} cobrado${Number(orders.paidLast30.total) === 1 ? '' : 's'}</small>
  </article>
  <article class="kpi${pagadosSinDespachar ? ' kpi-alerta' : ''}">
    <span>Pagados sin despachar</span>
    <b>${escapeHtml(pagadosSinDespachar ?? '—')}</b>
    <small>${pagadosSinDespachar ? 'esperando que salgan' : 'nada esperando'}</small>
  </article>
  ${sectionOrError(data.catalog, catalog => `
  <article class="kpi">
    <span>Libros publicados</span>
    <b>${escapeHtml(catalog.feed.activeTotal)}</b>
    <small>${escapeHtml(catalog.withStock)} con stock</small>
  </article>
  <article class="kpi${catalog.missingImage?.count ? ' kpi-alerta' : ''}">
    <span>Fichas sin foto</span>
    <b>${escapeHtml(catalog.missingImage?.count ?? 0)}</b>
    <small>no salen en Google</small>
  </article>`)}
</section>`)}

<section class="card grafico" id="facturacion">
  <div class="card-cabeza">
    <h2>Facturación cobrada</h2>
    <span class="muted">últimos 12 meses</span>
  </div>
  ${sectionOrError(data.revenue, revenue => `
    ${revenueChart(revenue)}
    ${revenueTable(revenue)}
  `)}
</section>

<section class="hoy" id="pendientes">
  <div class="hoy-cabeza">
    <h2>Para hacer ahora</h2>
    ${totalTareas
      ? `<span class="cuenta">${escapeHtml(totalTareas)}</span>`
      : '<span class="cuenta cuenta-cero">al día</span>'}
  </div>
  ${rotas.map(mensaje => `<p class="err">No se pudo cargar: ${escapeHtml(mensaje)}</p>`).join('')}
  ${filas.length
    ? `<ul class="tareas">${filas.join('')}</ul>`
    : (rotas.length ? '' : '<p class="empty">Nada pendiente. Todo despachado y todas las fichas con foto. 👌</p>')}
  ${missing && missing.count > missing.items.length
    ? `<p class="muted mas">Y ${escapeHtml(missing.count - missing.items.length)} fichas sin foto más.
       Sin foto no salen en Google: es lo que Search Console reporta como «Falta el campo image».</p>`
    : ''}
</section>

${sectionOrError(data.orders, orders => `
<section class="card" id="pedidos">
  <div class="card-cabeza">
    <h2>Últimos pedidos</h2>
    <span class="muted">${escapeHtml(orders.recent.length)} más recientes</span>
  </div>
  ${table(['Pedido', 'Comprador', 'Entrega', 'Estado', 'Pago', 'Total', 'Creado'], orders.recent, row => `
    <tr><td><a href="/panel/pedido/${encodeURIComponent(row.public_code)}">${escapeHtml(row.public_code)}</a></td>
        <td>${escapeHtml(row.buyer_name)}</td>
        <td>${label(DELIVERY_LABEL, row.delivery_type)}</td>
        <td>${pastilla(ORDER_STATUS_LABEL, row.status, tonoPedido(row.status))}</td>
        <td>${pastilla(PAYMENT_STATUS_LABEL, row.payment_status, tonoPago(row.payment_status))}</td>
        <td>${money(row.payable_total_uyu)}</td>
        <td>${shortDay(row.created_at)}</td></tr>`)}
</section>`)}

<details class="card" id="catalogo">
  <summary>Catálogo y Google Shopping<span class="resumen">qué llega al feed</span></summary>
  <div class="cuerpo">
  ${sectionOrError(data.catalog, catalog => `
    <p class="muted">Catálogo generado: ${shortDate(catalog.generatedAt)}</p>
    <h3>Cuántos llegan a Google Shopping</h3>
    <div class="grid">
      <div class="stat"><b>${escapeHtml(catalog.feed.activeTotal)}</b><span>libros activos</span></div>
      <div class="stat"><b>${escapeHtml(catalog.feed.eligible)}</b><span>pasan la puerta comercial</span></div>
      <div class="stat ${catalog.feed.blocked ? 'alert' : ''}"><b>${escapeHtml(catalog.feed.blocked)}</b><span>quedan afuera</span></div>
      <div class="stat"><b>${escapeHtml(catalog.withoutIsbn)}</b><span>sin ISBN</span></div>
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
  </div>
</details>

<details class="card">
  <summary>Avisos de stock<span class="resumen">gente esperando reposición</span></summary>
  <div class="cuerpo">
  ${sectionOrError(data.waitlist, waitlist => `
    ${statusList(waitlist.byStatus, WAITLIST_STATUS_LABEL)}
    <h3>Libros más esperados</h3>
    ${table(['Libro', 'ID', 'Personas'], waitlist.topProducts, row => `
      <tr><td>${escapeHtml(row.product_title)}</td><td>${escapeHtml(row.product_id)}</td>
          <td>${escapeHtml(row.total)}</td></tr>`)}
  `)}
  </div>
</details>

<details class="card">
  <summary>Rastreo de Google<span class="resumen">Googlebot, no visitas</span></summary>
  <div class="cuerpo">
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
  </div>
</details>`, { nav: sidebar('tablero') });
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

  if (path === '/panel/ajustes') {
    if (!['GET', 'POST'].includes(request.method)) {
      return new Response('Method Not Allowed', { status: 405 });
    }
    if (!(await hasValidSession(request, await deriveSessionSecret(config.password)))) {
      return htmlResponse(loginPage({
        siteKey: cleanString(context.env?.STOCK_WAITLIST_TURNSTILE_SITE_KEY),
      }));
    }
    if (request.method === 'POST') return handleSettingsSave(context);
    return htmlResponse(settingsPage(await loadPickup(context.env)));
  }

  const pedido = /^\/panel\/pedido\/([^/]+)(\/avisar)?$/.exec(path);
  if (pedido) {
    const avisar = Boolean(pedido[2]);
    const metodo = avisar ? 'POST' : 'GET';
    if (request.method !== metodo) return new Response('Method Not Allowed', { status: 405 });
    if (!(await hasValidSession(request, await deriveSessionSecret(config.password)))) {
      return htmlResponse(loginPage({
        siteKey: cleanString(context.env?.STOCK_WAITLIST_TURNSTILE_SITE_KEY),
      }));
    }
    // La cookie es SameSite=Strict, así que un POST desde otro sitio ni la
    // lleva. El origen se verifica igual, por las dudas.
    if (avisar) {
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) return new Response('Forbidden', { status: 403 });
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

    const pickup = await loadPickup(context.env);
    if (!avisar) return htmlResponse(orderPage(found, { pickup }));

    const form = await request.formData();
    const flash = await sendNotice({
      sendTrackedEmail,
      db,
      env: context.env,
      order: found.order,
      kind: cleanString(form.get('kind')),
      pickup,
    });
    // Se recarga el pedido para que el historial y el estado de los botones
    // muestren el aviso que se acaba de mandar, no el de antes.
    const fresh = await loadOrder(db, found.order.public_code) || found;
    return htmlResponse(orderPage(fresh, { pickup, flash }), { status: flash.ok ? 200 : 422 });
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
