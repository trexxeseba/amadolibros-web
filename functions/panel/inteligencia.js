// /panel/inteligencia (Brújula Amado) — cómo va el negocio en 10 segundos: ventas y tendencia,
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
  return new Response(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Brújula Amado</title>
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

const VEREDICTO = { solo: ['t-a', 'Reponer: nadie lo tiene'], sostenible: ['t-a', 'Conviene reponer'], mas_barato: ['t-b', 'Mirar el costo'], no_conviene: ['t-bad', 'No conviene'], sin_dato: ['t-c', 'Sin dato de ML'] };
function sinStockTable(items) {
  if (!items?.length) return '';
  const rows = items.map(b => {
    const m = b.mercado ?? { estado: 'sin_dato' }, [cls, label] = VEREDICTO[m.estado] ?? VEREDICTO.sin_dato;
    const compra = b.compra ? `${esc(SUPPLIERS[b.compra.supplier] ?? b.compra.supplier)} · ${day(new Date(b.compra.d).toISOString())}` : '—';
    return `<tr><td><a href="/panel/reposicion?q=${esc(b.isbn)}">${esc(b.title ?? b.isbn)}</a><div class="muted">${esc(m.texto ?? 'Todavía no está en la vigilancia diaria de competencia.')}</div></td>
      <td class="n">${num(b.u90)}</td><td class="n">${b.avgPrice ? money(b.avgPrice) : '—'}</td><td class="n">${m.estado === 'sin_dato' ? '—' : num(m.nacionales)}</td>
      <td class="n">${m.min != null ? money(m.min) : '—'}</td><td class="n">${b.costo ? money(b.costo) : '—'}</td><td class="n">${b.margen ? `<span class="${b.margen.margin < 0 ? 'down' : 'up'}">${money(b.margen.margin)}</span>` : '—'}</td><td>${compra}</td><td><span class="tag ${cls}">${label}</span></td></tr>`;
  }).join('');
  return `<h2>Libros A sin stock: ¿conviene reponer?</h2><div class="card scroll"><table><thead><tr><th>Libro</th><th class="n">Vendidos 90 d</th><th class="n">Tu precio prom.</th><th class="n">Con entrega inmediata</th><th class="n">Más barato inmediato</th><th class="n">Costo hoy</th><th class="n">Ganás por libro</th><th>Última compra</th><th>Qué hacer</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted">"Con entrega inmediata": vendedores con el libro nuevo, sin envío del exterior y sin días de preparación en la publicación de catálogo de ML (foto diaria). Los que lo venden a pedido no cuentan. Los 15 que más vendían.</p></div>`;
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
      <p class="muted">Venta que se pierde: unos <b>${num(v.ventaPerdidaMes)} libros por mes</b>.</p>${v.mercado ? `<p class="muted">De los ${num(v.mercado.vigilados)} que vigilamos en ML hoy: <b>${num(v.mercado.solo)}</b> nadie más los tiene con entrega inmediata, <b>${num(v.mercado.sostenible)}</b> se venden a tu precio o más caro, <b>${num(v.mercado.masBarato)}</b> los venden más barato, <b>${num(v.mercado.noConviene)}</b> no conviene reponerlos a tu costo. Detalle abajo.</p>` : ''}</div>
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
    ${tile('Sin oferta comparable', num(c.solos), 'no detectamos otra oferta comparable en la ficha de ML: margen para subir precio')}
    ${tile('Precio vs mercado', c.medianaPrecio == null ? '—' : `${Math.round(c.medianaPrecio * 100)}%`, 'tu precio frente al más barato nuevo (mediana; 100% = igual)')}
    ${tile('Más caros que el mercado', num(c.masCaros), '15% o más arriba del más barato nuevo')}
  </div><p class="muted">${num(c.vigilados)} productos de catálogo con foto completa (los libros que más vendés; la foto diaria cubre hasta 400 fichas). Cobertura y detalle en <a href="/panel/reposicion">Reposición</a>; decisiones en <a href="/panel/oportunidades">Oportunidades</a>.</p>`;
}

function marginBlock(s) {
  if (!s?.ok) return failed(s);
  const tile = (l, v, d, extra = '') => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div><div>${d}</div>${extra ? `<div class="muted">${extra}</div>` : ''}</div>`;
  const v = s.data;
  if (!v.conCosto) return '<div class="card"><p class="muted">Todavía no hay costos para calcular: faltan el tipo de cambio del día o precios en las compras cargadas.</p></div>';
  const fee = v.feeRate == null ? `comisión de ML todavía sin datos (${num(v.feeSample)} ventas con comisión; hacen falta 5)` : `comisión de ML ${Math.round(v.feeRate * 1000) / 10}% (mediana de ${num(v.feeSample)} ventas)`;
  const row = b => `<tr><td><a href="/panel/reposicion?q=${esc(b.isbn)}">${esc(b.title ?? b.isbn)}</a></td><td class="n">${money(b.price)}</td><td class="n">${b.feeKnown ? money(b.fee) : '—'}</td><td class="n">${money(b.cost)}</td>
    <td class="n"><span class="${b.margin < 0 ? 'down' : b.pct < 15 ? 'flat' : 'up'}">${money(b.margin)} · ${b.pct}%</span></td><td>${esc(SUPPLIERS[b.supplier] ?? b.supplier)}</td></tr>`;
  const table = list => `<div class="card scroll"><table><thead><tr><th>Libro</th><th class="n">Vendés a</th><th class="n">Comisión ML</th><th class="n">Costo hoy</th><th class="n">Te queda</th><th>Proveedor</th></tr></thead><tbody>${list.map(row).join('')}</tbody></table></div>`;
  return `<div class="grid">
    ${tile('Margen libros A', v.margenPctA == null ? '—' : `${v.margenPctA}%`, `lo que te queda de cada $100 vendidos`, `${num(v.conCostoA)} de ${num(v.totalA)} libros A con costo conocido`)}
    ${tile('Margen bajo', num(v.bajoMargen), 'libros A que dejan menos de 15%')}
    ${tile('A pérdida', num(v.perdida), 'libros A que cuestan más de lo que dejan')}
  </div>
  <h2>Los que más plata dejan (12 meses)</h2>${table(v.top)}
  <h2>Los que menos dejan</h2>${table(v.peores)}
  <p class="muted">Costo = última compra con su descuento y lo que suma la factura (envío, gastos), en pesos al cambio de hoy${v.fxDate ? ` (${day(v.fxDate)})` : ''}; ${fee}. No incluye el flete hasta Uruguay ni el envío que pagás en ML.</p>`;
}

function raisesBlock(s) {
  if (!s?.ok) return failed(s);
  const v = s.data;
  if (!v) return '<div class="card"><p class="muted">La vigilancia de competencia todavía no tiene datos.</p></div>';
  const tile = (l, val, d) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${val}</div><div class="muted">${d}</div></div>`;
  const link = b => `<a href="/panel/reposicion?q=${esc(b.isbn)}">${esc(b.title ?? b.isbn)}</a>`;
  const marg = b => b.margenActual && b.margenSugerido ? `${money(b.margenActual.margin)} → <b>${money(b.margenSugerido.margin)}</b>` : '—';
  const rows = v.lista.map(b => `<tr><td>${link(b)}${b.agotado ? ' <span class="tag t-c">agotado</span>' : ''}</td><td class="n">${num(b.u90)}</td><td class="n">${money(b.actual)}</td>
    <td class="n">${money(b.min)} <span class="muted">(${num(b.competidores)}${b.aPedido ? ', a pedido' : ''})</span></td><td class="n"><b>${money(b.sugerido)}</b> <span class="up">+${b.subaPct}%</span></td>
    <td class="n">${b.ganaMes ? money(b.ganaMes) : '—'}</td><td class="n">${marg(b)}</td></tr>`).join('');
  const solos = v.solos.map(b => `<tr><td>${link(b)}</td><td class="n">${num(b.u90)}</td><td class="n">${money(b.actual)}</td><td class="n"><b>${money(b.sugerido)}</b> <span class="up">+10%</span></td><td class="n">${b.ganaMes ? money(b.ganaMes) : '—'}</td></tr>`).join('');
  return `<div class="grid">
    ${tile('Muy por debajo del mercado', num(v.total), `${Math.round((1 - v.umbral) * 100)}% o más abajo del más barato con entrega inmediata (o de los que lo venden a pedido, si sos el único inmediato) · ${num(v.conStock)} con stock`)}
    ${tile('Plata extra por mes', money(v.ganaMesTotal), 'si les ponés el precio sugerido y siguen vendiendo igual')}
    ${tile('Sin otra oferta inmediata', num(v.solosTotal), 'no detectamos otra oferta comparable con entrega inmediata en la ficha de ML')}
  </div>
  ${v.lista.length ? `<div class="card scroll" style="margin-top:12px"><table><thead><tr><th>Libro</th><th class="n">Vendidos 90 d</th><th class="n">Tu precio</th><th class="n">Más barato (vendedores)</th><th class="n">Precio sugerido</th><th class="n">Más por mes</th><th class="n">Te queda por libro</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="card"><p class="muted">Ningún libro está muy por debajo del mercado hoy.</p></div>'}
  ${v.solos.length ? `<h2>Sin otra oferta inmediata detectada: probá subir 10%</h2><div class="card scroll"><table><thead><tr><th>Libro</th><th class="n">Vendidos 90 d</th><th class="n">Tu precio</th><th class="n">Probá con</th><th class="n">Más por mes</th></tr></thead><tbody>${solos}</tbody></table></div>` : ''}
  <p class="muted">Precio sugerido: 2% debajo del competidor más barato con entrega inmediata; si sos el único inmediato, 2% debajo del más barato a pedido (marcado "a pedido"). Redondeado, con la foto diaria de ML. Los agotados usan tu precio promedio de venta: es el precio para cuando lo repongas. "Más por mes" supone que se sigue vendiendo como en los últimos 90 días. El panel sólo sugiere: los precios se cambian en Mercado Libre.</p>`;
}

export function renderBi(bi) {
  return `<h1>Brújula Amado</h1><p class="muted">Ventas de Mercado Libre y la web, stock del catálogo, compras y competencia · calculado ${esc(bi.generado.slice(0, 16).replace('T', ' '))} UTC</p>
    <h2>Cómo va el negocio</h2>${kpiBlock(bi.kpis)}
    <h2>Tendencia semanal</h2>${weeklyChart(bi.weekly)}
    <h2>Qué libros hacen la plata</h2>${abcBlock(bi.abc)}
    <h2>Dónde se pierde plata en el inventario</h2>${inventoryBlock(bi.inventario)}
    <h2>Cuánto deja cada libro</h2>${marginBlock(bi.margen)}
    <h2>Cómo rinden las compras</h2>${purchasesBlock(bi.compras)}
    <h2>Editoriales que más facturan</h2>${publishersBlock(bi.editoriales)}
    <h2>Posición frente a la competencia</h2>${competitionBlock(bi.competencia)}
    <h2>Libros que vendés muy barato: subirles el precio</h2>${raisesBlock(bi.precios)}`;
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
