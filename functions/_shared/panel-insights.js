/**
 * functions/_shared/panel-insights.js
 *
 * PANEL-DATOS-1 — todo lo que ya vive en la D1 productiva y el tablero no
 * mostraba: ventas de Mercado Libre, qué se vende en la web y quién compra,
 * búsquedas que no encontraron nada, qué cambió en el catálogo, compras a
 * proveedores, rastreo por tipo de página y cuentas de clientes.
 *
 * Mismas reglas que panel-data.js:
 * - SOLO LECTURA. Ni un INSERT/UPDATE/DELETE: hay un test que lo verifica.
 * - Cada bloque se resuelve y falla por separado. Las tablas de ventas ML,
 *   compras y SBS las crea worker-sync cuando corre por primera vez; en un
 *   entorno donde nunca corrió no existen, y eso se dice como «sin datos
 *   todavía», no como un error ni como un cero.
 * - Todo lo que sale de D1 se escapa antes de entrar al HTML.
 *
 * Los estados de ML que cuentan como venta son los mismos que usa el motor de
 * reposición (COUNTED_STATUSES en worker-sync/ml-sales.js). Las líneas con
 * SKU AMADO-AR- son encargos a SBS; el resto, stock propio.
 */

import { COUNTED_STATUSES } from '../../worker-sync/ml-sales.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const COUNTED_SQL = COUNTED_STATUSES.map(s => `'${s}'`).join(',');
const ENCARGO_SQL = "COALESCE(i.seller_sku,'') LIKE 'AMADO-AR-%'";
const ML_WINDOWS = [7, 30, 90, 365];

// ───────────────────────────── utilidades ─────────────────────────────

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function entero(value) {
  return escapeHtml(Math.round(num(value)).toLocaleString('es-UY'));
}

function money(value) {
  return `$ ${entero(value)}`;
}

function pct(parte, total) {
  return total > 0 ? `${Math.round((parte / total) * 100)}%` : '—';
}

function dia(value) {
  const raw = String(value ?? '').trim();
  return raw ? escapeHtml(raw.slice(0, 10)) : '—';
}

function diaHora(value) {
  const raw = String(value ?? '').trim();
  return raw ? escapeHtml(raw.slice(0, 16).replace('T', ' ')) : '—';
}

function msToIso(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : '';
}

function mlLink(itemId, texto) {
  const id = String(itemId ?? '');
  if (!/^MLU\d+$/.test(id)) return escapeHtml(texto);
  return `<a href="https://articulo.mercadolibre.com.uy/MLU-${id.slice(3)}" target="_blank" rel="noopener noreferrer">${escapeHtml(texto)}</a>`;
}

async function all(db, sql, params = []) {
  const statement = db.prepare(sql);
  const bound = params.length ? statement.bind(...params) : statement;
  const { results } = await bound.all();
  return Array.isArray(results) ? results : [];
}

async function one(db, sql, params = []) {
  return (await all(db, sql, params))[0] || {};
}

/** Una tabla que todavía no existe no es un error: es que nunca se cargó. */
export function sinTabla(error) {
  return /no such table/i.test(String(error?.message || error || ''));
}

function table(headers, rows, renderRow, vacio = 'Sin datos todavía.') {
  if (!rows?.length) return `<p class="empty">${escapeHtml(vacio)}</p>`;
  return `<div class="scroll"><table>
    <thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(renderRow).join('')}</tbody>
  </table></div>`;
}

function stats(items) {
  return `<div class="grid">${items.map(({ valor, texto, alerta }) => `
    <div class="stat${alerta ? ' alert' : ''}"><b>${valor}</b><span>${escapeHtml(texto)}</span></div>`).join('')}</div>`;
}

/**
 * Barras horizontales en CSS puro: para rankings (qué se vende, qué se busca)
 * se lee mejor el largo de una barra que una columna de números.
 */
function barra(valor, maximo) {
  const ancho = maximo > 0 ? Math.max(2, Math.round((num(valor) / maximo) * 100)) : 0;
  return `<span class="barrita" aria-hidden="true"><i style="width:${ancho}%"></i></span>`;
}

/**
 * Columnas por día, en SVG. Mismo criterio que el gráfico de facturación:
 * barras porque son totales de períodos, una sola serie, detalle en tooltip.
 */
function columnasDiarias(dias, { campo, etiqueta, formato = entero }) {
  if (!dias.length) return '';
  const ancho = 720, alto = 120, abajo = 18, arriba = 16;
  const maximo = Math.max(1, ...dias.map(d => num(d[campo])));
  const paso = ancho / dias.length;
  const anchoBarra = Math.max(3, paso - 3);
  const util = alto - abajo - arriba;
  const barras = dias.map((d, i) => {
    const h = (num(d[campo]) / maximo) * util;
    const x = paso * i + (paso - anchoBarra) / 2;
    const titulo = `${d.day}: ${formato(d[campo]).replace(/&#39;/g, "'")} ${etiqueta}`;
    const marca = i === dias.length - 1 || (i % 7 === 0 && i < dias.length - 4);
    return `<g><rect class="blanco" x="${(paso * i).toFixed(1)}" y="0" width="${paso.toFixed(1)}" height="${alto - abajo}"><title>${titulo}</title></rect>
      ${h > 0 ? `<rect class="barra" x="${x.toFixed(1)}" y="${(arriba + util - h).toFixed(1)}" width="${anchoBarra.toFixed(1)}" height="${h.toFixed(1)}" rx="2"></rect>` : ''}
      ${marca ? `<text class="eje" x="${(paso * i + paso / 2).toFixed(1)}" y="${alto - 4}">${escapeHtml(String(d.day).slice(5))}</text>` : ''}</g>`;
  }).join('');
  return `<figure class="grafico"><svg viewBox="0 0 ${ancho} ${alto}" role="img" aria-label="${escapeHtml(etiqueta)} por día">
    <line class="base" x1="0" y1="${alto - abajo}" x2="${ancho}" y2="${alto - abajo}"></line>${barras}</svg></figure>`;
}

function diasSeguidos(rows, desdeMs, cantidad) {
  const porDia = new Map(rows.map(r => [String(r.day), r]));
  const out = [];
  for (let i = 0; i < cantidad; i++) {
    const day = new Date(desdeMs + i * DAY_MS).toISOString().slice(0, 10);
    out.push({ day, ...(porDia.get(day) || {}) });
  }
  return out;
}

// ───────────────────────────── Mercado Libre ─────────────────────────────

export async function loadMlSales(db, { now = Date.now() } = {}) {
  const ventanas = ML_WINDOWS.map(d => now - d * DAY_MS);
  const columnas = ML_WINDOWS.map((d, i) => `
      COUNT(DISTINCT CASE WHEN o.date_created_ms >= ${ventanas[i]} THEN o.order_id END) AS orders_${d},
      SUM(CASE WHEN o.date_created_ms >= ${ventanas[i]} THEN i.quantity ELSE 0 END) AS units_${d},
      SUM(CASE WHEN o.date_created_ms >= ${ventanas[i]} AND ${ENCARGO_SQL} THEN i.quantity ELSE 0 END) AS encargo_${d},
      SUM(CASE WHEN o.date_created_ms >= ${ventanas[i]} AND i.currency_id = 'UYU' THEN i.quantity * i.unit_price ELSE 0 END) AS uyu_${d}`).join(',');
  const desdeDiario = new Date(now - 29 * DAY_MS).toISOString().slice(0, 10);
  const desdeDiarioMs = Date.parse(`${desdeDiario}T00:00:00Z`);

  const [totales, porDia, top30, top365, ultimas, estado, sinIsbn, canceladas] = await Promise.all([
    one(db, `SELECT ${columnas}
       FROM ml_sales_items i JOIN ml_sales_orders o ON o.order_id = i.order_id
      WHERE o.status IN (${COUNTED_SQL}) AND o.date_created_ms >= ?`, [ventanas[ventanas.length - 1]]),
    all(db, `SELECT substr(o.date_created, 1, 10) AS day,
            COUNT(DISTINCT o.order_id) AS orders, SUM(i.quantity) AS units,
            SUM(CASE WHEN i.currency_id = 'UYU' THEN i.quantity * i.unit_price ELSE 0 END) AS uyu
       FROM ml_sales_items i JOIN ml_sales_orders o ON o.order_id = i.order_id
      WHERE o.status IN (${COUNTED_SQL}) AND o.date_created_ms >= ?
      GROUP BY day`, [desdeDiarioMs - DAY_MS]),
    ...[30, 365].map(d => all(db, `SELECT COALESCE(i.isbn, i.title_key, i.item_id) AS clave, MAX(i.isbn) AS isbn,
            MAX(i.title) AS title, MAX(i.item_id) AS item_id, SUM(i.quantity) AS units,
            SUM(CASE WHEN i.currency_id = 'UYU' THEN i.quantity * i.unit_price ELSE 0 END) AS uyu,
            COUNT(DISTINCT o.order_id) AS orders,
            SUM(CASE WHEN ${ENCARGO_SQL} THEN i.quantity ELSE 0 END) AS encargo,
            MAX(o.date_created) AS last_sale
       FROM ml_sales_items i JOIN ml_sales_orders o ON o.order_id = i.order_id
      WHERE o.status IN (${COUNTED_SQL}) AND o.date_created_ms >= ?
      GROUP BY clave ORDER BY units DESC, uyu DESC LIMIT 25`, [now - d * DAY_MS])),
    all(db, `SELECT o.date_created, o.status, i.title, i.item_id, i.isbn, i.quantity, i.unit_price, i.currency_id,
            CASE WHEN ${ENCARGO_SQL} THEN 1 ELSE 0 END AS encargo
       FROM ml_sales_items i JOIN ml_sales_orders o ON o.order_id = i.order_id
      ORDER BY o.date_created_ms DESC LIMIT 20`),
    all(db, 'SELECT name, updated_at FROM ml_sales_sync_state ORDER BY updated_at DESC'),
    one(db, `SELECT COUNT(*) AS lines, COALESCE(SUM(i.quantity), 0) AS units
       FROM ml_sales_items i JOIN ml_sales_orders o ON o.order_id = i.order_id
      WHERE i.isbn IS NULL AND o.status IN (${COUNTED_SQL}) AND o.date_created_ms >= ?`, [now - 90 * DAY_MS]),
    one(db, `SELECT COUNT(*) AS orders FROM ml_sales_orders WHERE status = 'cancelled' AND date_created_ms >= ?`,
      [now - 30 * DAY_MS]),
  ]);

  const windows = ML_WINDOWS.map(d => ({
    days: d,
    orders: num(totales[`orders_${d}`]),
    units: num(totales[`units_${d}`]),
    encargo: num(totales[`encargo_${d}`]),
    uyu: num(totales[`uyu_${d}`]),
  }));

  return {
    windows,
    daily: diasSeguidos(porDia, desdeDiarioMs, 30),
    top30,
    top365,
    recent: ultimas,
    syncUpdatedAt: msToIso(Math.max(0, ...estado.map(r => num(r.updated_at)))),
    withoutIsbn90: { lines: num(sinIsbn.lines), units: num(sinIsbn.units) },
    cancelled30: num(canceladas.orders),
  };
}

export function mlSalesSection(ml) {
  const w = Object.fromEntries(ml.windows.map(x => [x.days, x]));
  const ticket = w[30].orders ? w[30].uyu / w[30].orders : 0;
  const maxTop = Math.max(0, ...ml.top30.map(r => num(r.units)));
  const topTabla = (rows, max) => table(['Libro', 'Unid.', '', 'Ventas', 'Facturado', 'Encargo', 'Última'], rows, r => `
    <tr><td>${mlLink(r.item_id, r.title || r.isbn || '(sin título)')}${r.isbn ? `<br><small class="muted">${escapeHtml(r.isbn)}</small>` : ''}</td>
        <td><b>${entero(r.units)}</b></td><td class="col-barra">${barra(r.units, max)}</td>
        <td>${entero(r.orders)}</td><td>${money(r.uyu)}</td>
        <td>${num(r.encargo) ? entero(r.encargo) : '—'}</td><td>${dia(r.last_sale)}</td></tr>`);

  return `
  ${stats(ml.windows.map(x => ({
    valor: money(x.uyu),
    texto: `${x.days} días · ${x.units.toLocaleString('es-UY')} libros en ${x.orders.toLocaleString('es-UY')} ventas`,
  })))}
  ${stats([
    { valor: money(ticket), texto: 'ticket promedio (30 días)' },
    { valor: pct(w[30].units - w[30].encargo, w[30].units), texto: 'de stock propio (30 días)' },
    { valor: entero(w[30].encargo), texto: 'libros por encargo SBS (30 días)' },
    { valor: entero(ml.cancelled30), texto: 'ventas canceladas (30 días)', alerta: ml.cancelled30 > 0 },
  ])}
  <h3>Libros vendidos por día · últimos 30 días</h3>
  ${columnasDiarias(ml.daily, { campo: 'units', etiqueta: 'libros' })}
  <details class="tabla-datos"><summary>Ver los números por día</summary>
  ${table(['Día', 'Ventas', 'Libros', 'Facturado'], [...ml.daily].reverse(), d => `
    <tr><td>${dia(d.day)}</td><td>${entero(d.orders)}</td><td>${entero(d.units)}</td><td>${money(d.uyu)}</td></tr>`)}
  </details>
  <h3>Lo más vendido · 30 días</h3>
  ${topTabla(ml.top30, maxTop)}
  <details class="tabla-datos"><summary>Lo más vendido · últimos 12 meses</summary>
  ${topTabla(ml.top365, Math.max(0, ...ml.top365.map(r => num(r.units))))}
  </details>
  <h3>Últimas ventas</h3>
  ${table(['Fecha', 'Libro', 'Cant.', 'Precio', 'Estado'], ml.recent, r => `
    <tr><td>${diaHora(r.date_created)}</td>
        <td>${mlLink(r.item_id, r.title || '(sin título)')}${num(r.encargo) ? ' <span class="pastilla p-neutro">encargo</span>' : ''}</td>
        <td>${entero(r.quantity)}</td><td>${r.currency_id === 'UYU' ? money(r.unit_price) : `${escapeHtml(r.currency_id || '')} ${entero(r.unit_price)}`}</td>
        <td>${escapeHtml(ML_STATUS[r.status] || r.status || '—')}</td></tr>`)}
  <p class="muted">
    Sincronizado con Mercado Libre: ${diaHora(ml.syncUpdatedAt)} UTC.
    ${ml.withoutIsbn90.lines
      ? `${entero(ml.withoutIsbn90.units)} libros vendidos en 90 días no tienen ISBN identificado y el motor de reposición no los ve por ISBN.`
      : 'Todas las ventas de 90 días tienen ISBN.'}
    Cuentan como venta: pagadas y parcialmente pagadas o devueltas; las canceladas no suman.
  </p>`;
}

const ML_STATUS = {
  paid: 'pagada', partially_paid: 'pago parcial', partially_refunded: 'devolución parcial',
  cancelled: 'cancelada', confirmed: 'confirmada', payment_required: 'esperando pago',
  payment_in_process: 'pago en proceso', invalid: 'inválida',
};

// ───────────────────────────── Web: qué y quién ─────────────────────────────

export async function loadWebInsights(db, { now = Date.now() } = {}) {
  const hace365 = new Date(now - 365 * DAY_MS).toISOString();
  const hace30 = new Date(now - 30 * DAY_MS).toISOString();
  const [top, compradores, departamentos, entrega, embudo] = await Promise.all([
    all(db, `SELECT MAX(oi.title) AS title, oi.product_id, SUM(oi.quantity) AS units,
            SUM(oi.line_total_uyu) AS uyu, COUNT(DISTINCT o.id) AS orders
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.payment_status = 'approved' AND o.paid_at >= ?
      GROUP BY oi.product_id ORDER BY units DESC, uyu DESC LIMIT 20`, [hace365]),
    one(db, `SELECT COUNT(*) AS buyers, SUM(CASE WHEN n > 1 THEN 1 ELSE 0 END) AS repeat_buyers,
            SUM(n) AS orders, SUM(total) AS uyu
       FROM (SELECT lower(trim(buyer_email)) AS who, COUNT(*) AS n,
                    SUM(COALESCE(paid_amount_uyu, payable_total_uyu)) AS total
               FROM orders
              WHERE payment_status = 'approved' AND buyer_email IS NOT NULL AND trim(buyer_email) <> ''
              GROUP BY who)`),
    all(db, `SELECT COALESCE(NULLIF(trim(department), ''), '(sin departamento)') AS department,
            COUNT(*) AS orders, SUM(COALESCE(paid_amount_uyu, payable_total_uyu)) AS uyu
       FROM orders WHERE payment_status = 'approved' AND delivery_type = 'shipping'
      GROUP BY 1 ORDER BY orders DESC LIMIT 19`),
    all(db, `SELECT delivery_type, COUNT(*) AS orders FROM orders
      WHERE payment_status = 'approved' GROUP BY delivery_type`),
    one(db, `SELECT COUNT(*) AS created,
            SUM(CASE WHEN payment_status = 'approved' THEN 1 ELSE 0 END) AS paid,
            SUM(CASE WHEN status IN ('expired', 'cancelled') THEN 1 ELSE 0 END) AS lost,
            SUM(CASE WHEN payment_status = 'approved' THEN COALESCE(paid_amount_uyu, payable_total_uyu) ELSE 0 END) AS uyu
       FROM orders WHERE created_at >= ?`, [hace30]),
  ]);
  return { top, compradores, departamentos, entrega, embudo };
}

export function webInsightsSection(web) {
  const e = web.embudo;
  const c = web.compradores;
  const entrega = Object.fromEntries(web.entrega.map(r => [r.delivery_type, num(r.orders)]));
  const totalEntrega = num(entrega.pickup) + num(entrega.shipping);
  const max = Math.max(0, ...web.top.map(r => num(r.units)));
  return `
  ${stats([
    { valor: entero(e.created), texto: 'pedidos iniciados (30 días)' },
    { valor: pct(num(e.paid), num(e.created)), texto: 'terminan pagando (30 días)' },
    { valor: entero(e.lost), texto: 'vencidos o cancelados (30 días)', alerta: num(e.lost) > 0 },
    { valor: money(num(e.paid) ? num(e.uyu) / num(e.paid) : 0), texto: 'ticket promedio (30 días)' },
  ])}
  ${stats([
    { valor: entero(c.buyers), texto: 'compradores distintos (histórico)' },
    { valor: entero(c.repeat_buyers), texto: `volvieron a comprar (${pct(num(c.repeat_buyers), num(c.buyers))})` },
    { valor: pct(num(entrega.pickup), totalEntrega), texto: 'retiran en el local' },
    { valor: pct(num(entrega.shipping), totalEntrega), texto: 'piden envío' },
  ])}
  <h3>Lo más vendido en la web · 12 meses</h3>
  ${table(['Libro', 'Unid.', '', 'Pedidos', 'Facturado'], web.top, r => `
    <tr><td>${r.product_id ? `<a href="/libro/${encodeURIComponent(r.product_id)}">${escapeHtml(r.title || r.product_id)}</a>` : escapeHtml(r.title)}</td>
        <td><b>${entero(r.units)}</b></td><td class="col-barra">${barra(r.units, max)}</td>
        <td>${entero(r.orders)}</td><td>${money(r.uyu)}</td></tr>`, 'Todavía no hay ventas cobradas en la web.')}
  <h3>A dónde se envía</h3>
  ${table(['Departamento', 'Pedidos', 'Facturado'], web.departamentos, r => `
    <tr><td>${escapeHtml(r.department)}</td><td>${entero(r.orders)}</td><td>${money(r.uyu)}</td></tr>`, 'Todavía no hay envíos cobrados.')}`;
}

// ───────────────────────────── Búsquedas sin resultado ─────────────────────────────

export async function loadSearchMisses(db, { now = Date.now() } = {}) {
  const hace30 = new Date(now - 30 * DAY_MS).toISOString().slice(0, 10);
  const hace7 = new Date(now - 7 * DAY_MS).toISOString().slice(0, 10);
  const [top, totales] = await Promise.all([
    all(db, `SELECT query, SUM(count) AS total, COUNT(*) AS days, MAX(last_seen) AS last_seen
       FROM search_misses WHERE date >= ?
      GROUP BY query ORDER BY total DESC, last_seen DESC LIMIT 40`, [hace30]),
    one(db, `SELECT SUM(CASE WHEN date >= ? THEN count ELSE 0 END) AS week,
            SUM(count) AS month, COUNT(DISTINCT query) AS distinct_month
       FROM search_misses WHERE date >= ?`, [hace7, hace30]),
  ]);
  return { top, week: num(totales.week), month: num(totales.month), distinctMonth: num(totales.distinct_month) };
}

export function searchMissesSection(s) {
  const max = Math.max(0, ...s.top.map(r => num(r.total)));
  return `
  ${stats([
    { valor: entero(s.week), texto: 'búsquedas sin resultado · 7 días', alerta: s.week > 0 },
    { valor: entero(s.month), texto: 'búsquedas sin resultado · 30 días' },
    { valor: entero(s.distinctMonth), texto: 'textos distintos · 30 días' },
  ])}
  <p class="muted">Lo que la gente escribió en el buscador del sitio y no encontró nada. Es demanda directa: libros para conseguir o fichas que no aparecen con ese nombre.</p>
  ${table(['Buscaron', 'Veces', '', 'Días', 'Última vez'], s.top, r => `
    <tr><td><a href="https://listado.mercadolibre.com.uy/${encodeURIComponent(String(r.query).replace(/\s+/g, '-'))}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.query)}</a></td>
        <td><b>${entero(r.total)}</b></td><td class="col-barra">${barra(r.total, max)}</td>
        <td>${entero(r.days)}</td><td>${diaHora(r.last_seen)}</td></tr>`, 'Nadie buscó algo que no estuviera en los últimos 30 días.')}`;
}

// ───────────────────────────── Cambios del catálogo ─────────────────────────────

export async function loadCatalogChanges(db, { now = Date.now() } = {}) {
  const hace7 = new Date(now - 7 * DAY_MS).toISOString();
  const [runs, semana] = await Promise.all([
    all(db, `SELECT synced_at, total_items, available_items, previous_total, added, removed,
            price_up, price_down, out_of_stock, back_in_stock, baseline, samples_json
       FROM catalog_sync_log ORDER BY synced_at DESC LIMIT 40`),
    one(db, `SELECT COUNT(*) AS runs, SUM(added) AS added, SUM(removed) AS removed,
            SUM(price_up) AS price_up, SUM(price_down) AS price_down,
            SUM(out_of_stock) AS out_of_stock, SUM(back_in_stock) AS back_in_stock
       FROM catalog_sync_log WHERE synced_at >= ? AND baseline = 0`, [hace7]),
  ]);

  // Los ejemplos de los últimos cambios reales (no de corridas sin novedades).
  const ejemplos = { added: [], removed: [], price_changes: [] };
  for (const run of runs) {
    if (num(run.baseline)) continue;
    let samples = null;
    try { samples = JSON.parse(run.samples_json || 'null'); } catch { samples = null; }
    for (const tipo of Object.keys(ejemplos)) {
      for (const s of Array.isArray(samples?.[tipo]) ? samples[tipo] : []) {
        if (ejemplos[tipo].length < 15) ejemplos[tipo].push({ ...s, at: run.synced_at });
      }
    }
  }
  const conCambios = runs.filter(r => num(r.added) + num(r.removed) + num(r.price_up) + num(r.price_down)
    + num(r.out_of_stock) + num(r.back_in_stock) > 0 || num(r.baseline));
  return { runs: conCambios.slice(0, 15), last: runs[0] || null, semana, ejemplos };
}

export function catalogChangesSection(c) {
  const s = c.semana;
  const fichaLink = (id, title) => /^MLU\d+$/.test(String(id || ''))
    ? `<a href="/libro/${escapeHtml(id)}">${escapeHtml(title || id)}</a>` : escapeHtml(title || id || '—');
  return `
  <p class="muted">Último sync: ${diaHora(c.last?.synced_at)} UTC ·
    ${entero(c.last?.total_items)} fichas, ${entero(c.last?.available_items)} con stock.</p>
  <h3>Últimos 7 días</h3>
  ${stats([
    { valor: entero(s.added), texto: 'fichas nuevas' },
    { valor: entero(s.removed), texto: 'fichas que salieron', alerta: num(s.removed) > 0 },
    { valor: entero(s.back_in_stock), texto: 'volvieron a tener stock' },
    { valor: entero(s.out_of_stock), texto: 'se quedaron sin stock', alerta: num(s.out_of_stock) > 0 },
    { valor: entero(s.price_up), texto: 'subieron de precio' },
    { valor: entero(s.price_down), texto: 'bajaron de precio' },
  ])}
  <h3>Corridas con cambios</h3>
  ${table(['Cuándo', 'Fichas', 'Altas', 'Bajas', '↑ precio', '↓ precio', 'Agotados', 'Repuestos'], c.runs, r => `
    <tr><td>${diaHora(r.synced_at)}${num(r.baseline) ? ' <small class="muted">(línea base)</small>' : ''}</td>
        <td>${entero(r.total_items)}</td><td>${entero(r.added)}</td><td>${entero(r.removed)}</td>
        <td>${entero(r.price_up)}</td><td>${entero(r.price_down)}</td>
        <td>${entero(r.out_of_stock)}</td><td>${entero(r.back_in_stock)}</td></tr>`, 'Sin cambios registrados todavía.')}
  ${c.ejemplos.price_changes.length ? `<h3>Cambios de precio recientes</h3>
  ${table(['Libro', 'Antes', 'Ahora', 'Cambio', 'Cuándo'], c.ejemplos.price_changes, r => {
    const delta = num(r.to) - num(r.from);
    return `<tr><td>${fichaLink(r.id, r.title)}</td><td>${money(r.from)}</td><td>${money(r.to)}</td>
      <td class="${delta > 0 ? 'ok' : 'err'}">${delta > 0 ? '+' : ''}${pct(delta, num(r.from))}</td><td>${dia(r.at)}</td></tr>`;
  })}` : ''}
  ${c.ejemplos.added.length ? `<details class="tabla-datos"><summary>Fichas nuevas recientes</summary>
  ${table(['Libro', 'Precio', 'Cuándo'], c.ejemplos.added, r => `
    <tr><td>${fichaLink(r.id, r.title)}</td><td>${r.price ? money(r.price) : '—'}</td><td>${dia(r.at)}</td></tr>`)}
  </details>` : ''}
  ${c.ejemplos.removed.length ? `<details class="tabla-datos"><summary>Fichas que salieron del catálogo</summary>
  ${table(['Libro', 'Cuándo'], c.ejemplos.removed, r => `
    <tr><td>${escapeHtml(r.title || r.id)} <small class="muted">${escapeHtml(r.id)}</small></td><td>${dia(r.at)}</td></tr>`)}
  </details>` : ''}`;
}

// ───────────────────────────── Compras a proveedores ─────────────────────────────

export async function loadPurchases(db, { now = Date.now() } = {}) {
  const hace90 = now - 90 * DAY_MS;
  const hace365 = now - 365 * DAY_MS;
  const [recientes, proveedores, sinMatch] = await Promise.all([
    all(db, `SELECT o.purchase_id, o.supplier, o.document_number, o.document_type, o.purpose,
            o.purchase_date, o.currency, o.total_amount,
            COUNT(i.line_key) AS lines, COALESCE(SUM(i.quantity), 0) AS units,
            SUM(CASE WHEN i.isbn IS NULL THEN 1 ELSE 0 END) AS unmatched
       FROM purchase_orders o LEFT JOIN purchase_items i ON i.purchase_id = o.purchase_id
      WHERE o.superseded_by IS NULL
      GROUP BY o.purchase_id ORDER BY o.purchase_date_ms DESC LIMIT 15`),
    all(db, `SELECT o.supplier,
            COUNT(DISTINCT o.purchase_id) AS docs,
            SUM(CASE WHEN o.purchase_date_ms >= ? THEN (CASE WHEN o.document_type = 'credit_note' THEN -i.quantity ELSE i.quantity END) ELSE 0 END) AS units_90,
            SUM(CASE WHEN o.document_type = 'credit_note' THEN -i.quantity ELSE i.quantity END) AS units_365,
            MAX(o.purchase_date) AS last_date
       FROM purchase_orders o JOIN purchase_items i ON i.purchase_id = o.purchase_id
      WHERE o.superseded_by IS NULL AND o.purchase_date_ms >= ?
      GROUP BY o.supplier ORDER BY units_365 DESC`, [hace90, hace365]),
    one(db, `SELECT COUNT(*) AS lines FROM purchase_items i JOIN purchase_orders o ON o.purchase_id = i.purchase_id
      WHERE o.superseded_by IS NULL AND i.isbn IS NULL`),
  ]);
  return { recientes, proveedores, unmatched: num(sinMatch.lines) };
}

const DOC_TYPE = { invoice: 'factura', order: 'pedido', credit_note: 'nota de crédito', remito: 'remito' };

export function purchasesSection(p) {
  return `
  <h3>Por proveedor · 12 meses</h3>
  ${table(['Proveedor', 'Documentos', 'Libros · 90 días', 'Libros · 12 meses', 'Última compra'], p.proveedores, r => `
    <tr><td>${escapeHtml(r.supplier)}</td><td>${entero(r.docs)}</td><td>${entero(r.units_90)}</td>
        <td>${entero(r.units_365)}</td><td>${dia(r.last_date)}</td></tr>`, 'Todavía no se cargaron compras.')}
  <h3>Últimos documentos</h3>
  ${table(['Fecha', 'Proveedor', 'Documento', 'Libros', 'Total', 'Sin ISBN'], p.recientes, r => `
    <tr><td>${dia(r.purchase_date)}</td><td>${escapeHtml(r.supplier)}</td>
        <td>${escapeHtml(DOC_TYPE[r.document_type] || r.document_type || '—')} ${escapeHtml(r.document_number || '')}
            ${r.purpose === 'encargo_cliente' ? '<span class="pastilla p-neutro">encargo</span>' : ''}</td>
        <td>${entero(r.units)}</td>
        <td>${r.total_amount != null ? `${escapeHtml(r.currency || '')} ${entero(r.total_amount)}` : '—'}</td>
        <td class="${num(r.unmatched) ? 'err' : ''}">${entero(r.unmatched)}</td></tr>`, 'Todavía no se cargaron compras.')}
  <p class="muted">${p.unmatched
    ? `${entero(p.unmatched)} líneas de compra no tienen ISBN resuelto y el motor no las suma por libro.`
    : 'Todas las líneas de compra tienen ISBN.'}
    <a href="/panel/compras">Cargar compras</a></p>`;
}

// ───────────────────────────── Rastreo, en detalle ─────────────────────────────

export async function loadCrawlDetail(db, { now = Date.now() } = {}) {
  const desde = new Date(now - 7 * DAY_MS).toISOString().slice(0, 10);
  const [patrones, estados, segmentos] = await Promise.all([
    all(db, `SELECT pattern, SUM(request_count) AS requests,
            SUM(CASE WHEN status >= 400 THEN request_count ELSE 0 END) AS errors,
            SUM(CASE WHEN status BETWEEN 300 AND 399 THEN request_count ELSE 0 END) AS redirects,
            SUM(CASE WHEN verified = 1 THEN request_count ELSE 0 END) AS verified,
            SUM(duration_ms_sum) AS ms
       FROM crawl_stats_segmented WHERE date >= ?
      GROUP BY pattern ORDER BY requests DESC`, [desde]),
    all(db, `SELECT status, SUM(request_count) AS requests
       FROM crawl_stats_segmented WHERE date >= ?
      GROUP BY status ORDER BY requests DESC LIMIT 12`, [desde]),
    all(db, `SELECT segment, SUM(request_count) AS requests,
            SUM(CASE WHEN status >= 400 THEN request_count ELSE 0 END) AS errors
       FROM crawl_stats_segmented WHERE date >= ? AND segment <> 'non_product'
      GROUP BY segment ORDER BY requests DESC`, [desde]),
  ]);
  return { patrones, estados, segmentos };
}

const PATTERN_LABEL = {
  libro: 'fichas de libro', libro_variant: 'fichas con parámetros', libros: 'listados /libros',
  libros_param: 'listados con parámetros', catalogo: 'catálogo', catalogo_param: 'catálogo con filtros',
  home: 'portada', home_param: 'portada con parámetros', static_page: 'páginas fijas', asset: 'archivos',
  robots: 'robots.txt', sitemap: 'sitemaps', api: 'API', other: 'otras',
  legacy_book: 'URL vieja de libro', legacy_add_to_cart: 'URL vieja de carrito', legacy_producto: 'URL vieja /producto',
  legacy_categoria_producto: 'URL vieja de categoría', legacy_pagination: 'paginación vieja', legacy_root: 'raíz vieja',
};
const SEGMENT_LABEL = {
  active: 'libro activo', by_request: 'libro por encargo', paused_other: 'pausado (otros)',
  paused_unknown: 'pausado sin id', unknown_product: 'libro desconocido', historical_unsegmented: 'histórico sin segmentar',
};

export function crawlDetailSection(c) {
  const total = c.patrones.reduce((s, r) => s + num(r.requests), 0);
  return `
  <h3>Qué rastrea · 7 días</h3>
  ${table(['Tipo de página', 'Requests', '% del total', 'Errores', 'Redirecciones', 'Respuesta media'], c.patrones, r => {
    const req = num(r.requests);
    return `<tr><td>${escapeHtml(PATTERN_LABEL[r.pattern] || r.pattern)}</td><td>${entero(req)}</td>
      <td>${pct(req, total)}</td>
      <td class="${num(r.errors) / Math.max(1, req) > 0.1 ? 'err' : ''}">${entero(r.errors)} (${pct(num(r.errors), req)})</td>
      <td>${entero(r.redirects)}</td><td>${req ? `${entero(num(r.ms) / req)} ms` : '—'}</td></tr>`;
  })}
  <h3>Fichas de libro por estado</h3>
  ${table(['Estado del libro', 'Requests', 'Errores'], c.segmentos, r => `
    <tr><td>${escapeHtml(SEGMENT_LABEL[r.segment] || r.segment)}</td><td>${entero(r.requests)}</td>
        <td>${entero(r.errors)} (${pct(num(r.errors), num(r.requests))})</td></tr>`)}
  <h3>Códigos de respuesta</h3>
  ${stats(c.estados.map(r => ({
    valor: entero(r.requests),
    texto: `HTTP ${r.status}`,
    alerta: num(r.status) >= 500,
  })))}`;
}

// ───────────────────────────── Cuentas y proveedor SBS ─────────────────────────────

export async function loadAccounts(db, { now = Date.now() } = {}) {
  const hace30 = new Date(now - 30 * DAY_MS).toISOString();
  const ahora = new Date(now).toISOString();
  return one(db, `SELECT
      (SELECT COUNT(*) FROM account_identities) AS identities,
      (SELECT COUNT(*) FROM account_identities WHERE created_at >= ?) AS new_30,
      (SELECT COUNT(*) FROM account_identities WHERE last_seen_at >= ?) AS seen_30,
      (SELECT COUNT(*) FROM account_profiles) AS profiles,
      (SELECT COUNT(*) FROM account_sessions WHERE revoked_at IS NULL AND expires_at > ?) AS sessions`,
  [hace30, hace30, ahora]);
}

export async function loadSupplierStock(db) {
  const [feed, eventos] = await Promise.all([
    one(db, `SELECT source_date, expected_rows, checked_at FROM sbs_supplier_feeds
      WHERE state = 'ready' ORDER BY source_date DESC, created_at DESC LIMIT 1`),
    all(db, 'SELECT checked_at, kind, state, source_date, error_code FROM sbs_supplier_events ORDER BY id DESC LIMIT 8'),
  ]);
  return { feed, eventos };
}

export function accountsAndSupplierSection(cuentas, sbs) {
  const partes = [];
  if (cuentas) {
    partes.push(`<h3>Clientes con cuenta de Google</h3>
    ${stats([
      { valor: entero(cuentas.identities), texto: 'cuentas creadas' },
      { valor: entero(cuentas.new_30), texto: 'nuevas en 30 días' },
      { valor: entero(cuentas.seen_30), texto: 'entraron en 30 días' },
      { valor: entero(cuentas.profiles), texto: 'guardaron sus datos' },
      { valor: entero(cuentas.sessions), texto: 'sesiones abiertas' },
    ])}`);
  }
  if (sbs) {
    partes.push(`<h3>Stock del proveedor SBS</h3>
    <p class="muted">${sbs.feed?.source_date
      ? `Última lista cargada: ${dia(sbs.feed.source_date)} · ${entero(sbs.feed.expected_rows)} ISBN.`
      : 'Todavía no se cargó ninguna lista de SBS.'}</p>
    ${table(['Cuándo', 'Tipo', 'Estado', 'Lista del', 'Error'], sbs.eventos, r => `
      <tr><td>${diaHora(msToIso(r.checked_at))}</td><td>${escapeHtml(r.kind)}</td><td>${escapeHtml(r.state)}</td>
          <td>${dia(r.source_date)}</td><td class="${r.error_code ? 'err' : ''}">${escapeHtml(r.error_code || '—')}</td></tr>`,
    'Sin intentos registrados.')}`);
  }
  return partes.join('');
}

// ───────────────────────────── carga conjunta ─────────────────────────────

async function bloque(loader) {
  try {
    return { ok: true, data: await loader() };
  } catch (error) {
    if (sinTabla(error)) return { ok: false, empty: true, error: 'Sin datos todavía en este entorno.' };
    return { ok: false, error: String(error?.message || error || 'error desconocido') };
  }
}

export async function loadInsights(db, { now = Date.now() } = {}) {
  if (!db) {
    const falta = { ok: false, error: 'ORDERS_DB no está disponible en este entorno.' };
    return { ml: falta, web: falta, busquedas: falta, cambios: falta, compras: falta, rastreo: falta, cuentas: falta, sbs: falta };
  }
  const [ml, web, busquedas, cambios, compras, rastreo, cuentas, sbs] = await Promise.all([
    bloque(() => loadMlSales(db, { now })),
    bloque(() => loadWebInsights(db, { now })),
    bloque(() => loadSearchMisses(db, { now })),
    bloque(() => loadCatalogChanges(db, { now })),
    bloque(() => loadPurchases(db, { now })),
    bloque(() => loadCrawlDetail(db, { now })),
    bloque(() => loadAccounts(db, { now })),
    bloque(() => loadSupplierStock(db)),
  ]);
  return { ml, web, busquedas, cambios, compras, rastreo, cuentas, sbs };
}
