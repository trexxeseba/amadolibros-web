// /panel/inteligencia — cómo va el negocio en 10 segundos: ventas y tendencia,
// qué libros hacen la plata (ABC), dónde se pierde (sin stock, stock muerto),
// cómo rinden las compras por proveedor, editoriales y posición competitiva.
// Sólo lectura, con sesión del panel y en producción. HTML + SVG, sin JavaScript.
import { deriveSessionSecret, hasValidSession, resolvePanelConfig } from '../_shared/panel-auth.js';
import { fetchCatalog } from '../_shared/catalog.js';
import { loadBi } from '../_shared/panel-bi.js';

const ORIGIN = 'https://www.amadolibros.com';
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => Math.round(Number(v) || 0).toLocaleString('es-UY');
const money = v => `$ ${num(v)}`;
const SUPPLIERS = { CELESA: 'Celesa', ARNOIA: 'Arnoia', CASASSA_Y_LORENZO: 'Casassa y Lorenzo', AMAZON_COM: 'Amazon.com', AMAZON_ES: 'Amazon.es', SBS: 'SBS' };
const day = iso => iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—';

function page(body, status = 200) {
  return new Response(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Inteligencia</title>
<style>
body{font:15px system-ui;margin:0;padding:16px;line-height:1.45;color:#222;background:#faf8f4}main{max-width:1250px;margin:0 auto}
h1{margin:.2em 0}h2{font-size:18px;margin:30px 0 10px}.muted{color:#777;font-size:13px}a{color:#a94e3d}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
.card{background:#fff;border:1px solid #e6e0d6;border-radius:10px;padding:14px 16px}
.kpi .l{font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:#666}.kpi .v{font-size:28px;font-weight:700;margin:4px 0}
.up{color:#1b6b30;font-weight:600}.down{color:#9a2b18;font-weight:600}.flat{color:#777}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:12px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:6px 8px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
th{font-size:12px;text-transform:uppercase;color:#666}td.n,th.n{text-align:right;white-space:nowrap}.scroll{overflow-x:auto}
.big{font-size:22px;font-weight:700}.tag{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;font-weight:600}
.t-a{background:#e7f5ea;color:#1b6b30}.t-b{background:#fff4d6;color:#8a5a00}.t-c{background:#eee;color:#555}.t-bad{background:#fde8e4;color:#9a2b18}
.bar{fill:#a94e3d}.bar.cur{fill:#d9a091}.axis{stroke:#ddd}.lbl{font-size:10px;fill:#777}
</style><main><p><a href="/panel">← Panel</a> · <a href="/panel/reposicion">Reposición</a></p>${body}</main></html>`, {
    status, headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" },
  });
}

const delta = d => d == null ? '<span class="flat">sin dato anterior</span>' : d > 0 ? `<span class="up">▲ ${d}%</span>` : d < 0 ? `<span class="down">▼ ${Math.abs(d)}%</span>` : '<span class="flat">= igual</span>';
const failed = s => `<div class="card"><p class="muted">No se pudo calcular este bloque${s?.error ? ` (${esc(s.error)})` : ''}.</p></div>`;

function kpiBlock(s) {
  if (!s.ok) return failed(s);
  const k = s.data;
  const tile = (l, v, d, extra = '') => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div><div>${d}</div>${extra ? `<div class="muted">${extra}</div>` : ''}</div>`;
  return `<div class="grid">
    ${tile('Vendido 7 días (ML)', money(k.r7), `${delta(k.r7Delta)} vs semana anterior`, `${num(k.u7)} libros · ${delta(k.u7Delta)}`)}
    ${tile('Vendido 30 días (ML)', money(k.r30), `${delta(k.r30Delta)} vs 30 días anteriores`, `${num(k.u30)} libros · ${delta(k.u30Delta)}`)}
    ${tile('Ticket promedio', money(k.ticket30), `${num(k.orders30)} ventas en 30 días`, `${num(k.titles30)} títulos distintos`)}
    ${tile('Encargo SBS', `${k.encargoPct30}%`, `de los libros vendidos en 30 días (${num(k.enc30)})`, k.enc365 ? `${num(k.enc365)} en 12 meses · último ${day(new Date(k.encLastMs).toISOString())}` : 'ninguna venta por encargo en 12 meses')}
    ${tile('Web 30 días', money(k.web.total), `${num(k.web.orders)} pedidos cobrados`, 'amadolibros.com')}
  </div>`;
}

const VEREDICTO = { solo: ['t-a', 'Reponer: nadie lo tiene'], sostenible: ['t-a', 'Conviene reponer'], mas_barato: ['t-b', 'Mirar el costo'], sin_dato: ['t-c', 'Sin dato de ML'] };
function sinStockTable(items) {
  if (!items?.length) return '';
  const rows = items.map(b => {
    const m = b.mercado ?? { estado: 'sin_dato' }, [cls, label] = VEREDICTO[m.estado] ?? VEREDICTO.sin_dato;
    const compra = b.compra ? `${esc(SUPPLIERS[b.compra.supplier] ?? b.compra.supplier)} · ${day(new Date(b.compra.d).toISOString())}` : '—';
    return `<tr><td><a href="/panel/reposicion?q=${esc(b.isbn)}">${esc(b.title ?? b.isbn)}</a><div class="muted">${esc(m.texto ?? 'Todavía no está en la vigilancia diaria de competencia.')}</div></td>
      <td class="n">${num(b.u90)}</td><td class="n">${b.avgPrice ? money(b.avgPrice) : '—'}</td><td class="n">${m.estado === 'sin_dato' ? '—' : num(m.nacionales)}</td>
      <td class="n">${m.min != null ? money(m.min) : '—'}</td><td>${compra}</td><td><span class="tag ${cls}">${label}</span></td></tr>`;
  }).join('');
  return `<h2>Libros A sin stock: ¿conviene reponer?</h2><div class="card scroll"><table><thead><tr><th>Libro</th><th class="n">Vendidos 90 d</th><th class="n">Tu precio prom.</th><th class="n">Lo venden desde UY</th><th class="n">Más barato nuevo</th><th>Última compra</th><th>Qué hacer</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted">"Desde UY": vendedores con el libro nuevo y sin envío internacional en la publicación de catálogo de ML (foto diaria). Los 15 que más vendían.</p></div>`;
}

function weeklyChart(s) {
  if (!s.ok) return failed(s);
  const w = s.data, W = 900, H = 210, pad = 28, bw = (W - pad * 2) / w.length;
  const max = Math.max(1, ...w.map(x => x.units));
  const bars = w.map((x, i) => {
    const h = Math.round((x.units / max) * (H - 50));
    const xPos = pad + i * bw + 2, yPos = H - 24 - h;
    return `<rect class="bar${i === w.length - 1 ? ' cur' : ''}" x="${xPos.toFixed(1)}" y="${yPos}" width="${(bw - 4).toFixed(1)}" height="${h}"><title>Semana del ${day(x.start)}: ${x.units} libros, ${money(x.revenue)}</title></rect>`
      + (i % 4 === 0 || i === w.length - 1 ? `<text class="lbl" x="${(xPos + (bw - 4) / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(day(x.start).slice(0, 5))}</text>` : '')
      + (x.units ? `<text class="lbl" x="${(xPos + (bw - 4) / 2).toFixed(1)}" y="${yPos - 3}" text-anchor="middle">${x.units}</text>` : '');
  }).join('');
  const last4 = w.slice(-5, -1).reduce((n, x) => n + x.units, 0), prev4 = w.slice(-9, -5).reduce((n, x) => n + x.units, 0);
  return `<div class="card"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Libros vendidos por semana"><line class="axis" x1="${pad}" y1="${H - 24}" x2="${W - pad}" y2="${H - 24}"/>${bars}</svg>
    <p class="muted">Libros vendidos por semana en Mercado Libre (la última barra, más clara, es la semana en curso). Últimas 4 semanas completas: <b>${num(last4)}</b> contra <b>${num(prev4)}</b> las 4 anteriores ${delta(prev4 ? Math.round(((last4 - prev4) / prev4) * 100) : null)}.</p></div>`;
}

function abcBlock(s) {
  if (!s.ok) return failed(s);
  const a = s.data;
  const top = a.sorted.filter(b => b.clase === 'A').slice(0, 12).map(b => `<tr><td>${esc(b.title ?? b.isbn)}<br><small class="muted">${esc(b.isbn)}</small></td><td class="n">${num(b.u365)}</td><td class="n">${money(b.rev365)}</td><td class="n">${b.stock === 0 ? '<span class="tag t-bad">0</span>' : b.stock}</td></tr>`).join('');
  return `<div class="two"><div class="card"><p class="big">${num(a.A)} libros hacen el ${a.shareA}% de la facturación</p>
    <p><span class="tag t-a">A: ${num(a.A)}</span> <span class="tag t-b">B: ${num(a.B)}</span> <span class="tag t-c">C: ${num(a.C)}</span> <span class="muted">de ${num(a.total)} títulos con ventas en 12 meses</span></p>
    <p class="muted">A = los que suman el 80% de lo facturado (no pueden faltar nunca). B = el 15% siguiente. C = la cola larga: vender de a uno, reponer sólo con demanda.</p></div>
    <div class="card"><div class="scroll"><table><thead><tr><th>Top libros A</th><th class="n">Vendidos 365 d</th><th class="n">Facturado</th><th class="n">Stock</th></tr></thead><tbody>${top}</tbody></table></div></div></div>`;
}

function inventoryBlock(s) {
  if (!s.ok) return failed(s);
  const v = s.data;
  const list = (items, cols) => items.length ? `<div class="scroll"><table><tbody>${items.map(cols).join('')}</tbody></table></div>` : '<p class="muted">Ninguno.</p>';
  const link = b => `<a href="/panel/reposicion?q=${esc(b.isbn)}">${esc(b.title ?? b.isbn)}</a>`;
  return `<div class="grid">
    <div class="card"><div class="kpi"><div class="l">Libros A sin stock</div><div class="v down">${num(v.aSinStockCount)}</div></div>
      <p class="muted">Venta que se pierde: unos <b>${num(v.ventaPerdidaMes)} libros por mes</b>.</p>${v.mercado ? `<p class="muted">De los ${num(v.mercado.vigilados)} que vigilamos en ML hoy: <b>${num(v.mercado.solo)}</b> nadie los vende nuevos desde Uruguay, <b>${num(v.mercado.sostenible)}</b> se venden a tu precio o más caro, <b>${num(v.mercado.masBarato)}</b> los venden más barato. Detalle abajo.</p>` : ''}</div>
    <div class="card"><div class="kpi"><div class="l">Libros A que se agotan pronto</div><div class="v">${num(v.coberturaBajaCount)}</div></div>
      <p class="muted">Stock para menos de ${15 * 2} días al ritmo actual (el proveedor tarda ~15).</p>${list(v.coberturaBaja, b => `<tr><td>${link(b)}</td><td class="n">${b.dias} días</td></tr>`)}</div>
    <div class="card"><div class="kpi"><div class="l">Stock muerto</div><div class="v">${num(v.muertoCount)}</div></div>
      <p class="muted">${num(v.muertoUnidades)} unidades con stock y sin ventas en 6 meses: candidatos a promoción o rebaja.</p>${list(v.muerto, b => `<tr><td>${link(b)}</td><td class="n">${b.stock} u.</td></tr>`)}</div>
  </div>${sinStockTable(v.aSinStock)}`;
}

function purchasesBlock(s) {
  if (!s.ok) return failed(s);
  if (!s.data.suppliers.length) return '<div class="card"><p class="muted">Sin compras con ISBN en los últimos 90 días.</p></div>';
  const rows = s.data.suppliers.map(p => `<tr><td>${esc(SUPPLIERS[p.supplier] ?? p.supplier)}</td><td class="n">${num(p.bought)}</td><td class="n">${num(p.sold)}</td>
    <td class="n"><span class="tag ${p.sellThrough >= 60 ? 't-a' : p.sellThrough >= 30 ? 't-b' : 't-bad'}">${p.sellThrough}%</span></td><td class="n">${num(p.titles)}</td><td class="n">${num(p.sinVenta)}</td></tr>`).join('');
  return `<div class="card"><div class="scroll"><table><thead><tr><th>Proveedor</th><th class="n">Comprado (u.)</th><th class="n">Ya vendido</th><th class="n">% vendido</th><th class="n">Títulos</th><th class="n">Líneas sin ninguna venta</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted">De lo comprado en los últimos 90 días, cuánto ya se vendió en Mercado Libre desde la fecha de compra (sin contar encargos SBS). Mide qué proveedor y qué compras rinden.</p></div>`;
}

function publishersBlock(s) {
  if (!s.ok) return failed(s);
  if (!s.data.length) return '<div class="card"><p class="muted">Sin datos de editorial.</p></div>';
  const max = Math.max(...s.data.map(p => p.revenue), 1);
  const rows = s.data.map(p => `<tr><td>${esc(p.publisher)}</td><td style="width:40%"><svg viewBox="0 0 100 8" width="100%" height="10"><rect class="bar" x="0" y="0" height="8" width="${Math.max(1, Math.round((p.revenue / max) * 100))}"/></svg></td><td class="n">${money(p.revenue)}</td><td class="n">${num(p.units)} u.</td><td class="n">${num(p.titles)}</td></tr>`).join('');
  return `<div class="card"><div class="scroll"><table><thead><tr><th>Editorial</th><th></th><th class="n">Facturado 90 d</th><th class="n">Libros</th><th class="n">Títulos</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

function competitionBlock(s) {
  if (!s.ok) return failed(s);
  const c = s.data;
  if (!c) return '<div class="card"><p class="muted">La vigilancia de competencia todavía no tiene datos.</p></div>';
  const tile = (l, v, extra) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="muted">${extra}</div></div>`;
  return `<div class="grid">
    ${tile('Ganás el 1.º lugar', c.ganandoPct == null ? '—' : `${c.ganandoPct}%`, `${num(c.ganando)} de ${num(c.conEstado)} libros con publicación de catálogo`)}
    ${tile('Solo en el catálogo', num(c.solos), 'nadie más ofrece el libro: margen para subir precio')}
    ${tile('Precio vs mercado', c.medianaPrecio == null ? '—' : `${Math.round(c.medianaPrecio * 100)}%`, 'tu precio frente al más barato nuevo (mediana; 100% = igual)')}
    ${tile('Más caros que el mercado', num(c.masCaros), '15% o más arriba del más barato nuevo')}
  </div><p class="muted">${num(c.vigilados)} productos de catálogo vigilados a diario (los libros que más vendés). Detalle en <a href="/panel/reposicion">Reposición</a>.</p>`;
}

export function renderBi(bi) {
  return `<h1>Inteligencia del negocio</h1><p class="muted">Ventas de Mercado Libre y la web, stock del catálogo, compras y competencia · calculado ${esc(bi.generado.slice(0, 16).replace('T', ' '))} UTC</p>
    <h2>Cómo va el negocio</h2>${kpiBlock(bi.kpis)}
    <h2>Tendencia semanal</h2>${weeklyChart(bi.weekly)}
    <h2>Qué libros hacen la plata</h2>${abcBlock(bi.abc)}
    <h2>Dónde se pierde plata en el inventario</h2>${inventoryBlock(bi.inventario)}
    <h2>Cómo rinden las compras</h2>${purchasesBlock(bi.compras)}
    <h2>Editoriales que más facturan</h2>${publishersBlock(bi.editoriales)}
    <h2>Posición frente a la competencia</h2>${competitionBlock(bi.competencia)}`;
}

export function createBiPanel({ loader = (db, catalog) => loadBi(db, catalog) } = {}) {
  return async context => {
    const { request, env } = context;
    const url = new URL(request.url);
    if (url.origin !== ORIGIN || env.APP_ENV !== 'production') return page('<p>No disponible.</p>', 403);
    const config = resolvePanelConfig(env);
    if (!config.ok || !await hasValidSession(request, await deriveSessionSecret(config.password))) return Response.redirect(`${ORIGIN}/panel`, 303);
    if (request.method !== 'GET') return page('<p>Método no permitido.</p>', 405);
    if (!env.ORDERS_DB) return page('<p>Sin base de datos en este entorno.</p>', 503);
    const catalog = await fetchCatalog(context).catch(() => null);
    return page(renderBi(await loader(env.ORDERS_DB, catalog)));
  };
}

export const onRequest = createBiPanel();
