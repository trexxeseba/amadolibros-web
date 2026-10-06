/**
 * Informe semanal analítico de Amado Libros (INFORME-ANALITICO).
 *
 * Recibe lo que ya juntaron los pasos anteriores del workflow (D1, GA4 y
 * Search Console, cada uno con sus datos o con el motivo por el que faltan) y
 * arma el markdown que sale por correo. No sale a Internet: todo lo que hace
 * se puede probar con datos fijos.
 *
 * Reglas que este archivo no puede romper:
 * - Lo que no se midió dice «sin dato». Nada se rellena ni se estima hacia
 *   atrás: si una medición empezó a mitad de semana, se dice desde cuándo.
 * - Con menos de 30 casos no hay porcentajes: «4 de 9», no «44 %».
 * - Toda métrica va con la semana anterior al lado.
 * - Las tres acciones salen de reglas fijas (ACTION_RULES), en ese orden.
 */

export const MIN_CASES_FOR_PERCENT = 30;
export const PENDING_TRANSFER_HOURS = 48;

const PAYMENT_EVENTS = new Set([
  'payment_approved', 'payment_pending', 'payment_rejected', 'payment_cancelled', 'payment_refunded',
]);

// ── formato ─────────────────────────────────────────────────────────────────

const nf = new Intl.NumberFormat('es-UY');

export function fmtNumber(value) {
  return value == null ? 'sin dato' : nf.format(Math.round(Number(value) * 10) / 10);
}

export function fmtMoney(value) {
  return value == null ? 'sin dato' : `$ ${nf.format(Math.round(Number(value)))}`;
}

function signed(diff, fmt) {
  if (diff === 0) return 'igual';
  const text = fmt(Math.abs(diff));
  return diff > 0 ? `+${text}` : `−${text}`;
}

/** «12 (semana anterior: 9, +3)». `null` es «sin dato», nunca cero. */
export function compare(current, previous, fmt = fmtNumber) {
  if (current == null) return 'sin dato';
  if (previous == null) return `${fmt(current)} (semana anterior: sin dato)`;
  return `${fmt(current)} (semana anterior: ${fmt(previous)}, ${signed(current - previous, fmt)})`;
}

/** Proporción con la regla de los 30 casos. */
export function ratio(part, total) {
  if (part == null || total == null) return 'sin dato';
  if (total === 0) return `${part} de 0`;
  if (total < MIN_CASES_FOR_PERCENT) return `${part} de ${total}`;
  const pct = (part / total) * 100;
  return `${pct.toFixed(pct < 10 ? 1 : 0).replace('.', ',')} % (${nf.format(part)} de ${nf.format(total)})`;
}

function compareRatio(cur, prev) {
  const curText = ratio(cur?.part, cur?.total);
  if (curText === 'sin dato') return 'sin dato';
  return `${curText} (semana anterior: ${ratio(prev?.part, prev?.total)})`;
}

function table(headers, rows) {
  if (!rows.length) return '';
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.map(cell => String(cell ?? '').replace(/\|/g, '/')).join(' | ')} |`),
  ].join('\n');
}

function inWindow(iso, win) {
  return Boolean(iso) && iso >= win.startIso && iso < win.endIso;
}

function parsePayload(value) {
  if (!value) return {};
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

function shortDate(isoDate) {
  const [, m, d] = String(isoDate || '').split('-');
  return d && m ? `${d}/${m}` : String(isoDate || '');
}

// ── fuentes ─────────────────────────────────────────────────────────────────

/** Una fuente sirve si trae filas; si no, su motivo. */
function source(input) {
  if (Array.isArray(input)) return { ok: true, rows: input };
  if (input && Array.isArray(input.rows)) return { ok: true, rows: input.rows };
  return { ok: false, reason: String(input?.error || 'no se pudo consultar').slice(0, 160) };
}

/**
 * Desde cuándo existe cada medición nueva (paid_amount, motivos de rechazo,
 * transferencias confirmadas, búsquedas sin resultados, historial del sync).
 * Se toma del primer resumen de sync guardado: todo eso salió en el mismo
 * despliegue. Sin ese dato, ninguna de esas mediciones cuenta como existente.
 */
function measuredSince(d1) {
  const first = source(d1.sync_first);
  const value = first.ok ? first.rows[0]?.first : null;
  return value ? String(value) : null;
}

function coverage(since, win) {
  if (!since || since >= win.endIso) return 'none';
  return since > win.startIso ? 'partial' : 'full';
}

function partialNote(since, win) {
  return coverage(since, win) === 'partial' ? ` _(medido desde el ${shortDate(since.slice(0, 10))})_` : '';
}

// ── bloques ─────────────────────────────────────────────────────────────────

function paidAmount(order) {
  if (order.paid_amount_uyu != null) return Number(order.paid_amount_uyu);
  // Mercado Pago cobra exactamente payable_total_uyu (el webhook lo valida
  // al centavo). Una transferencia vieja, sin monto anotado, queda sin dato.
  return order.payment_provider === 'bank_transfer' ? null : Number(order.payable_total_uyu);
}

function salesFor(orders, items, win) {
  const paid = orders.filter(o => o.payment_status === 'approved' && inWindow(o.paid_at, win));
  const amounts = paid.map(paidAmount);
  const revenue = amounts.some(a => a == null) ? null : amounts.reduce((sum, a) => sum + a, 0);
  const paidIds = new Set(paid.map(o => o.id));
  const units = items.filter(i => paidIds.has(i.order_id)).reduce((sum, i) => sum + Number(i.quantity || 0), 0);
  return {
    count: paid.length,
    revenue,
    ticket: paid.length && revenue != null ? revenue / paid.length : null,
    units,
    mp: paid.filter(o => o.payment_provider !== 'bank_transfer').length,
    transfer: paid.filter(o => o.payment_provider === 'bank_transfer').length,
    pickup: paid.filter(o => o.delivery_type === 'pickup').length,
    shipping: paid.filter(o => o.delivery_type === 'shipping').length,
    paid,
  };
}

function salesBlock({ d1, periods, since }) {
  const orders = source(d1.orders);
  const items = source(d1.items);
  if (!orders.ok) return `## Ventas\n\nSin dato: ${orders.reason}.`;
  const itemRows = items.ok ? items.rows : [];
  const cur = salesFor(orders.rows, itemRows, periods.current);
  const prev = salesFor(orders.rows, itemRows, periods.previous);
  const transferPrev = coverage(since, periods.previous) === 'none' ? null : prev.transfer;
  const transferCur = coverage(since, periods.current) === 'none' ? null : cur.transfer;

  const top = new Map();
  const curIds = new Set(cur.paid.map(o => o.id));
  for (const item of itemRows) {
    if (!curIds.has(item.order_id)) continue;
    const key = item.product_id || item.title;
    const entry = top.get(key) || { title: item.title, units: 0 };
    entry.units += Number(item.quantity || 0);
    top.set(key, entry);
  }
  const topRows = [...top.values()].sort((a, b) => b.units - a.units).slice(0, 5)
    .map(entry => [entry.title, entry.units]);

  return [
    '## Ventas',
    '',
    `- Pedidos pagados: **${compare(cur.count, prev.count)}**`,
    `- Cobrado: ${compare(cur.revenue, prev.revenue, fmtMoney)}`,
    `- Ticket promedio: ${compare(cur.ticket, prev.ticket, fmtMoney)}`,
    `- Libros vendidos: ${items.ok ? compare(cur.units, prev.units) : 'sin dato'}`,
    `- Por Mercado Pago: ${compare(cur.mp, prev.mp)}`,
    `- Por transferencia confirmada: ${compare(transferCur, transferPrev)}${partialNote(since, periods.current)}`,
    `- Retiro / envío: ${cur.pickup} / ${cur.shipping} (semana anterior: ${prev.pickup} / ${prev.shipping})`,
    topRows.length ? `\n**Más vendidos de la semana**\n\n${table(['Libro', 'Unidades'], topRows)}` : null,
  ].filter(line => line != null).join('\n');
}

function ga4Count(ga4, win, event, filter = () => true) {
  const rows = ga4?.[win]?.events;
  if (!Array.isArray(rows)) return null;
  return rows.filter(r => r.eventName === event && filter(r)).reduce((sum, r) => sum + Number(r.eventCount || 0), 0);
}

function ga4Sessions(ga4, win, key, value) {
  const rows = ga4?.[win]?.sessions;
  if (!Array.isArray(rows)) return null;
  return rows.filter(r => value == null || r[key] === value).reduce((sum, r) => sum + Number(r.sessions || 0), 0);
}

const FUNNEL_STEPS = [
  ['view_item', 'Vio una ficha'],
  ['add_to_cart', 'Agregó al carrito'],
  ['view_cart', 'Entró al checkout'],
  ['begin_checkout', 'Creó el pedido'],
  ['purchase', 'Pagó (Mercado Pago)'],
];

function funnelBlock({ ga4, d1, periods }) {
  const ga4Ok = ga4 && !ga4.error && ga4.current && ga4.previous;
  const orders = source(d1.orders);
  const lines = ['## Embudo', ''];

  const created = win => (orders.ok ? orders.rows.filter(o => inWindow(o.created_at, periods[win])).length : null);
  const paid = win => (orders.ok ? orders.rows.filter(o => o.payment_status === 'approved' && inWindow(o.paid_at, periods[win])).length : null);

  const rows = [];
  rows.push(['Sesiones (GA4)', ga4Ok ? fmtNumber(ga4Sessions(ga4, 'current', 'deviceCategory')) : 'sin dato',
    ga4Ok ? fmtNumber(ga4Sessions(ga4, 'previous', 'deviceCategory')) : 'sin dato']);
  for (const [event, label] of FUNNEL_STEPS) {
    rows.push([`${label} (GA4)`, ga4Ok ? fmtNumber(ga4Count(ga4, 'current', event)) : 'sin dato',
      ga4Ok ? fmtNumber(ga4Count(ga4, 'previous', event)) : 'sin dato']);
  }
  rows.push(['Pedidos creados (base)', fmtNumber(created('current')), fmtNumber(created('previous'))]);
  rows.push(['Pedidos pagados (base)', fmtNumber(paid('current')), fmtNumber(paid('previous'))]);
  lines.push(table(['Etapa', 'Esta semana', 'Semana anterior'], rows));

  if (!ga4Ok) {
    lines.push('', `GA4: sin dato (${String(ga4?.error || 'no se pudo consultar').slice(0, 160)}).`);
  } else {
    for (const [key, title] of [['deviceCategory', 'Por dispositivo'], ['sessionDefaultChannelGroup', 'Por origen']]) {
      const values = [...new Set((ga4.current.sessions || []).map(r => r[key]).filter(Boolean))];
      const byValue = values.map(value => {
        const count = event => ga4Count(ga4, 'current', event, r => r[key] === value);
        return {
          value,
          sessions: ga4Sessions(ga4, 'current', key, value),
          prevSessions: ga4Sessions(ga4, 'previous', key, value),
          steps: FUNNEL_STEPS.map(([event]) => count(event)),
        };
      }).sort((a, b) => b.sessions - a.sessions);
      lines.push('', `**${title}** (esta semana; sesiones con la anterior al lado)`, '',
        table(['', 'Sesiones', 'Ficha', 'Carrito', 'Checkout', 'Pedido', 'Pago MP'],
          byValue.map(v => [v.value, `${fmtNumber(v.sessions)} (${fmtNumber(v.prevSessions)})`, ...v.steps.map(fmtNumber)])));
    }
  }
  lines.push('', '_GA4 cuenta eventos del navegador: los bloqueadores los recortan y las transferencias no envían «pago». La base de pedidos es la cifra real._');
  return lines.join('\n');
}

function paymentsFor(orders, eventsByOrder, win, now) {
  const mp = { attempts: 0, approved: 0, rejected: 0, pending: 0, abandoned: 0, inProgress: 0, reasons: new Map(), reasonUnknown: 0 };
  const transfer = { chosen: 0, confirmed: 0 };
  for (const order of orders) {
    const events = eventsByOrder.get(order.id) || [];
    const pref = events.find(e => e.event_type === 'preference_created');
    if (pref && inWindow(pref.created_at, win)) {
      mp.attempts += 1;
      const rejected = events.filter(e => e.event_type === 'payment_rejected');
      const hasPayment = events.some(e => PAYMENT_EVENTS.has(e.event_type));
      if (order.payment_status === 'approved' && order.payment_provider !== 'bank_transfer') mp.approved += 1;
      else if (rejected.length) {
        mp.rejected += 1;
        for (const event of rejected) {
          const detail = parsePayload(event.payload_json).status_detail;
          if (detail) mp.reasons.set(detail, (mp.reasons.get(detail) || 0) + 1);
          else mp.reasonUnknown += 1;
        }
      } else if (order.payment_status === 'pending') mp.pending += 1;
      else if (!hasPayment && order.expires_at && order.expires_at < now.toISOString()) mp.abandoned += 1;
      else mp.inProgress += 1;
    }
    if (events.some(e => e.event_type === 'transfer_payment_info_viewed' && inWindow(e.created_at, win))) transfer.chosen += 1;
    if (events.some(e => e.event_type === 'transfer_confirmed' && inWindow(e.created_at, win))) transfer.confirmed += 1;
  }
  return { mp, transfer };
}

export function pendingTransfers(orders, eventsByOrder, now) {
  const limit = now.getTime() - PENDING_TRANSFER_HOURS * 60 * 60 * 1000;
  return orders.flatMap(order => {
    const viewed = (eventsByOrder.get(order.id) || []).find(e => e.event_type === 'transfer_payment_info_viewed');
    if (!viewed || order.payment_status === 'approved' || order.status === 'cancelled') return [];
    if (new Date(viewed.created_at).getTime() > limit) return [];
    const payload = parsePayload(viewed.payload_json);
    return [{
      code: order.public_code,
      amount: payload.transfer_total_uyu ?? null,
      days: Math.floor((now.getTime() - new Date(viewed.created_at).getTime()) / (24 * 60 * 60 * 1000)),
    }];
  }).sort((a, b) => b.days - a.days);
}

function groupEvents(events) {
  const map = new Map();
  for (const event of events) {
    if (!map.has(event.order_id)) map.set(event.order_id, []);
    map.get(event.order_id).push(event);
  }
  return map;
}

function paymentsBlock({ d1, periods, since, now }) {
  const orders = source(d1.orders);
  const events = source(d1.events);
  if (!orders.ok || !events.ok) return `## Pagos\n\nSin dato: ${(orders.ok ? events : orders).reason}.`;
  const byOrder = groupEvents(events.rows);
  const cur = paymentsFor(orders.rows, byOrder, periods.current, now);
  const prev = paymentsFor(orders.rows, byOrder, periods.previous, now);
  const confirmedPrev = coverage(since, periods.previous) === 'none' ? null : prev.transfer.confirmed;
  const confirmedCur = coverage(since, periods.current) === 'none' ? null : cur.transfer.confirmed;
  const pending = pendingTransfers(orders.rows, byOrder, now);

  const reasons = [...cur.mp.reasons.entries()].sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `${code} (${n})`);
  if (cur.mp.reasonUnknown) reasons.push(`sin dato (${cur.mp.reasonUnknown})`);

  return [
    '## Pagos',
    '',
    '**Mercado Pago** (pedidos que abrieron el pago esta semana)',
    '',
    `- Intentos: ${compare(cur.mp.attempts, prev.mp.attempts)}`,
    `- Aprobados: ${compareRatio({ part: cur.mp.approved, total: cur.mp.attempts }, { part: prev.mp.approved, total: prev.mp.attempts })}`,
    `- Rechazados: ${compare(cur.mp.rejected, prev.mp.rejected)}${reasons.length ? ` — motivos por intento: ${reasons.join(', ')}` : ''}`,
    `- Abandonados (abrió el pago, no pagó y venció): ${compare(cur.mp.abandoned, prev.mp.abandoned)}`,
    cur.mp.pending || cur.mp.inProgress ? `- Pendientes o en curso: ${cur.mp.pending + cur.mp.inProgress}` : null,
    '',
    '**Transferencia**',
    '',
    `- Eligieron transferencia: ${compare(cur.transfer.chosen, prev.transfer.chosen)}`,
    `- Confirmadas en el panel: ${compare(confirmedCur, confirmedPrev)}${partialNote(since, periods.current)}`,
    `- Pendientes hace más de ${PENDING_TRANSFER_HOURS} h (últimos 14 días): ${pending.length}`
      + (pending.length ? ` — ${pending.slice(0, 8).map(p => `${p.code} (${fmtMoney(p.amount)}, ${p.days} d)`).join(', ')}` : ''),
  ].filter(line => line != null).join('\n');
}

function waitlistFor(rows, win) {
  const created = rows.filter(r => inWindow(r.created_at, win));
  const byProduct = new Map();
  for (const row of created) {
    const entry = byProduct.get(row.product_id) || { title: row.product_title || row.product_id, count: 0 };
    entry.count += 1;
    byProduct.set(row.product_id, entry);
  }
  return {
    created: created.length,
    products: byProduct.size,
    notified: rows.filter(r => inWindow(r.notified_at, win)).length,
    top: [...byProduct.values()].sort((a, b) => b.count - a.count),
  };
}

function missesFor(rows, win) {
  const totals = new Map();
  for (const row of rows) {
    if (row.date < win.startDate || row.date > win.endDate) continue;
    totals.set(row.query, (totals.get(row.query) || 0) + Number(row.count || 0));
  }
  const list = [...totals.entries()].map(([query, count]) => ({ query, count })).sort((a, b) => b.count - a.count);
  return { searches: list.reduce((sum, r) => sum + r.count, 0), distinct: list.length, list };
}

function demandBlock({ d1, ga4, periods, since }) {
  const lines = ['## Demanda sin atender', ''];
  const waitlist = source(d1.waitlist);
  if (waitlist.ok) {
    const cur = waitlistFor(waitlist.rows, periods.current);
    const prev = waitlistFor(waitlist.rows, periods.previous);
    lines.push(
      `- Pedidos de aviso de stock: ${compare(cur.created, prev.created)}, de ${cur.products} ${cur.products === 1 ? 'libro distinto' : 'libros distintos'}`,
      `- Avisos de reposición enviados: ${compare(cur.notified, prev.notified)}`,
    );
    if (cur.top.length) {
      lines.push('', '**Más pedidos para avisar**', '', table(['Libro', 'Pedidos'], cur.top.slice(0, 5).map(r => [r.title, r.count])));
    }
  } else {
    lines.push(`- Avisos de stock: sin dato (${waitlist.reason}).`);
  }

  const misses = source(d1.search_misses);
  const covCur = coverage(since, periods.current);
  if (!misses.ok || covCur === 'none') {
    lines.push('', `- Búsquedas sin resultados: sin dato${misses.ok ? ' (todavía no se medía)' : ` (${misses.reason})`}.`);
  } else {
    const cur = missesFor(misses.rows, periods.current);
    const prev = coverage(since, periods.previous) === 'none' ? null : missesFor(misses.rows, periods.previous);
    lines.push('', `- Búsquedas sin resultados: ${compare(cur.searches, prev?.searches ?? null)}, ${cur.distinct} textos distintos${partialNote(since, periods.current)}`);
    if (cur.list.length) {
      lines.push('', table(['Búsqueda', 'Veces'], cur.list.slice(0, 10).map(r => [r.query, r.count])));
    }
  }

  const ga4Ok = ga4 && !ga4.error && ga4.current && ga4.previous;
  lines.push('',
    `- Clics a WhatsApp (GA4): ${ga4Ok ? compare(ga4Count(ga4, 'current', 'whatsapp_click'), ga4Count(ga4, 'previous', 'whatsapp_click')) : 'sin dato'}`,
    `- «Pedir un libro» enviados (GA4): ${ga4Ok ? compare(ga4Count(ga4, 'current', 'book_request_submitted'), ga4Count(ga4, 'previous', 'book_request_submitted')) : 'sin dato'}`);
  return lines.join('\n');
}

function gscTotals(rows) {
  const row = Array.isArray(rows) ? rows[0] : null;
  return row ? { clicks: Number(row.clicks || 0), impressions: Number(row.impressions || 0), position: Number(row.position || 0) } : null;
}

export function ctrOpportunities(pages = []) {
  return pages
    .filter(p => Number(p.impressions) >= 200 && Number(p.clicks) / Number(p.impressions) < 0.01 && Number(p.position) <= 10)
    .sort((a, b) => Number(b.impressions) - Number(a.impressions));
}

function movers(current = [], previous = [], key) {
  const prev = new Map(previous.map(r => [r[key], Number(r.clicks || 0)]));
  return current.map(r => ({ key: r[key], clicks: Number(r.clicks || 0), prev: prev.get(r[key]) ?? 0 }))
    .concat(previous.filter(r => !current.some(c => c[key] === r[key])).map(r => ({ key: r[key], clicks: 0, prev: Number(r.clicks || 0) })))
    .map(r => ({ ...r, diff: r.clicks - r.prev }));
}

function shortUrl(url) {
  return String(url || '').replace(/^https?:\/\/(www\.)?amadolibros\.com/, '') || '/';
}

function seoBlock({ gsc, periods }) {
  const lines = ['## SEO', ''];
  if (!gsc || gsc.error || !gsc.current || !gsc.previous) {
    lines.push(`- Google: sin dato (${String(gsc?.error || 'no se pudo consultar').slice(0, 160)}).`);
  } else {
    const cur = gscTotals(gsc.current.totals);
    const prev = gscTotals(gsc.previous.totals);
    lines.push(
      `_Search Console del ${shortDate(periods.gsc.current.startDate)} al ${shortDate(periods.gsc.current.endDate)} (publica con 2–3 días de atraso)._`,
      '',
      `- Clics: ${compare(cur?.clicks ?? null, prev?.clicks ?? null)}`,
      `- Impresiones: ${compare(cur?.impressions ?? null, prev?.impressions ?? null)}`,
      `- CTR: ${compareRatio(cur && { part: cur.clicks, total: cur.impressions }, prev && { part: prev.clicks, total: prev.impressions })}`,
      `- Posición media: ${compare(cur?.position ?? null, prev?.position ?? null)} (más bajo es mejor)`,
    );
    const pages = movers(gsc.current.pages, gsc.previous.pages, 'page');
    const up = pages.filter(p => p.diff > 0).sort((a, b) => b.diff - a.diff).slice(0, 5);
    const down = pages.filter(p => p.diff < 0).sort((a, b) => a.diff - b.diff).slice(0, 5);
    if (up.length) lines.push('', '**Páginas que más subieron en clics**', '', table(['Página', 'Clics', 'Antes'], up.map(p => [shortUrl(p.key), p.clicks, p.prev])));
    if (down.length) lines.push('', '**Páginas que más bajaron en clics**', '', table(['Página', 'Clics', 'Antes'], down.map(p => [shortUrl(p.key), p.clicks, p.prev])));
    const queries = movers(gsc.current.queries, gsc.previous.queries, 'query')
      .filter(q => q.clicks > 0).sort((a, b) => b.clicks - a.clicks).slice(0, 10);
    if (queries.length) lines.push('', '**Búsquedas que más trajeron**', '', table(['Búsqueda', 'Clics', 'Antes'], queries.map(q => [q.key, q.clicks, q.prev])));
  }
  lines.push('', '- Bing: sin dato (la consulta a Bing Webmaster está fallando por límite de IP; su arreglo no entra en este informe).');
  return lines.join('\n');
}

function catalogFor(rows, win) {
  const inside = rows.filter(r => inWindow(r.synced_at, win) && Number(r.baseline) === 1);
  if (!inside.length) return null;
  const sum = key => inside.reduce((total, r) => total + Number(r[key] || 0), 0);
  return {
    added: sum('added'), removed: sum('removed'), priceUp: sum('price_up'), priceDown: sum('price_down'),
    outOfStock: sum('out_of_stock'), backInStock: sum('back_in_stock'), runs: inside.length,
    samples: inside.flatMap(r => parsePayload(r.samples_json).price_changes || []),
  };
}

function catalogBlock({ d1, periods, since }) {
  const lines = ['## Catálogo', ''];
  const log = source(d1.sync_log);
  const latest = source(d1.sync_latest);
  const last = latest.ok ? latest.rows[0] : null;
  lines.push(last
    ? `- Hoy: ${fmtNumber(last.total_items)} publicaciones activas, ${fmtNumber(last.available_items)} con stock (sync del ${shortDate(String(last.synced_at).slice(0, 10))})`
    : '- Foto actual: sin dato.');
  if (!log.ok) {
    lines.push(`- Cambios de la semana: sin dato (${log.reason}).`);
    return lines.join('\n');
  }
  const cur = coverage(since, periods.current) === 'none' ? null : catalogFor(log.rows, periods.current);
  const prev = coverage(since, periods.previous) === 'none' ? null : catalogFor(log.rows, periods.previous);
  if (!cur) {
    lines.push('- Cambios de la semana: sin dato (todavía no se guardaba el historial del sync).');
    return lines.join('\n');
  }
  lines.push(
    `- Altas: ${compare(cur.added, prev?.added ?? null)}${partialNote(since, periods.current)}`,
    `- Bajas: ${compare(cur.removed, prev?.removed ?? null)}`,
    `- Subieron de precio: ${compare(cur.priceUp, prev?.priceUp ?? null)}`,
    `- Bajaron de precio: ${compare(cur.priceDown, prev?.priceDown ?? null)}`,
    `- Se quedaron sin stock: ${compare(cur.outOfStock, prev?.outOfStock ?? null)}`,
    `- Volvieron a tener stock: ${compare(cur.backInStock, prev?.backInStock ?? null)}`,
  );
  const biggest = cur.samples.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from)).slice(0, 5);
  if (biggest.length) {
    lines.push('', '**Cambios de precio más grandes**', '', table(['Libro', 'Antes', 'Ahora'], biggest.map(s => [s.title, fmtMoney(s.from), fmtMoney(s.to)])));
  }
  return lines.join('\n');
}

// ── acciones ────────────────────────────────────────────────────────────────

/**
 * Reglas fijas, en orden de prioridad. Cada una devuelve el texto de la
 * acción o null. Se toman las tres primeras que se cumplan.
 */
export const ACTION_RULES = [
  {
    id: 'transferencias-pendientes',
    rule: `Transferencia elegida hace más de ${PENDING_TRANSFER_HOURS} h sin confirmar`,
    run: ({ pending }) => (pending.length
      ? `Escribirle a ${pending.length === 1 ? 'quien hizo el pedido' : `quienes hicieron ${pending.length} pedidos`} por transferencia sin confirmar: ${pending.slice(0, 5).map(p => p.code).join(', ')}. Si ya pagaron, marcarlo en el panel.`
      : null),
  },
  {
    id: 'aviso-stock',
    rule: 'Libro con 2 o más pedidos de aviso de stock en la semana',
    run: ({ waitlistTop }) => {
      const hits = waitlistTop.filter(r => r.count >= 2);
      return hits.length
        ? `Reponer o conseguir: ${hits.slice(0, 3).map(r => `«${r.title}» (${r.count} pedidos)`).join(', ')}.`
        : null;
    },
  },
  {
    id: 'busqueda-sin-resultados',
    rule: 'Búsqueda sin resultados repetida 3 o más veces en la semana',
    run: ({ misses }) => {
      const hits = misses.filter(r => r.count >= 3);
      return hits.length
        ? `Cargar el libro o agregar un sinónimo para: ${hits.slice(0, 3).map(r => `«${r.query}» (${r.count})`).join(', ')}.`
        : null;
    },
  },
  {
    id: 'ctr-bajo',
    rule: 'Página con 200+ impresiones, CTR < 1 % y posición 10 o mejor',
    run: ({ ctr }) => (ctr.length
      ? `Mejorar título y descripción de ${ctr.slice(0, 3).map(p => `${shortUrl(p.page)} (${fmtNumber(p.impressions)} impresiones, posición ${fmtNumber(p.position)})`).join(', ')}.`
      : null),
  },
  {
    id: 'rechazos-mp',
    rule: '2 o más rechazos de Mercado Pago con el mismo motivo',
    run: ({ reasons }) => {
      const hit = [...reasons.entries()].sort((a, b) => b[1] - a[1]).find(([, n]) => n >= 2);
      return hit ? `Revisar rechazos de Mercado Pago por «${hit[0]}» (${hit[1]} esta semana).` : null;
    },
  },
];

function actionsBlock(context) {
  const actions = [];
  for (const rule of ACTION_RULES) {
    if (actions.length === 3) break;
    const text = rule.run(context);
    if (text) actions.push(`${actions.length + 1}. ${text} _(regla: ${rule.rule})_`);
  }
  return ['## Tres acciones para esta semana', '', actions.length ? actions.join('\n') : 'Ninguna regla se disparó esta semana.'].join('\n');
}

function actionContext({ d1, ga4: _ga4, gsc, periods, since, now }) {
  const orders = source(d1.orders);
  const events = source(d1.events);
  const byOrder = events.ok ? groupEvents(events.rows) : new Map();
  const waitlist = source(d1.waitlist);
  const misses = source(d1.search_misses);
  return {
    pending: orders.ok && events.ok ? pendingTransfers(orders.rows, byOrder, now) : [],
    waitlistTop: waitlist.ok ? waitlistFor(waitlist.rows, periods.current).top : [],
    misses: misses.ok && coverage(since, periods.current) !== 'none' ? missesFor(misses.rows, periods.current).list : [],
    ctr: gsc && !gsc.error && gsc.current ? ctrOpportunities(gsc.current.pages || []) : [],
    reasons: orders.ok && events.ok ? paymentsFor(orders.rows, byOrder, periods.current, now).mp.reasons : new Map(),
  };
}

// ── informe ─────────────────────────────────────────────────────────────────

function sourcesBlock({ d1, ga4, gsc, since }) {
  const d1Errors = Object.entries(d1).filter(([, value]) => !source(value).ok).map(([key]) => key);
  return [
    '## Fuentes',
    '',
    `- Base de pedidos (D1): ${d1Errors.length ? `con faltantes (${d1Errors.join(', ')})` : 'ok'}`,
    `- GA4: ${ga4 && !ga4.error ? 'ok' : `sin dato (${String(ga4?.error || 'no se pudo consultar').slice(0, 120)})`}`,
    `- Search Console: ${gsc && !gsc.error ? 'ok' : `sin dato (${String(gsc?.error || 'no se pudo consultar').slice(0, 120)})`}`,
    '- Bing Webmaster: sin dato',
    `- Mediciones nuevas (motivos de rechazo, transferencias confirmadas, búsquedas sin resultados, historial del catálogo): ${since ? `desde el ${shortDate(since.slice(0, 10))}` : 'todavía sin registros'}`,
    '',
    `_Con menos de ${MIN_CASES_FOR_PERCENT} casos se muestran números, no porcentajes. Lo que no se midió dice «sin dato»._`,
  ].join('\n');
}

export function buildWeeklyReport({ periods, d1 = {}, ga4 = null, gsc = null, now = new Date() }) {
  const since = measuredSince(d1);
  const context = { d1, ga4, gsc, periods, since, now };
  return [
    '# Amado Libros — informe semanal',
    `Semana del lunes ${shortDate(periods.current.startDate)} al domingo ${shortDate(periods.current.endDate)}, comparada con la del ${shortDate(periods.previous.startDate)} al ${shortDate(periods.previous.endDate)}.`,
    actionsBlock(actionContext(context)),
    salesBlock(context),
    funnelBlock(context),
    paymentsBlock(context),
    demandBlock(context),
    seoBlock(context),
    catalogBlock(context),
    sourcesBlock(context),
  ].join('\n\n') + '\n';
}
