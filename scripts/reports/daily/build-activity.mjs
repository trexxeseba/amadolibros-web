/**
 * «Qué pasó ayer en la web»: la primera parte del informe diario. Antes el
 * correo sólo decía si la web estaba sana; esto cuenta qué hizo la gente.
 *
 * Mismas reglas que el semanal: lo que falta dice «sin dato», con menos de 30
 * casos no hay porcentajes, y cada número va contra el mismo día de la semana
 * anterior (un martes contra un martes).
 */

import { fmtMoney, fmtNumber } from '../weekly/build-report.mjs';

const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const CHANNEL_LABEL = {
  'Organic Search': 'Google y otros buscadores',
  Direct: 'Directo (escribieron la dirección o un enlace guardado)',
  'Organic Social': 'Redes sociales',
  Referral: 'Otros sitios',
  'Paid Search': 'Anuncios en buscadores',
  'Paid Social': 'Anuncios en redes',
  'Organic Shopping': 'Google Shopping',
  Email: 'Correo',
  Unassigned: 'Sin identificar',
};

const DEVICE_LABEL = { mobile: 'Celular', desktop: 'Computadora', tablet: 'Tablet' };

const PROVIDER_LABEL = { mercadopago: 'Mercado Pago', bank_transfer: 'Transferencia' };
const STATUS_LABEL = { open: 'sin pagar', paid: 'pagado', expired: 'vencido', cancelled: 'cancelado', fulfilled: 'despachado' };

function dayLabel(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS[dow]} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}

function vs(current, previous) {
  if (current == null) return 'sin dato';
  if (previous == null) return fmtNumber(current);
  const diff = current - previous;
  return `${fmtNumber(current)} (${diff === 0 ? 'igual' : `${diff > 0 ? '+' : '−'}${fmtNumber(Math.abs(diff))}`})`;
}

function table(headers, rows) {
  if (!rows.length) return '';
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.map(cell => String(cell ?? '').replace(/\|/g, '/')).join(' | ')} |`),
  ].join('\n');
}

function rowsOf(value) {
  return Array.isArray(value) ? value : null;
}

function byKey(rows = [], key, metric) {
  return new Map((rows || []).map(row => [row[key], Number(row[metric] || 0)]));
}

function shortTitle(title) {
  return String(title || '')
    .replace(/\s*[|—–-]\s*Amado Libros.*$/i, '')
    .slice(0, 70) || '(sin título)';
}

function pageLabel(row) {
  const pathName = String(row.pagePath || '');
  if (pathName === '/') return 'Portada';
  if (pathName.startsWith('/catalogo')) return 'Catálogo';
  if (pathName.startsWith('/carrito')) return 'Carrito';
  if (pathName.startsWith('/pedido')) return 'Confirmación de pedido';
  return shortTitle(row.pageTitle) || pathName;
}

function event(ga4day, name) {
  const row = (ga4day?.events || []).find(r => r.eventName === name);
  return row ? Number(row.eventCount || 0) : 0;
}

function trafficBlock(ga4) {
  const y = ga4.yesterday;
  const w = ga4.lastWeek;
  const t = y.totals?.[0] || {};
  const p = w.totals?.[0] || {};
  return [
    `- Visitas: **${vs(Number(t.sessions || 0), Number(p.sessions || 0))}**`,
    `- Personas distintas: ${vs(Number(t.totalUsers || 0), Number(p.totalUsers || 0))}, de las cuales ${fmtNumber(Number(t.newUsers || 0))} llegaron por primera vez`,
    `- Páginas vistas: ${vs(Number(t.screenPageViews || 0), Number(p.screenPageViews || 0))}`,
  ].join('\n');
}

function whatTheySawBlock(ga4) {
  const y = ga4.yesterday;
  const lines = [];

  // Las páginas de un mismo tipo (catálogo con distintos filtros) se juntan.
  const pages = new Map();
  for (const row of y.pages || []) {
    const label = pageLabel(row);
    pages.set(label, (pages.get(label) || 0) + Number(row.screenPageViews || 0));
  }
  const topPages = [...pages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (topPages.length) lines.push('**Páginas más vistas**', '', table(['Página', 'Vistas'], topPages.map(([label, n]) => [label, n])));

  const items = (y.items || []).filter(r => Number(r.itemsViewed) > 0 || Number(r.itemsAddedToCart) > 0);
  if (items.length) {
    lines.push('', '**Libros que más miraron**', '',
      table(['Libro', 'Lo vieron', 'Al carrito'], items.slice(0, 10).map(r => [shortTitle(r.itemName), r.itemsViewed, r.itemsAddedToCart || 0])));
  }
  const landing = (y.landing || []).filter(r => r.landingPage && r.landingPage !== '(not set)').slice(0, 5);
  if (landing.length) {
    lines.push('', '**Por dónde entraron** (primera página de la visita)', '',
      table(['Página de entrada', 'Visitas'], landing.map(r => {
        const page = (y.pages || []).find(p => p.pagePath === r.landingPage);
        return [page ? pageLabel(page) : (r.landingPage === '/' ? 'Portada' : r.landingPage), r.sessions];
      })));
  }
  return lines.join('\n') || 'Sin páginas registradas.';
}

function originBlock(ga4) {
  const y = ga4.yesterday;
  const prevChannels = byKey(ga4.lastWeek.channels, 'sessionDefaultChannelGroup', 'sessions');
  const lines = [];
  const channels = (y.channels || []).slice(0, 6);
  if (channels.length) {
    lines.push(table(['De dónde', 'Visitas', 'Mismo día sem. anterior'],
      channels.map(r => [CHANNEL_LABEL[r.sessionDefaultChannelGroup] || r.sessionDefaultChannelGroup, r.sessions, prevChannels.get(r.sessionDefaultChannelGroup) ?? 0])));
  }
  const sources = (y.sources || []).filter(r => !['(direct)', '(not set)'].includes(r.sessionSource)).slice(0, 5);
  if (sources.length) lines.push('', `Sitios concretos: ${sources.map(r => `${r.sessionSource} (${r.sessions})`).join(', ')}`);
  const devices = (y.devices || []).map(r => `${DEVICE_LABEL[r.deviceCategory] || r.deviceCategory} ${r.sessions}`);
  if (devices.length) lines.push('', `Dispositivo: ${devices.join(' · ')}`);
  const cities = (y.cities || []).filter(r => r.city && r.city !== '(not set)').slice(0, 6).map(r => `${r.city} ${r.sessions}`);
  if (cities.length) lines.push('', `Ciudades: ${cities.join(' · ')}`);
  return lines.join('\n') || 'Sin datos de origen.';
}

function actionsBlock(ga4, d1) {
  const y = ga4 && !ga4.error ? ga4.yesterday : null;
  const w = ga4 && !ga4.error ? ga4.lastWeek : null;
  const ga = name => (y ? vs(event(y, name), event(w, name)) : 'sin dato');
  const lines = [
    `- Abrieron una ficha de libro: ${ga('view_item')}`,
    `- Agregaron al carrito: ${ga('add_to_cart')}`,
    `- Crearon un pedido: ${ga('begin_checkout')}`,
    `- Clics a WhatsApp: ${ga('whatsapp_click')}`,
    `- Enviaron «Pedir un libro»: ${ga('book_request_submitted')}`,
    y && event(y, 'checkout_error') ? `- Errores en el checkout: ${event(y, 'checkout_error')} ⚠️` : null,
  ];

  const waitlist = rowsOf(d1.waitlist);
  if (waitlist) {
    const titles = new Map();
    for (const row of waitlist) titles.set(row.product_title, (titles.get(row.product_title) || 0) + 1);
    lines.push(`- Pidieron aviso de stock: ${waitlist.length}${titles.size ? ` — ${[...titles.entries()].map(([t, n]) => `${shortTitle(t)}${n > 1 ? ` (${n})` : ''}`).join(', ')}` : ''}`);
  } else {
    lines.push('- Pedidos de aviso de stock: sin dato');
  }

  const misses = rowsOf(d1.search_misses);
  if (misses) {
    lines.push(misses.length
      ? `- Buscaron y no encontraron: ${misses.slice(0, 10).map(r => `«${r.query}»${Number(r.count) > 1 ? ` (${r.count})` : ''}`).join(', ')}`
      : '- Búsquedas sin resultados: ninguna');
  } else {
    lines.push('- Búsquedas sin resultados: sin dato');
  }
  return lines.filter(Boolean).join('\n');
}

function ordersBlock(d1, periods) {
  const orders = rowsOf(d1.orders);
  if (!orders) return `Sin dato (${String(d1.orders?.error || 'no se pudo consultar')}).`;
  if (!orders.length) return 'Ningún pedido nuevo ni pago ayer.';
  const items = rowsOf(d1.items) || [];
  const events = rowsOf(d1.events) || [];
  const day = periods.yesterday;
  const rows = orders.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map(order => {
    const books = items.filter(i => i.order_id === order.id)
      .map(i => `${Number(i.quantity) > 1 ? `${i.quantity}× ` : ''}${shortTitle(i.title)}`).join('; ');
    const evs = new Set(events.filter(e => e.order_id === order.id).map(e => e.event_type));
    const method = order.payment_provider
      ? PROVIDER_LABEL[order.payment_provider] || order.payment_provider
      : evs.has('transfer_payment_info_viewed') ? 'Transferencia (eligió)' : evs.has('preference_created') ? 'Mercado Pago (abrió)' : '—';
    let state = STATUS_LABEL[order.status] || order.status;
    if (order.payment_status === 'rejected' || evs.has('payment_rejected')) state += ', con rechazo';
    if (order.paid_at && order.paid_at >= day.startIso && order.paid_at < day.endIso && !(order.created_at >= day.startIso)) state += ' (pagó ayer)';
    const amount = order.paid_amount_uyu ?? order.payable_total_uyu;
    return [order.public_code, books || '—', fmtMoney(amount), method, `${state} · ${order.delivery_type === 'pickup' ? 'retiro' : `envío${order.department ? ` a ${order.department}` : ''}`}`];
  });
  const paid = orders.filter(o => o.payment_status === 'approved' && o.paid_at >= day.startIso && o.paid_at < day.endIso);
  const cobrado = paid.reduce((sum, o) => sum + Number(o.paid_amount_uyu ?? o.payable_total_uyu ?? 0), 0);
  return [
    `Pedidos creados: ${orders.filter(o => o.created_at >= day.startIso && o.created_at < day.endIso).length} · Pagados ayer: ${paid.length}${paid.length ? ` · Cobrado: ${fmtMoney(cobrado)}` : ''}`,
    '',
    table(['Pedido', 'Libros', 'Total', 'Pago', 'Estado'], rows),
  ].join('\n');
}

export function buildActivityReport({ periods, ga4, d1 = {} }) {
  const ga4Ok = ga4 && !ga4.error && ga4.yesterday && ga4.lastWeek;
  const reason = String(ga4?.error || 'no se pudo consultar').slice(0, 160);
  return [
    '# Amado Libros — informe diario',
    `Ayer, **${dayLabel(periods.yesterday.date)}**. Entre paréntesis, la diferencia con el ${dayLabel(periods.lastWeek.date)}.`,
    '## Visitas',
    ga4Ok ? trafficBlock(ga4) : `Sin dato de GA4 (${reason}).`,
    '## Qué miraron',
    ga4Ok ? whatTheySawBlock(ga4) : 'Sin dato de GA4.',
    '## De dónde vinieron',
    ga4Ok ? originBlock(ga4) : 'Sin dato de GA4.',
    '## Qué hicieron',
    actionsBlock(ga4Ok ? ga4 : null, d1),
    '## Pedidos de ayer',
    ordersBlock(d1, periods),
    '_GA4 cuenta lo que registra el navegador: quien usa bloqueador de anuncios no aparece. Los pedidos salen de la base y son la cifra real._',
  ].join('\n\n') + '\n';
}
