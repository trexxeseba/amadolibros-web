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
const shortDate = value => new Intl.DateTimeFormat('es-UY', { day: 'numeric', month: 'short', timeZone: 'America/Montevideo' }).format(new Date(`${value}T12:00:00Z`));
const adminLink = (view, days) => `/admin?view=${view}&days=${days}`;
function change(current, previous) {
  if (!Number.isFinite(previous)) return 'Comparación todavía sin informe';
  if (previous === 0) return `Antes: 0 · sin base para calcular un porcentaje`;
  const delta = (current - previous) / previous * 100;
  return `${delta > 0 ? '+' : ''}${n(Math.round(delta * 10) / 10)}% · antes ${n(previous)}`;
}
const comparisonCard = (title, current, previous) => card(title, current, change(current, previous));
function bars(rows, unit = 'sesiones') {
  if (!rows.length) return '<p class="empty">Sin registros en este informe.</p>';
  const max = Math.max(1, ...rows.map(r => r.count));
  return `<ol class="bars">${rows.map(r => `<li><div><span>${e(r.label)}</span><strong>${e(n(r.count))} <small>${e(unit)}</small></strong></div><div class="track" aria-hidden="true"><span style="width:${Math.max(0, r.count / max * 100)}%"></span></div></li>`).join('')}</ol>`;
}

function trendPanel(a) {
  if (!usable(a) || !a.detail) return '';
  const rows = a.detail.daily;
  const max = Math.max(1, ...rows.map(r => r.sessions));
  const previous = a.detail.previous;
  const peak = rows.reduce((best, r) => r.sessions > best.sessions ? r : best, rows[0]);
  return `<section class="panel"><div class="section-heading"><div><h2>Cómo se movieron las visitas</h2><p class="note">Sesiones por día · GA4 · Uruguay</p></div>${pill(`${rows.length} días completos`)}</div>
    <div class="daily-chart" role="img" aria-label="Visitas diarias. Valores exactos en el detalle debajo del gráfico."><div class="daily-axis"><span>${e(n(max))}</span><span>0</span></div><div class="daily-bars">${rows.map((r, i) => `<div class="daily-column"><div class="daily-space"><span class="daily-bar" style="height:${r.sessions / max * 100}%" title="${e(shortDate(r.date))}: ${e(n(r.sessions))} sesiones"></span></div><span class="daily-label">${rows.length === 7 || i % 5 === 0 || i === rows.length - 1 ? e(shortDate(r.date)) : ''}</span></div>`).join('')}</div></div>
    <p class="note">${peak.sessions > 0 ? `Mayor actividad: ${e(shortDate(peak.date))}, ${e(n(peak.sessions))} sesiones.` : 'GA4 no devolvió sesiones para estos días.'} Comparación: ${e(shortDate(previous.startDate))} a ${e(shortDate(previous.endDate))}.</p>
    ${rows.reduce((sum, r) => sum + r.sessions, 0) !== a.summary.sessions || rows.reduce((sum, r) => sum + r.views, 0) !== a.summary.views ? '<p class="notice">El detalle diario y el resumen del período difieren. Se muestran ambos tal como los informa GA4; no se sustituyen entre sí.</p>' : ''}<details><summary>Ver los valores diarios</summary>${table(['Día', 'Sesiones', 'Páginas vistas'], rows.map(r => [e(shortDate(r.date)), e(n(r.sessions)), e(n(r.views))]))}</details>${foot(a)}</section>`;
}

function attentionPanel(model) {
  const { analytics: a, orders, emails, sync, period } = model;
  const items = [];
  const add = (kind, title, text, action, view) => items.push({ kind, title, text, action, view });
  if (!usable(a)) add('warn', 'Visitas sin informe vigente', 'Falta un informe válido para el período elegido.', 'Ver las fuentes', 'estado');
  else if (a.status === 'stale') add('warn', 'Analytics necesita actualizarse', 'La extracción tiene más de 26 horas.', 'Ver la última actualización', 'estado');
  if (usable(a) && a.events.checkout_error > 0) add('warn', `${n(a.events.checkout_error)} incidencias de compra registradas`, 'Incluyen pedidos vencidos o intentos repetidos. Falta el desglose para separar fallas técnicas; son eventos, no clientes únicos.', 'Revisar compra y errores', 'compra');
  const failedEmails = emails?.rows?.filter(r => r.state === 'failed').reduce((sum, r) => sum + r.total, 0);
  if (usable(emails) && failedEmails > 0) add('error', `${n(failedEmails)} fallas de correo registradas`, 'Revisá los envíos de pedidos antes de dar por informado al cliente.', 'Revisar correos', 'compra');
  else if (!usable(emails) || !emails.rows.length) add('warn', 'Correos sin confirmación verificable', 'No hay información suficiente para confirmar el envío de pedidos.', 'Revisar el estado', 'estado');
  if (!usable(sync) || sync.status === 'stale') add('warn', 'Revisar actualización del catálogo', 'Una fecha antigua o una fuente caída requiere revisión; no confirma por sí sola que la sincronización esté trancada.', 'Ver actualización', 'estado');
  if (!usable(orders)) add('warn', 'Pedidos no disponibles', 'No se pudo consultar la fuente de pedidos.', 'Revisar pedidos', 'pedidos');
  else if (orders.summary.pending > 0) add('info', `${n(orders.summary.pending)} pedidos pendientes de pago`, 'Siguen abiertos y sin vencer. Es trabajo pendiente, no un error técnico.', 'Consultar pedidos', 'pedidos');
  return `<section class="panel attention"><div class="section-heading"><h2>Qué conviene revisar</h2>${pill(`${items.length} observaciones`, items.length ? 'warn' : '')}</div>${items.length ? `<div class="actions">${items.map(r => `<article class="action ${r.kind}"><div><strong>${e(r.title)}</strong><p>${e(r.text)}</p></div><a href="${adminLink(r.view, period.days)}">${e(r.action)} →</a></article>`).join('')}</div>` : '<p>No aparecen incidencias en las fuentes consultadas. Esto no descarta problemas que todavía no estén registrados.</p>'}</section>`;
}

function interestPanel(a, catalog) {
  if (!usable(a) || !a.detail) return '';
  const interest = catalog?.interest?.length ? catalog.interest : a.detail.products;
  return `<section class="panel"><h2>Fichas que despiertan interés</h2><p class="note">Las 15 URLs de producto más vistas en el período. Una vista no equivale a una compra. El stock corresponde al catálogo actual.</p>${table(['Ficha del producto', 'Vistas', 'Stock actual'], interest.map(r => [
    `<a class="product-link" href="https://www.amadolibros.com${e(r.path)}" target="_blank" rel="noopener noreferrer">${e(r.title || r.path)} ↗</a>`, e(n(r.views)), e(n(r.stock))]), 'GA4 no devolvió vistas de fichas de producto para este período.')}${foot(a)}</section>`;
}

function sourcesPanel(a) {
  return `<section class="panel"><h2>Actualidad de las visitas</h2>${usable(a) ? `${pill(a.status === 'stale' ? 'Revisar antigüedad' : 'Informe disponible', a.status === 'stale' ? 'warn' : '')}<p class="timestamp">${e(date(a.extractedAt))}</p><p>Esta es la fecha de extracción de Analytics. No es un contador de visitantes en este instante.</p>` : notice(a)}<p class="note">La actualización automática de Analytics está pendiente de activación. Recargar consulta el último informe guardado.</p>${foot(a)}</section>`;
}

function table(headers, rows, empty = 'No hay registros para este período.') {
  if (!rows.length) return `<p class="empty">${e(empty)}</p>`;
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="${e(headers.join(', '))}"><table><thead><tr>${headers.map(h => `<th scope="col">${e(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(v => `<td>${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function analyticsPanel(a) {
  if (!usable(a)) return `<section class="panel"><h2>Visitas a la web</h2>${notice(a)}<p>La conexión debe verificarse antes de mostrar cifras. La ausencia de datos no indica ausencia de visitas.</p>${foot(a)}</section>`;
  return `<div class="metrics">${comparisonCard('Visitas · sesiones', a.summary.sessions, a.detail?.previous.summary.sessions)}${comparisonCard('Visitantes medidos', a.summary.users, a.detail?.previous.summary.users)}${comparisonCard('Páginas vistas', a.summary.views, a.detail?.previous.summary.views)}</div>
    ${a.status === 'stale' ? '<p class="notice">El informe tiene más de 26 horas. Puede estar desactualizado.</p>' : ''}
    ${trendPanel(a)}<div class="columns"><section class="panel"><h2>De dónde llegan</h2>${bars(a.channels)}${foot(a)}</section>
    <section class="panel"><h2>Desde qué dispositivo</h2>${bars(a.devices.map(r => ({ label: label(r.label), count: r.count })))}${foot(a)}</section></div>
    <section class="panel"><h2>Páginas más vistas</h2>${table(['Página', 'Vistas'], a.pages.map(r => [e(r.label), e(n(r.count))]))}${foot(a)}</section>`;
}

function purchasePanel(a, emails) {
  const steps = [['view_item', 'Vieron un producto'], ['add_to_cart', 'Agregaron al carrito'],
    ['begin_checkout', 'Iniciaron la compra'], ['add_shipping_info', 'Informaron la entrega'],
    ['add_payment_info', 'Informaron el medio de pago'], ['purchase', 'Compra registrada']];
  return `<section class="panel"><h2>Actividad durante la compra</h2><p class="note">Eventos recibidos en cada paso. Una persona puede generar varios eventos.</p>
    ${usable(a) ? bars(steps.map(([key, text]) => ({ label: text, count: a.events[key] })), 'eventos') : notice(a)}
    <p class="note">Las barras comparan volúmenes de eventos. No permiten calcular cuántas personas abandonaron entre pasos.</p>
    <div class="callout"><strong>Errores de checkout registrados</strong><span>${e(n(a?.events?.checkout_error))}</span>
    <p>Estos eventos también incluyen pedidos vencidos e intentos repetidos. Falta el desglose por causa para separar fallas técnicas. Abandonar el carrito no confirma un bloqueo; GA4 no detecta todos los problemas.</p></div>${foot(a)}</section>
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

function healthPanel(health, coverage) {
  const messages = {
    catalog_unavailable: ['No se pudo acceder al catálogo', 'La comprobación de acceso al archivo falló. Revisar disponibilidad y respuesta del origen.'],
    meta_unavailable: ['No se pudo leer el estado del catálogo', 'Los metadatos no respondieron correctamente.'],
    sync_missing: ['Sin sincronización exitosa registrada', 'Falta una fecha de éxito verificable.'],
    sync_stale: ['Catálogo con actualización atrasada', 'Pasaron más de 26 horas desde el último éxito registrado.'],
    sync_error: ['El sincronizador registró una falla', 'Revisar su última ejecución para identificar la causa.'],
    sync_possibly_stuck: ['La sincronización podría haberse trancado', 'El último inicio supera 45 minutos y no tiene un éxito posterior. Es una señal para investigar.'],
    catalog_empty: ['El catálogo informa cero productos', 'Revisar contenido: una respuesta HTTP exitosa no garantiza un catálogo válido.'],
    kv_unavailable: ['No se pudo consultar el estado interno', 'La web informó que falta su conexión de diagnóstico.'],
    status_internal_error: ['Falló la comprobación de funcionamiento', 'El diagnóstico devolvió un error; no se puede confirmar la salud de la tienda.'],
    unknown_warning: ['La web informó una advertencia', 'Hay una señal que esta versión del panel todavía no puede clasificar.'],
  };
  const available = ['ok', 'degraded'].includes(health?.status);
  return `<section class="panel attention"><div class="section-heading"><h2>Problemas de la web</h2>${pill(!available ? 'Sin comprobación válida' : health.status === 'degraded' ? 'Requiere revisión' : 'Sin alertas en esta comprobación', health?.status === 'ok' ? '' : 'warn')}</div>
    ${available ? `<p class="note">Comprobado: ${e(date(health.checkedAt))} · estado actual, independiente del filtro de días.</p>${health.warnings.length ? `<div class="actions">${health.warnings.map(code => { const [title, text] = messages[code] || messages.unknown_warning; return `<article class="action"><div><strong>${e(title)}</strong><p>${e(text)}</p></div></article>`; }).join('')}</div>` : '<p>Las señales consultadas de catálogo y sincronización respondieron sin alertas.</p>'}${health.worker ? `<p class="note">Último inicio: ${e(date(health.worker.lastStarted))} · Último éxito: ${e(date(health.worker.lastOk))}${health.worker.inProgress ? ' · Hay una ejecución sin éxito posterior registrado.' : ''}</p>` : ''}` : notice(health)}
    <div class="callout"><strong>${usable(coverage) ? 'Fotos y navegación: controles externos conectados' : 'Fotos y banners: detección pendiente de conexión'}</strong><p>${usable(coverage) ? 'Consultá debajo la última ejecución y los avisos del recorrido con navegador. El resultado corresponde a las páginas e imágenes comprobadas.' : 'Una imagen puede fallar y ser reemplazada por el logo sin generar un aviso. Todavía falta verificar la conexión del monitor externo.'}</p></div>${foot(health)}</section>`;
}

export function coveragePanel(coverage) {
  if (!usable(coverage)) return `<section class="panel"><h2>Controles automáticos</h2>${notice(coverage)}</section>`;
  const names = { sync: 'Catálogo y sincronización', catalogo: 'Página del catálogo', portadas: 'Imágenes y navegación' };
  const states = { passed: 'Comprobación correcta', confirmed: 'Falla detectada', degraded: 'Respuesta lenta', stale: 'Control atrasado',
    paused: 'Control desactivado', unknown: 'Sin resultado verificable', monitor_error: 'Falló el monitor' };
  return `<section class="panel"><h2>Controles automáticos</h2>${table(['Control', 'Frecuencia', 'Última ejecución', 'Resultado'],
    coverage.rows.map(r => [e(names[r.component]), r.frequency === 120 ? 'Cada 2 horas' : 'Cada 10 minutos', e(date(r.checkedAt)),
      pill(states[r.state], r.state === 'passed' ? '' : 'warn')]))}${foot(coverage)}</section>`;
}

export function incidentPanel(incidents) {
  if (!usable(incidents)) return `<section class="panel"><h2>Avisos de los monitores</h2>${notice(incidents)}<p class="note">La vigilancia automática de fotos y navegación todavía no está activa.</p></section>`;
  const states = { confirmed: 'Falla confirmada por el monitor', degraded: 'Funcionamiento degradado', recovered: 'Recuperado en la comprobación' };
  return `<section class="panel"><h2>Avisos de los monitores</h2>${incidents.environment === 'preview' ? '<p class="notice">Pruebas de la integración. No son fallas observadas en la tienda productiva.</p>' : ''}
    ${table(['Componente', 'Página', 'Último aviso', 'Observado', 'Registros'], incidents.rows.map(r => [e(r.component), e(r.path),
      pill(states[r.state], r.state === 'recovered' ? '' : 'warn'), e(date(r.occurredAt)), e(n(r.events))]), 'Sin avisos registrados. Esto no confirma que la web esté sana.')}${foot(incidents)}</section>`;
}

function productsPanel(catalog, query, days) {
  const url = page => `/admin?view=productos&days=${days}&q=${encodeURIComponent(query)}&page=${page}`;
  return `<section class="panel"><h2>Catálogo de la web</h2><form class="search" action="/admin" method="get"><input type="hidden" name="view" value="productos"><input type="hidden" name="days" value="${days}"><label for="q">Título, autor, ISBN o identificador</label><div><input id="q" name="q" maxlength="120" value="${e(query)}" placeholder="Buscar un libro"><button>Buscar</button></div></form>
  ${usable(catalog) ? `<p>${e(n(catalog.matched))} resultados · ${e(n(catalog.total))} publicaciones en la fuente</p>${table(['Producto', 'Precio UYU', 'Stock', 'Estado'], catalog.rows.map(r => [
    `<strong>${e(r.title)}</strong><small>${e(r.author)} · ${e(r.id)}</small>${/^MLU\d+$/.test(r.id) ? `<a class="product-link" href="https://www.amadolibros.com/libro/${e(r.id)}" target="_blank" rel="noopener noreferrer">Abrir ficha ↗</a>` : ''}`, e(n(r.price)), e(n(r.stock)), pill(label(r.status), r.stock === 0 ? 'warn' : '')]))}
    <nav class="pagination" aria-label="Páginas de productos">${catalog.page > 0 ? `<a class="button" href="${e(url(catalog.page - 1))}">Anterior</a>` : ''}<span>Página ${catalog.pages ? catalog.page + 1 : 0} de ${catalog.pages}</span>${catalog.page + 1 < catalog.pages ? `<a class="button" href="${e(url(catalog.page + 1))}">Siguiente</a>` : ''}</nav>` : notice(catalog)}${foot(catalog)}</section>`;
}

export function renderAdminWeb(model) {
  const { view, period, analytics: a, orders, emails, sync, health, catalog, query = '', environment = 'preview' } = model;
  const views = [['resumen', 'Resumen'], ['visitas', 'Visitas'], ['compra', 'Compra y errores'], ['pedidos', 'Pedidos'], ['productos', 'Productos'], ['estado', 'Funcionamiento']];
  let content = '';
  if (view === 'visitas') content = analyticsPanel(a);
  else if (view === 'compra') content = purchasePanel(a, emails);
  else if (view === 'pedidos') content = `<div class="metrics">${card('Pedidos creados', orders?.summary?.total, 'Dentro del período seleccionado')}${card('Pago aprobado', orders?.summary?.approved, 'Estado actual')}${card('Pendientes de pago', orders?.summary?.pending, 'Abiertos y sin vencer')}${card('Pago rechazado', orders?.summary?.rejected, 'No equivale a un error técnico')}</div>` + ordersPanel(orders);
  else if (view === 'productos') content = interestPanel(a, catalog) + productsPanel(catalog, query, period.days);
  else if (view === 'estado') content = healthPanel(health, model.coverage) + coveragePanel(model.coverage) + incidentPanel(model.incidents) + `<div class="columns">${sourcesPanel(a)}${syncPanel(sync)}</div>` + emailPanel(emails);
  else {
    content = healthPanel(health, model.coverage) + coveragePanel(model.coverage) + incidentPanel(model.incidents) + `<div class="metrics">${comparisonCard('Visitas · sesiones', a?.summary?.sessions, a?.detail?.previous.summary.sessions)}${card('Pedidos creados', orders?.summary?.total, 'Pedidos de la web · período seleccionado')}${card('Con pago aprobado', orders?.summary?.approved, 'Estado actual de esos pedidos')}${card('Incidencias de checkout', a?.events?.checkout_error, 'Eventos GA4; falta distinguir la causa')}</div>
      ${trendPanel(a)}${attentionPanel(model)}<div class="columns">${syncPanel(sync)}<section class="panel"><h2>Pedidos pendientes</h2><p class="large-number">${e(n(orders?.summary?.pending))}</p><p>De los creados en el período, siguen abiertos, sin pago aprobado y sin vencer.</p><a href="${adminLink('pedidos', period.days)}">Consultar pedidos →</a>${foot(orders)}</section></div>${ordersPanel(orders)}`;
  }
  return `<!doctype html><html lang="es-UY"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>Amado · Control de la web</title><style>
  :root{font-family:Arial,Helvetica,sans-serif;color:#17212f;background:#f1f4f8;font-size:16px;line-height:1.5;color-scheme:light}*{box-sizing:border-box}body{margin:0}a{color:inherit}button,input{font:inherit}button,.button{background:#172d4a;color:white;border:0;border-radius:7px;padding:.6rem 1rem;text-decoration:none;cursor:pointer}button:hover,.button:hover{background:#284a73}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #b95b11;outline-offset:3px}.skip{position:absolute;left:1rem;top:-100px}.skip:focus{top:1rem;background:white;padding:1rem;z-index:10}.layout{display:grid;grid-template-columns:235px minmax(0,1fr);min-height:100vh}.sidebar{background:#122339;color:#e9eff7;padding:2rem 1.15rem}.brand{font-family:Georgia,serif;font-size:2.25rem;color:white;line-height:1.1;padding:0 .8rem 1.5rem;border-bottom:1px solid #38506d}.brand small{font:14px Arial,sans-serif;display:block;color:#b9c9de;margin-top:.6rem}.sidebar nav{margin-top:1.7rem;display:grid;gap:.35rem}.sidebar nav a{padding:.8rem;border-radius:7px;text-decoration:none;color:#d0dbea}.sidebar nav a[aria-current=page]{background:#294362;color:white;border-left:3px solid #fa9a76}.sidebar .mode{margin:2rem .8rem;color:#c2d1e2;font-size:14px}.sidebar .web-link{display:block;margin:1rem .8rem;font-size:14px}.main{padding:2rem 2.3rem 3rem;max-width:1500px;width:100%;margin:auto}header{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;margin-bottom:1.3rem}h1{font-size:1.8rem;line-height:1.2;margin:.25rem 0 .6rem;letter-spacing:-.04rem}h2{font-size:1.125rem;line-height:1.35;margin:0 0 1rem}p{margin:.65rem 0}small,.note,.source{font-size:14px;color:#526173}.eyebrow{font-size:14px;font-weight:bold;color:#465c76;letter-spacing:.05rem;margin:0}.period{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin-bottom:1.5rem}.period a{font-size:14px;background:white;border:1px solid #bdc9d6;border-radius:6px;padding:.45rem .8rem;text-decoration:none}.period a[aria-current=true]{background:#172d4a;color:white;border-color:#172d4a}.period .note{margin-left:.4rem}.pill{font-size:14px;display:inline-block;border-radius:5px;padding:.25rem .6rem;background:#e7edf4;color:#243c58;white-space:nowrap}.pill.warn{background:#fff0d7;color:#744307}.preview{background:#fff1e8;border-left:4px solid #bf5b1d;padding:.8rem 1rem;margin-bottom:1.3rem;font-size:14px}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem;margin-bottom:1.2rem}.metric{background:white;border:1px solid #dce3ec;border-radius:9px;padding:1.15rem}.metric p{font-size:14px;color:#465a71;margin:0 0 .7rem}.metric strong{font-size:1.8rem;display:block;line-height:1.2;margin-bottom:.6rem}.metric small{display:block}.columns{display:grid;grid-template-columns:1fr 1fr;gap:1.2rem}.panel{background:white;border:1px solid #dce3ec;border-radius:9px;padding:1.3rem;margin-bottom:1.2rem;min-width:0}.section-heading{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start}.attention{border-left:4px solid #b76523}.attention ul{padding-left:1.2rem;margin:.3rem 0 1rem}.attention li{margin:.5rem 0}.source{border-top:1px solid #e4eaf1;padding-top:.8rem;margin-top:1rem}.notice{background:#fff3df;border-radius:6px;padding:.8rem 1rem;color:#70440c}.empty{color:#526173;padding:1rem 0}.timestamp{font-size:1.3rem;font-weight:bold}.large-number{font-size:2.1rem;font-weight:bold;line-height:1.2}.callout{background:#f2f5f9;padding:1rem;border-radius:6px;margin-top:1rem}.callout span{font-size:1.65rem;font-weight:bold;display:block}.callout p{font-size:14px;color:#526173}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:14px}th{background:#f4f6f9;color:#465a71;text-align:left;padding:.7rem .8rem;font-weight:normal;white-space:nowrap}td{border-bottom:1px solid #e7ecf2;padding:.85rem .8rem;vertical-align:top}td small{display:block;font-size:13px;margin-top:.3rem}td strong{font-weight:600}.search label{display:block;font-size:14px;margin-bottom:.4rem}.search div{display:flex;gap:.5rem}.search input{padding:.6rem;border:1px solid #aebdcc;border-radius:6px;width:min(100%,500px);min-width:0}.pagination{display:flex;gap:1rem;justify-content:flex-end;align-items:center;margin-top:1rem;font-size:14px}footer{font-size:13px;color:#526173;margin-top:1.5rem}a.outside{font-size:14px;white-space:nowrap}.tab-title{margin-bottom:1.2rem}@media(min-width:1000px){.sidebar{position:sticky;top:0;height:100vh}}@media(max-width:1100px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.main{padding:1.5rem}}@media(max-width:750px){.layout{grid-template-columns:1fr}.sidebar{padding:1rem}.brand{font-size:1.65rem;padding:.2rem}.brand small{display:inline;margin-left:.5rem}.sidebar nav{display:flex;overflow:auto;margin-top:.8rem;gap:.4rem}.sidebar nav a{white-space:nowrap;font-size:14px;padding:.55rem}.sidebar .mode,.sidebar .web-link{display:none}.main{padding:1rem}.columns{grid-template-columns:1fr;gap:0}header{flex-wrap:wrap}h1{font-size:1.55rem}.panel{padding:1rem}.metric{padding:.9rem}.metric strong{font-size:1.45rem}.period .note{width:100%;margin-left:0}.section-heading{flex-wrap:wrap}}@media(prefers-reduced-motion:no-preference){a,button{transition:background .12s}}
  .bars{list-style:none;padding:0;margin:0;display:grid;gap:1.1rem}.bars li>div:first-child{display:flex;justify-content:space-between;gap:1rem;font-size:14px}.bars strong{white-space:nowrap}.track{height:8px;background:#edf1f6;border-radius:4px;margin-top:.4rem;overflow:hidden}.track span{display:block;height:100%;background:#466e9f;border-radius:4px}.daily-chart{display:flex;height:205px;margin:1.4rem 0 .6rem;gap:.6rem}.daily-axis{display:flex;flex-direction:column;justify-content:space-between;padding-bottom:30px;font-size:12px;color:#526173;min-width:24px}.daily-bars{display:flex;flex:1;gap:clamp(2px,.5vw,9px);min-width:0;border-bottom:1px solid #dce3ec}.daily-column{flex:1;min-width:0;display:flex;flex-direction:column}.daily-space{height:175px;display:flex;align-items:flex-end;background:repeating-linear-gradient(to top,transparent,transparent 42px,#edf1f6 42px,#edf1f6 43px)}.daily-bar{width:100%;background:#466e9f;border-radius:4px 4px 0 0;min-height:0}.daily-label{height:30px;padding-top:6px;text-align:center;font-size:11px;white-space:nowrap;color:#526173}.actions{display:grid;gap:.8rem}.action{border:1px solid #e0e6ed;border-left:4px solid #d39246;border-radius:7px;padding:1rem;display:flex;align-items:center;justify-content:space-between;gap:1.3rem}.action.error{border-left-color:#b44736}.action.info{border-left-color:#466e9f}.action p{font-size:14px;color:#526173;margin:.3rem 0 0}.action a{font-size:14px;font-weight:bold;min-width:130px}.product-link{color:#315b89;font-size:14px}details{margin:1rem 0}summary{cursor:pointer;color:#315b89;font-size:14px;font-weight:bold}details[open] summary{margin-bottom:1rem}.header-actions{display:flex;gap:.7rem;align-items:center;flex-wrap:wrap}.metrics:has(>.metric:nth-child(3):last-child){grid-template-columns:repeat(3,minmax(0,1fr))}@media(max-width:750px){.action{flex-direction:column;align-items:flex-start}.daily-label{font-size:9px}.metrics:has(>.metric:nth-child(3):last-child){grid-template-columns:1fr}.bars li>div:first-child{font-size:13px}}
  </style></head><body><a class="skip" href="#contenido">Ir al contenido</a><div class="layout"><aside class="sidebar"><div class="brand">Amado<small>Control de la web</small></div><nav aria-label="Administración">${views.map(([key, text]) => `<a href="/admin?view=${key}&days=${period.days}" ${view === key ? 'aria-current="page"' : ''}>${text}</a>`).join('')}</nav><p class="mode">Tu web, de un vistazo<br>Modo consulta</p><a class="web-link" href="https://www.amadolibros.com" target="_blank" rel="noopener noreferrer">Abrir la tienda ↗</a></aside>
  <main id="contenido" class="main"><header><div><p class="eyebrow">AMADOLIBROS.COM</p><h1>${e(views.find(([key]) => key === view)?.[1] || 'Resumen')}</h1><p class="note">${usable(a) ? `Analytics extraído ${e(date(a.extractedAt))}` : 'Datos de la web y estado de sus fuentes.'}</p></div><div class="header-actions">${pill(environment === 'production' ? 'Consulta privada' : 'Versión de revisión')}<a class="button" href="/admin?view=${e(view)}&days=${period.days}${view === 'productos' ? `&q=${encodeURIComponent(query)}&page=${model.page || 0}` : ''}">Recargar</a></div></header>
  ${environment !== 'production' ? `<div class="preview">${model.dataEnvironment === 'production' ? 'Versión de revisión con datos reales de la web. Sólo consulta.' : 'Versión de revisión. Pedidos de prueba o sin conectar; catálogo público de la web. No modifica la tienda.'}</div>` : ''}
  <div class="period" aria-label="Período de análisis"><a href="/admin?view=${e(view)}&days=7" aria-current="${period.days === 7}">7 días</a><a href="/admin?view=${e(view)}&days=30" aria-current="${period.days === 30}">30 días</a><span class="note">${e(period.startDate)} a ${e(period.endDate)} · Uruguay · hasta ayer</span></div>${content}<footer>Consulta: ${e(date(model.checkedAt))} · Cada fuente indica su alcance. Catálogo: estado actual. Pedidos y correos: registros creados en el período.</footer></main></div></body></html>`;
}
