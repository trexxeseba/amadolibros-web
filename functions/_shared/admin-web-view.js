export const escapeAdminHtml = value => String(value ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const e = escapeAdminHtml;
const n = value => Number.isFinite(value) ? new Intl.NumberFormat('es-UY').format(value) : 'Sin datos';
const date = value => value && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat('es-UY', { timeZone: 'America/Montevideo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : 'Sin datos';
const labels = { open: 'Abierto', paid: 'Pagado', cancelled: 'Cancelado', expired: 'Vencido', fulfilled: 'Entregado',
  not_started: 'Sin iniciar', pending: 'Pendiente', approved: 'Aprobado', rejected: 'Rechazado', refunded: 'Reembolsado',
  active: 'Activo', paused: 'Pausado', closed: 'Cerrado', sending: 'En proceso', sent: 'Aceptado por proveedor',
  failed: 'Falló el envío', unknown: 'Sin estado verificable', pickup: 'Retiro', shipping: 'Envío',
  mobile: 'Celular', desktop: 'Computadora', tablet: 'Tablet' };
const label = value => labels[value] || value || 'Sin datos';
const usable = source => source && ['ok', 'stale'].includes(source.status);
const notice = source => `<p class="notice">${e(source?.reason || 'Sin conectar')}</p>`;
const foot = source => `<p class="source">${e(source?.source || '')}${source?.extractedAt ? ` · Extraído ${e(date(source.extractedAt))}` : ''}</p><p class="note">${e(source?.note || '')}</p>`;
const pill = (text, kind = '') => `<span class="pill ${kind}">${e(text)}</span>`;
const card = (title, value, subtitle) => `<article class="metric"><p>${e(title)}</p><strong>${e(n(value))}</strong><small>${e(subtitle)}</small></article>`;

function table(headers, rows, empty = 'No hay registros para este período.') {
  if (!rows.length) return `<p class="empty">${e(empty)}</p>`;
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="${e(headers.join(', '))}"><table><thead><tr>${headers.map(h => `<th scope="col">${e(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(v => `<td>${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function analyticsPanel(a) {
  if (!usable(a)) return `<section class="panel"><h2>Visitas a la web</h2>${notice(a)}<p>La conexión debe verificarse antes de mostrar cifras. La ausencia de datos no indica ausencia de visitas.</p>${foot(a)}</section>`;
  return `<div class="metrics">${card('Visitas', a.summary.sessions, 'Sesiones registradas por GA4')}${card('Visitantes', a.summary.users, 'Usuarios medidos por GA4')}${card('Páginas vistas', a.summary.views, 'Visualizaciones registradas')}</div>
    ${a.status === 'stale' ? '<p class="notice">El informe tiene más de 26 horas. Puede estar desactualizado.</p>' : ''}
    <div class="columns"><section class="panel"><h2>De dónde llegan</h2>${table(['Canal', 'Sesiones'], a.channels.map(r => [e(r.label), e(n(r.count))]))}</section>
    <section class="panel"><h2>Desde qué dispositivo</h2>${table(['Dispositivo', 'Sesiones'], a.devices.map(r => [e(label(r.label)), e(n(r.count))]))}</section></div>
    <section class="panel"><h2>Páginas más vistas</h2>${table(['Página', 'Vistas'], a.pages.map(r => [e(r.label), e(n(r.count))]))}${foot(a)}</section>`;
}

function purchasePanel(a, emails) {
  const steps = [['view_item', 'Vieron un producto'], ['add_to_cart', 'Agregaron al carrito'],
    ['begin_checkout', 'Iniciaron la compra'], ['add_shipping_info', 'Informaron la entrega'],
    ['add_payment_info', 'Informaron el medio de pago'], ['purchase', 'Compra registrada']];
  return `<section class="panel"><h2>Actividad durante la compra</h2><p class="note">Eventos recibidos en cada paso. Una persona puede generar varios eventos.</p>
    ${usable(a) ? table(['Paso', 'Eventos'], steps.map(([key, text]) => [e(text), e(n(a.events[key]))])) : notice(a)}
    <div class="callout"><strong>Errores de checkout registrados</strong><span>${e(n(a?.events?.checkout_error))}</span>
    <p>Abandonar el carrito no confirma un bloqueo. Estos eventos señalan errores detectados por la instrumentación; no incluyen necesariamente todos los problemas.</p></div>${foot(a)}</section>
    ${emailPanel(emails)}`;
}

function emailPanel(emails) {
  return `<section class="panel"><h2>Correos de pedidos</h2>${usable(emails) ? table(['Estado actual', 'Registros'], emails.rows.map(r => [e(label(r.state)), e(n(r.total))]), 'Sin eventos registrados. No se puede confirmar el envío de correos.') : notice(emails)}${foot(emails)}</section>`;
}

function ordersPanel(orders) {
  return `<section class="panel"><h2>Pedidos de la web</h2>${usable(orders)
    ? table(['Pedido', 'Creado', 'Estado', 'Pago', 'Entrega'], orders.rows.map(r => [e(r.code), e(date(r.createdAt)), e(label(r.status)), e(label(r.paymentStatus)), e(label(r.delivery))]))
    : notice(orders)}${usable(orders) ? `<p class="note">Últimos ${e(n(orders.listed))} de ${e(n(orders.summary.total))} pedidos del período. Máximo 50.</p>` : ''}${foot(orders)}</section>`;
}

function syncPanel(sync) {
  return `<section class="panel"><h2>Actualización del catálogo</h2>${usable(sync)
    ? `${pill(sync.status === 'stale' ? 'Revisar actualización' : 'Actualización reciente', sync.status === 'stale' ? 'warn' : '')}<p class="timestamp">${e(date(sync.updatedAt))}</p><p>Hace ${e(n(Math.round(sync.ageHours * 10) / 10))} horas.</p>` : notice(sync)}${foot(sync)}</section>`;
}

function productsPanel(catalog, query, days) {
  const url = page => `/admin?view=productos&days=${days}&q=${encodeURIComponent(query)}&page=${page}`;
  return `<section class="panel"><h2>Catálogo de la web</h2><form class="search" action="/admin" method="get"><input type="hidden" name="view" value="productos"><input type="hidden" name="days" value="${days}"><label for="q">Título, autor, ISBN o identificador</label><div><input id="q" name="q" maxlength="120" value="${e(query)}" placeholder="Buscar un libro"><button>Buscar</button></div></form>
  ${usable(catalog) ? `<p>${e(n(catalog.matched))} resultados · ${e(n(catalog.total))} publicaciones en la fuente</p>${table(['Producto', 'Precio UYU', 'Stock', 'Estado'], catalog.rows.map(r => [
    `<strong>${e(r.title)}</strong><small>${e(r.author)} · ${e(r.id)}</small>`, e(n(r.price)), e(n(r.stock)), e(label(r.status))]))}
    <nav class="pagination" aria-label="Páginas de productos">${catalog.page > 0 ? `<a class="button" href="${e(url(catalog.page - 1))}">Anterior</a>` : ''}<span>Página ${catalog.pages ? catalog.page + 1 : 0} de ${catalog.pages}</span>${catalog.page + 1 < catalog.pages ? `<a class="button" href="${e(url(catalog.page + 1))}">Siguiente</a>` : ''}</nav>` : notice(catalog)}${foot(catalog)}</section>`;
}

export function renderAdminWeb(model) {
  const { view, period, analytics: a, orders, emails, sync, catalog, query = '', environment = 'preview' } = model;
  const views = [['resumen', 'Resumen'], ['visitas', 'Visitas'], ['compra', 'Compra y errores'], ['pedidos', 'Pedidos'], ['productos', 'Productos'], ['estado', 'Funcionamiento']];
  let content = '';
  if (view === 'visitas') content = analyticsPanel(a);
  else if (view === 'compra') content = purchasePanel(a, emails);
  else if (view === 'pedidos') content = ordersPanel(orders);
  else if (view === 'productos') content = productsPanel(catalog, query, period.days);
  else if (view === 'estado') content = syncPanel(sync) + emailPanel(emails);
  else {
    const alerts = [];
    if (!usable(a)) alerts.push('Visitas y recorrido de compra: falta conectar un informe válido.');
    else if (a.status === 'stale') alerts.push('Visitas: el informe está desactualizado.');
    if (a?.events?.checkout_error > 0) alerts.push(`${n(a.events.checkout_error)} eventos de error de checkout registrados.`);
    if (!usable(orders)) alerts.push('Pedidos: fuente no disponible.');
    if (!usable(sync) || sync.status === 'stale') alerts.push('Revisar la actualización del catálogo.');
    if (!usable(emails)) alerts.push('Correos: estado no disponible.');
    else if (!emails.rows.length) alerts.push('Correos: sin eventos de envío para verificar.');
    else if (emails.rows.some(r => r.state === 'failed' && r.total > 0)) alerts.push('Hay fallas registradas en correos de pedidos.');
    content = `<div class="metrics">${card('Visitas registradas', a?.summary?.sessions, 'GA4 · período seleccionado')}${card('Pedidos creados', orders?.summary?.total, 'Pedidos de la web · período seleccionado')}${card('Con pago aprobado', orders?.summary?.approved, 'Estado actual de esos pedidos')}${card('Errores de checkout', a?.events?.checkout_error, 'Eventos recibidos por GA4')}</div>
      <section class="panel attention"><div class="section-heading"><h2>Qué necesita atención</h2>${pill(`${alerts.length} observaciones`, alerts.length ? 'warn' : '')}</div>${alerts.length ? `<ul>${alerts.map(x => `<li>${e(x)}</li>`).join('')}</ul>` : '<p>No hay alertas en las fuentes consultadas. Esto no garantiza que no existan otros problemas.</p>'}<p class="note">${e(a?.note || 'Las visitas todavía no están verificadas en este panel.')}</p></section>
      <div class="columns">${syncPanel(sync)}<section class="panel"><h2>Pedidos pendientes</h2><p class="large-number">${e(n(orders?.summary?.pending))}</p><p>De los creados en el período, siguen abiertos, sin pago aprobado y sin vencer.</p>${foot(orders)}</section></div>${ordersPanel(orders)}`;
  }
  return `<!doctype html><html lang="es-UY"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>Amado · Control de la web</title><style>
  :root{font-family:Arial,Helvetica,sans-serif;color:#17212f;background:#f1f4f8;font-size:16px;line-height:1.5;color-scheme:light}*{box-sizing:border-box}body{margin:0}a{color:inherit}button,input{font:inherit}button,.button{background:#172d4a;color:white;border:0;border-radius:7px;padding:.6rem 1rem;text-decoration:none;cursor:pointer}button:hover,.button:hover{background:#284a73}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #b95b11;outline-offset:3px}.skip{position:absolute;left:1rem;top:-100px}.skip:focus{top:1rem;background:white;padding:1rem;z-index:10}.layout{display:grid;grid-template-columns:235px minmax(0,1fr);min-height:100vh}.sidebar{background:#122339;color:#e9eff7;padding:2rem 1.15rem}.brand{font-family:Georgia,serif;font-size:2.25rem;color:white;line-height:1.1;padding:0 .8rem 1.5rem;border-bottom:1px solid #38506d}.brand small{font:14px Arial,sans-serif;display:block;color:#b9c9de;margin-top:.6rem}.sidebar nav{margin-top:1.7rem;display:grid;gap:.35rem}.sidebar nav a{padding:.8rem;border-radius:7px;text-decoration:none;color:#d0dbea}.sidebar nav a[aria-current=page]{background:#294362;color:white;border-left:3px solid #fa9a76}.sidebar .mode{margin:2rem .8rem;color:#c2d1e2;font-size:14px}.sidebar .web-link{display:block;margin:1rem .8rem;font-size:14px}.main{padding:2rem 2.3rem 3rem;max-width:1500px;width:100%;margin:auto}header{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;margin-bottom:1.3rem}h1{font-size:1.8rem;line-height:1.2;margin:.25rem 0 .6rem;letter-spacing:-.04rem}h2{font-size:1.125rem;line-height:1.35;margin:0 0 1rem}p{margin:.65rem 0}small,.note,.source{font-size:14px;color:#526173}.eyebrow{font-size:14px;font-weight:bold;color:#465c76;letter-spacing:.05rem;margin:0}.period{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin-bottom:1.5rem}.period a{font-size:14px;background:white;border:1px solid #bdc9d6;border-radius:6px;padding:.45rem .8rem;text-decoration:none}.period a[aria-current=true]{background:#172d4a;color:white;border-color:#172d4a}.period .note{margin-left:.4rem}.pill{font-size:14px;display:inline-block;border-radius:5px;padding:.25rem .6rem;background:#e7edf4;color:#243c58;white-space:nowrap}.pill.warn{background:#fff0d7;color:#744307}.preview{background:#fff1e8;border-left:4px solid #bf5b1d;padding:.8rem 1rem;margin-bottom:1.3rem;font-size:14px}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem;margin-bottom:1.2rem}.metric{background:white;border:1px solid #dce3ec;border-radius:9px;padding:1.15rem}.metric p{font-size:14px;color:#465a71;margin:0 0 .7rem}.metric strong{font-size:1.8rem;display:block;line-height:1.2;margin-bottom:.6rem}.metric small{display:block}.columns{display:grid;grid-template-columns:1fr 1fr;gap:1.2rem}.panel{background:white;border:1px solid #dce3ec;border-radius:9px;padding:1.3rem;margin-bottom:1.2rem;min-width:0}.section-heading{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start}.attention{border-left:4px solid #b76523}.attention ul{padding-left:1.2rem;margin:.3rem 0 1rem}.attention li{margin:.5rem 0}.source{border-top:1px solid #e4eaf1;padding-top:.8rem;margin-top:1rem}.notice{background:#fff3df;border-radius:6px;padding:.8rem 1rem;color:#70440c}.empty{color:#526173;padding:1rem 0}.timestamp{font-size:1.3rem;font-weight:bold}.large-number{font-size:2.1rem;font-weight:bold;line-height:1.2}.callout{background:#f2f5f9;padding:1rem;border-radius:6px;margin-top:1rem}.callout span{font-size:1.65rem;font-weight:bold;display:block}.callout p{font-size:14px;color:#526173}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:14px}th{background:#f4f6f9;color:#465a71;text-align:left;padding:.7rem .8rem;font-weight:normal;white-space:nowrap}td{border-bottom:1px solid #e7ecf2;padding:.85rem .8rem;vertical-align:top}td small{display:block;font-size:13px;margin-top:.3rem}td strong{font-weight:600}.search label{display:block;font-size:14px;margin-bottom:.4rem}.search div{display:flex;gap:.5rem}.search input{padding:.6rem;border:1px solid #aebdcc;border-radius:6px;width:min(100%,500px);min-width:0}.pagination{display:flex;gap:1rem;justify-content:flex-end;align-items:center;margin-top:1rem;font-size:14px}footer{font-size:13px;color:#526173;margin-top:1.5rem}a.outside{font-size:14px;white-space:nowrap}.tab-title{margin-bottom:1.2rem}@media(min-width:1000px){.sidebar{position:sticky;top:0;height:100vh}}@media(max-width:1100px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.main{padding:1.5rem}}@media(max-width:750px){.layout{grid-template-columns:1fr}.sidebar{padding:1rem}.brand{font-size:1.65rem;padding:.2rem}.brand small{display:inline;margin-left:.5rem}.sidebar nav{display:flex;overflow:auto;margin-top:.8rem;gap:.4rem}.sidebar nav a{white-space:nowrap;font-size:14px;padding:.55rem}.sidebar .mode,.sidebar .web-link{display:none}.main{padding:1rem}.columns{grid-template-columns:1fr;gap:0}header{flex-wrap:wrap}h1{font-size:1.55rem}.panel{padding:1rem}.metric{padding:.9rem}.metric strong{font-size:1.45rem}.period .note{width:100%;margin-left:0}.section-heading{flex-wrap:wrap}}@media(prefers-reduced-motion:no-preference){a,button{transition:background .12s}}
  </style></head><body><a class="skip" href="#contenido">Ir al contenido</a><div class="layout"><aside class="sidebar"><div class="brand">Amado<small>Control de la web</small></div><nav aria-label="Administración">${views.map(([key, text]) => `<a href="/admin?view=${key}&days=${period.days}" ${view === key ? 'aria-current="page"' : ''}>${text}</a>`).join('')}</nav><p class="mode">Primera entrega<br>Modo consulta</p><a class="web-link" href="https://www.amadolibros.com" target="_blank" rel="noopener noreferrer">Abrir la tienda ↗</a></aside>
  <main id="contenido" class="main"><header><div><p class="eyebrow">AMADOLIBROS.COM</p><h1>${e(views.find(([key]) => key === view)?.[1] || 'Resumen')}</h1><p class="note">Datos de la web y estado de sus fuentes.</p></div>${pill(environment === 'production' ? 'Consulta privada' : 'Versión de revisión')}</header>
  ${environment !== 'production' ? '<div class="preview">Versión de revisión. Pedidos de prueba o sin conectar; catálogo público de la web. No modifica la tienda.</div>' : ''}
  <div class="period" aria-label="Período de análisis"><a href="/admin?view=${e(view)}&days=7" aria-current="${period.days === 7}">7 días</a><a href="/admin?view=${e(view)}&days=30" aria-current="${period.days === 30}">30 días</a><span class="note">${e(period.startDate)} a ${e(period.endDate)} · Uruguay · hasta ayer</span></div>${content}<footer>Consulta: ${e(date(model.checkedAt))} · Cada fuente indica su alcance. Catálogo: estado actual. Pedidos y correos: registros creados en el período.</footer></main></div></body></html>`;
}
