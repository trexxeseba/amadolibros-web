import { nextInternalEmailAt } from '../functions/_shared/internal-email-schedule.js';
/**
 * Correo diario del panel: cada noche (20:00 en Montevideo) le llega a quien
 * atiende la tienda lo que hay que hacer hoy, sin tener que abrir el panel
 * para enterarse. Es un resumen para ACTUAR:
 *
 *   - pedidos pagados que faltan despachar,
 *   - pedidos sin pagar, para escribirle al cliente,
 *   - cómo salió ayer.
 *
 * No incluye teléfonos ni direcciones: el correo viaja por mail y el detalle
 * vive detrás de la contraseña del panel. Solo código de pedido, nombre de
 * pila, monto y un enlace.
 *
 * Una vez por día: la reserva en KV evita duplicados si el cron se repite.
 */

import { readSalesHealth, evaluateSalesHealth } from './sales-health.js';
import { competitionEvents } from './ml-competition.js';
import { COUNTED_STATUSES } from './ml-sales.js';
import { ownStockIndex } from './reposicion-facts.js';
import { loadBi, brujulaDigest, competidoresSinStock, loadRepuestos } from '../functions/_shared/panel-bi.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const EMAIL_TIMEOUT_MS = 7000;
const PANEL_URL = 'https://www.amadolibros.com/panel';
const UNPAID_WINDOW_DAYS = 7;
const MAX_ROWS = 15;
const MAX_PIERDE = 10;
const URUGUAY_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC-3 todo el año

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function money(value) {
  return `$ ${new Intl.NumberFormat('es-UY', { maximumFractionDigits: 0 }).format(Number(value) || 0)}`;
}

/** Día de Montevideo (YYYY-MM-DD) y sus límites en UTC, para `now`. */
export function montevideoDay(now, daysAgo = 0) {
  const local = new Date(now.getTime() - URUGUAY_OFFSET_MS - daysAgo * 86_400_000);
  const date = local.toISOString().slice(0, 10);
  const startUtc = new Date(Date.parse(`${date}T00:00:00.000Z`) + URUGUAY_OFFSET_MS);
  return { date, startIso: startUtc.toISOString(), endIso: new Date(startUtc.getTime() + 86_400_000).toISOString() };
}

function firstName(name) {
  return cleanString(name).split(/\s+/)[0] || 'Cliente';
}

async function all(db, sql, params = []) {
  const { results } = await db.prepare(sql).bind(...params).all();
  return results || [];
}

export async function loadDigestData(db, now = new Date(), { catalog = null } = {}) {
  const yesterday = montevideoDay(now, 1);
  const since = new Date(now.getTime() - UNPAID_WINDOW_DAYS * 86_400_000).toISOString();
  const [toShip, unpaid, sold, created, whatsapps, salesHealth, competencia, mlAyer] = await Promise.all([
    all(db, `SELECT public_code, buyer_name, delivery_type, payable_total_uyu, paid_at FROM orders
              WHERE payment_status = 'approved' AND fulfilled_at IS NULL AND cancelled_at IS NULL AND archived_at IS NULL
              ORDER BY paid_at ASC LIMIT 100`),
    all(db, `SELECT public_code, buyer_name, delivery_type, payment_provider, payable_total_uyu, created_at FROM orders
              WHERE status = 'open' AND payment_status != 'approved' AND cancelled_at IS NULL AND archived_at IS NULL AND created_at >= ?
              ORDER BY created_at DESC LIMIT 100`, [since]),
    all(db, `SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(paid_amount_uyu, payable_total_uyu)), 0) AS total FROM orders
              WHERE payment_status = 'approved' AND paid_at >= ? AND paid_at < ?`, [yesterday.startIso, yesterday.endIso]),
    all(db, `SELECT COUNT(*) AS n FROM orders WHERE created_at >= ? AND created_at < ?`, [yesterday.startIso, yesterday.endIso]),
    // La tabla llega con la migración 0013; antes de aplicarla el resumen sigue funcionando.
    all(db, `SELECT whatsapp, product_title FROM stock_waitlist_whatsapp
              WHERE status = 'waiting' ORDER BY created_at DESC LIMIT 100`).catch(() => []),
    readSalesHealth(db).catch(() => null),
    competitionEvents(db, { limit: 200, enteros: ['precio_arriba'] }).catch(() => null),
    // Ventas de ayer en Mercado Libre: sin esto "Ayer" decía 0 aunque se hubiera vendido.
    all(db, `SELECT COUNT(*) AS n, COALESCE(SUM(total_amount), 0) AS total FROM ml_sales_orders
              WHERE status IN (${COUNTED_STATUSES.map(s => `'${s}'`).join(',')}) AND date_created_ms >= ? AND date_created_ms < ?`,
      [Date.parse(yesterday.startIso), Date.parse(yesterday.endIso)]).catch(() => null),
  ]);
  // Título de cada libro para los avisos de competencia (antes salía sólo el ISBN).
  const titulos = new Map();
  // Mismo criterio de stock propio que el resto de la Brújula.
  const propio = ownStockIndex(catalog), enStock = { get: k => propio.get(k)?.stock_propio ?? 0 };
  for (const it of Array.isArray(catalog?.items) ? catalog.items : []) {
    const k = String(it?.isbn ?? '').replace(/[^0-9Xx]/g, '');
    if (!k) continue;
    if (it.title && !titulos.has(k)) titulos.set(k, it.title);
  }
  // Ventas que se están yendo a otro: libros que tenés en stock y un competidor
  // ofrece más barato con entrega inmediata y el mismo tipo de envío. Los de
  // mayor diferencia primero.
  const pierdeTodos = (competencia?.enteros?.precio_arriba ?? [])
    .filter(e => e.tuPrecio > 0 && e.minPrecio > 0 && (enStock.get(String(e.isbn)) ?? 0) > 0)
    .sort((a, b) => b.pct - a.pct);
  // Brújula: qué reponer, a qué subirle el precio, qué se agota y qué se vende
  // a pérdida. Si algo falla, el correo sale igual sin esta parte.
  let brujula = null;
  if (catalog) { try { brujula = brujulaDigest(await loadBi(db, catalog, now.getTime())); } catch { brujula = null; } }
  // Libros que volvieron a tener stock y competidores que se quedaron sin él.
  // Cada parte falla sola: el correo sale igual.
  const repuestos = await loadRepuestos(db, now.getTime()).catch(() => []);
  const competidores = catalog && competencia?.eventos?.length ? competidoresSinStock(competencia.eventos, catalog) : [];
  if (repuestos.length || competidores.length) {
    brujula = { reponer: [], pedidos: [], subir: [], agotan: [], perdida: [], ultimo: [], ultimoTotal: 0, agotados: [], agotadosTotal: 0, agotadosViejos: 0, subirTotal: 0, ...(brujula ?? {}), repuestos, competidores };
  }
  return {
    yesterday,
    toShip,
    unpaid,
    soldCount: Number(sold[0]?.n || 0),
    soldTotal: Number(sold[0]?.total || 0),
    createdCount: Number(created[0]?.n || 0),
    whatsapps,
    // Sólo los problemas: el correo no se llena de estado cuando todo anda bien.
    systemProblems: salesHealth ? evaluateSalesHealth(salesHealth, now.getTime()).problemas : [],
    // Sólo si hubo novedades de competencia en la última foto.
    competition: competencia?.eventos?.length ? { ...competencia, eventos: competencia.eventos.slice(0, 5).map(e => ({ ...e, title: titulos.get(String(e.isbn)) ?? null })) } : null,
    pierde: pierdeTodos.length ? { total: pierdeTodos.length, lista: pierdeTodos.slice(0, MAX_PIERDE).map(e => ({ isbn: e.isbn, title: titulos.get(String(e.isbn)) ?? e.isbn,
      tuPrecio: e.tuPrecio, minPrecio: e.minPrecio, pct: e.pct, vendedor: e.vendedor ?? null, stock: enStock.get(String(e.isbn)) })) } : null,
    ml: mlAyer ? { count: Number(mlAyer[0]?.n || 0), total: Number(mlAyer[0]?.total || 0) } : null,
    brujula,
  };
}

const BRUJULA_URL = `${PANEL_URL}/inteligencia`;
const BRUJULA_BLOCKS = [
  ['reponer', 'Conviene reponer'],
  ['repuestos', 'Volvieron a tener stock'],
  ['pedidos', 'Ya pedidos: esperando que lleguen'],
  ['ultimo', 'Último ejemplar de un libro que se vende: pedilo'],
  ['agotados', 'Se agotaron hace poco y vendían seguido: pedilos'],
  ['hoy', 'Se agotaron en las últimas 48 horas'],
  ['subir', 'Subile el precio'],
  ['agotan', 'Se agotan pronto: pedilos'],
  ['perdida', 'Se venden a pérdida'],
  ['competidores', 'Competidores que se quedaron sin stock: tu oportunidad'],
];
const BLOCK_COLOR = { subir: '#2e7d32', perdida: '#b91c1c', agotan: '#b45309', competidores: '#2e7d32', repuestos: '#2e7d32' };
const bookLink = isbn => `${PANEL_URL}/reposicion?q=${encodeURIComponent(isbn)}`;
// "Subile el precio" lista pocos: si hay más libros con stock muy por debajo del
// mercado, el título dice cuántos son en total.
const blockTitle = (b, key, title) => key === 'subir' && b.subirTotal > b.subir.length
  ? `${title} (${b.subir.length} de ${b.subirTotal} con stock muy por debajo del mercado; todos en el panel)`
  : key === 'ultimo' && b.ultimoTotal > b.ultimo.length ? `${title} (${b.ultimo.length} de ${b.ultimoTotal}; todos en el panel)`
  : key === 'hoy' && b.hoyTotal > b.hoy.length ? `${title} (${b.hoy.length} de ${b.hoyTotal}; todos en el panel)`
  : key === 'agotados' && (b.agotadosTotal > b.agotados.length || b.agotadosViejos > 0)
    ? `${title} (${b.agotados.length} de ${b.agotadosTotal}${b.agotadosViejos > 0 ? `; otros ${b.agotadosViejos} se agotaron hace más de 4 meses, en el panel` : '; todos en el panel'})` : title;

// Antes de decir "reponé" el correo pasa cada libro por dos chequeos: que no
// esté pedido y que nadie más lo tenga con entrega inmediata. Sólo los que
// pasan los dos van a "Para pedir hoy"; el resto dice qué falta mirar.
const RESTOCK_KEYS = ['reponer', 'ultimo', 'agotados', 'hoy', 'pedidos'];
const ORIGEN = { reponer: 'Sin stock', ultimo: 'Último ejemplar', agotados: 'Se agotó hace poco', hoy: 'Se agotó en las últimas 48 horas', pedidos: 'Ya pedido' };
const GRUPOS = [
  ['pedir', 'Para pedir hoy: sin pedido y sin competencia con entrega inmediata', '#2e7d32'],
  ['revisar', 'Revisar antes de pedir', '#b45309'],
  ['noReponer', 'No reponer por ahora: hay competencia con entrega inmediata', '#b91c1c'],
  ['enCamino', 'Ya pedidos: esperando que lleguen', '#475569'],
];

export function clasificarReposicion(b) {
  const out = { pedir: [], revisar: [], noReponer: [], enCamino: [], resto: {} };
  const vistos = new Set();
  for (const key of RESTOCK_KEYS) {
    for (const r of b?.[key] ?? []) {
      const d = r.datos;
      if (!d) { (out.resto[key] ??= []).push(r); continue; }
      const id = r.isbn || r.title;
      if (vistos.has(id)) continue;
      vistos.add(id);
      const fila = { ...r, origen: ORIGEN[key] };
      if (d.pedido === 'si') { out.enCamino.push({ ...fila, motivo: 'Ya está pedido: no lo pidas de nuevo.' }); continue; }
      // Un competidor más caro que tu precio no te saca la venta: se revisa, no se descarta.
      const masCaro = d.competencia === 'si' && d.competidorMin && d.precio && d.competidorMin > d.precio;
      if (d.competencia === 'si' && !masCaro) {
        out.noReponer.push({ ...fila, motivo: `Hay competencia con entrega inmediata${d.competidorMin ? ` desde ${money(d.competidorMin)}` : ''}: reponerlo inmoviliza capital.` });
        continue;
      }
      const motivos = [];
      if (d.pedido === 'sin_verificar') motivos.push('confirmá que no esté pedido');
      if (masCaro) motivos.push(`otro lo tiene con entrega inmediata, pero más caro (${money(d.competidorMin)} contra tu ${money(d.precio)})`);
      if (d.competencia === 'sin_dato') motivos.push('sin dato de competencia, mirá la ficha en Mercado Libre');
      if (d.pocoVendido) motivos.push(`vendió ${d.u365} en 12 meses, decidí vos si vale reponerlo`);
      if (motivos.length) out.revisar.push({ ...fila, motivo: `Antes de pedir: ${motivos.join('; ')}.` });
      else out.pedir.push({ ...fila, motivo: 'Verificado: no está pedido y nadie más lo tiene con entrega inmediata.' });
    }
  }
  return out;
}

const notaFaltan = b => b?.faltan?.length
  ? `Faltan cargar las compras de ${b.faltan.join(', ')}: en los libros que dicen "Sin compras registradas", confirmá que no estén pedidos.` : '';
const notaMas = b => {
  const partes = [];
  if (b.ultimoTotal > (b.ultimo?.length ?? 0)) partes.push(`${b.ultimoTotal} con último ejemplar`);
  if (b.agotadosTotal > (b.agotados?.length ?? 0)) partes.push(`${b.agotadosTotal} agotados hace poco`);
  if (b.agotadosViejos > 0) partes.push(`${b.agotadosViejos} agotados hace más de 4 meses`);
  return partes.length ? `El correo muestra los más urgentes. En el panel están todos: ${partes.join(', ')}.` : '';
};

function estadoTxt(d) {
  const venta = d.ultimaVenta ? `última venta el ${d.ultimaVenta}${d.hace != null ? ` (${d.hace === 0 ? 'hoy' : d.hace === 1 ? 'ayer' : `hace ${d.hace} días`})` : ''}` : '';
  const stock = d.stock > 0 ? `Queda${d.stock === 1 ? '' : 'n'} ${d.stock}${d.cobertura != null ? `, alcanza${d.stock === 1 ? '' : 'n'} unos ${d.cobertura} días` : ''}` : 'Sin stock';
  return [stock, venta].filter(Boolean).join(' · ');
}
// "Sin stock" ya lo dice el estado: el origen sólo se suma si agrega algo.
const cabecera = r => [r.origen === 'Sin stock' ? '' : r.origen, estadoTxt(r.datos)].filter(Boolean).join(' · ');
const ventasTxt = d => `${d.u30} en 30 días · ${d.u90} en 90 · ${d.u365} en 12 meses${d.ritmo ? ` (1 cada ${d.ritmo} días)` : ''}`;

function brujulaSections(b) {
  if (!b) return [];
  const g = clasificarReposicion(b);
  const out = [];
  for (const [key, title, color] of GRUPOS) {
    if (!g[key].length) continue;
    out.push({ title: `${title} (${g[key].length})`, color, rows: g[key], note: key === 'revisar' ? notaFaltan(b) : '' });
  }
  const regrouped = GRUPOS.some(([key]) => g[key].length);
  if (regrouped && notaMas(b)) out[out.length - 1].after = notaMas(b);
  for (const [key, title] of BRUJULA_BLOCKS) {
    const rows = RESTOCK_KEYS.includes(key) ? g.resto[key] : b[key];
    if (!rows?.length) continue;
    out.push({ title: blockTitle(b, key, title), color: BLOCK_COLOR[key] ?? '#a94e3d', rows });
  }
  return out;
}

function brujulaText(b) {
  const sections = brujulaSections(b);
  if (!sections.length) return [];
  const out = ['BRÚJULA AMADO — qué hacer hoy'];
  for (const s of sections) {
    out.push(`  ${s.title}:`);
    if (s.note) out.push(`  (${s.note})`);
    for (const r of s.rows) {
      const d = r.datos;
      if (!d) { out.push(`  - ${r.title ?? r.isbn}: ${r.detalle}`); continue; }
      out.push(`  - ${r.title ?? r.isbn}`,
        `      ${cabecera(r)}`,
        `      ${d.pedir != null ? `Pedí ${d.pedir} · ` : ''}Vendiste ${ventasTxt(d)}${d.precio ? ` · precio ${money(d.precio)}` : ''}${d.costo ? ` · costo ${money(d.costo)}${d.proveedor ? ` (${d.proveedor})` : ''}` : ''}`,
        `      Compras: ${d.compra}.`, `      Competencia: ${d.mercado}.`, `      ${r.motivo}`);
    }
    if (s.after) out.push(`  ${s.after}`);
    out.push('');
  }
  out.push(`  Todo en ${BRUJULA_URL}`, '');
  return out;
}

const H2 = 'font-size:18px;margin:32px 0 10px;padding-bottom:6px;border-bottom:2px solid #a94e3d';
const cell = (label, value) => `<td style="padding:6px 10px;background:#f6f4f1;border-radius:4px;font-size:13px;vertical-align:top"><span style="color:#777;font-size:11px;text-transform:uppercase">${escapeHtml(label)}</span><br><strong>${escapeHtml(value)}</strong></td>`;

function cardHtml(r, color) {
  const title = `<a href="${escapeHtml(bookLink(r.isbn))}" style="color:#222;font-weight:bold;font-size:15px;text-decoration:none">${escapeHtml(r.title ?? r.isbn)}</a>`;
  const box = inner => `<div style="border:1px solid #e5e2dd;border-left:4px solid ${color};border-radius:6px;padding:12px 14px;margin:12px 0">${inner}</div>`;
  const d = r.datos;
  if (!d) return box(`${title}<div style="font-size:14px;color:#444;margin-top:4px">${escapeHtml(r.detalle)}</div>`);
  const cells = [
    d.pedir != null ? cell('Pedir', `${d.pedir} u.`) : '',
    cell('Vendiste', `${d.u30} / ${d.u90} / ${d.u365}`),
    d.precio ? cell('Precio', money(d.precio)) : '',
    d.costo ? cell('Costo', money(d.costo)) : '',
  ].filter(Boolean).join('<td style="width:6px"></td>');
  return box(`${title}
    <div style="font-size:12px;color:#777;margin:3px 0 10px">${escapeHtml(cabecera(r))}</div>
    <table role="presentation" style="border-collapse:separate;border-spacing:0"><tr>${cells}</tr></table>
    <div style="font-size:11px;color:#999;margin:4px 0 8px">Vendiste: en 30 días / 90 días / 12 meses${d.ritmo ? ` · 1 cada ${d.ritmo} días` : ''}${d.meses ? ` · últimos 6 meses: ${escapeHtml(d.meses.join(', '))}` : ''}</div>
    <div style="font-size:13px;color:#444;margin:3px 0"><strong>1. Compras:</strong> ${escapeHtml(d.compra)}.</div>
    <div style="font-size:13px;color:#444;margin:3px 0"><strong>2. Competencia:</strong> ${escapeHtml(d.mercado)}.</div>
    <div style="font-size:13px;font-weight:bold;color:${color};margin-top:8px">${escapeHtml(r.motivo)}</div>`);
}

function brujulaHtml(b) {
  const sections = brujulaSections(b);
  if (!sections.length) return '';
  const blocks = sections.map(s => `
    <h3 style="font-size:15px;margin:26px 0 6px;color:${s.color}">${escapeHtml(s.title)}</h3>
    ${s.note ? `<p style="font-size:13px;color:#666;margin:4px 0 8px">${escapeHtml(s.note)}</p>` : ''}
    ${s.rows.map(r => cardHtml(r, s.color)).join('')}
    ${s.after ? `<p style="font-size:13px;color:#666;margin:8px 0">${escapeHtml(s.after)}</p>` : ''}`).join('');
  return `<h2 style="${H2}">Brújula Amado: qué hacer hoy</h2>${blocks}
    <p style="margin:16px 0"><a href="${BRUJULA_URL}" style="color:#a94e3d">Ver todo en Brújula Amado</a></p>`;
}

// Resumen de arriba: cuántas cosas hay en cada grupo, para leerlo en 5 segundos.
function resumenBrujula(b) {
  if (!b) return [];
  const g = clasificarReposicion(b);
  return [
    ['Para pedir hoy', g.pedir.length, '#2e7d32'],
    ['Revisar antes', g.revisar.length, '#b45309'],
    ['No reponer', g.noReponer.length, '#b91c1c'],
    ['Subir precio', b.subirTotal || b.subir?.length || 0, '#2e7d32'],
    ['A pérdida', b.perdida?.length ?? 0, '#b91c1c'],
  ].filter(([, n]) => n > 0);
}

// "Estás perdiendo estas ventas": tu precio es superior al de un competidor
// que también entrega ya. Dice cuánto hay que bajar para igualarlo; decidir si
// el margen lo permite queda para el dueño (el costo se ve en el panel).
const pierdeTitulo = p => `Seba, estás perdiendo estas ventas: tu precio es superior${p.total > p.lista.length ? ` (${p.lista.length} de ${p.total}; todos en el panel)` : ` (${p.total})`}`;
const pierdeLinea = r => `Tu precio ${money(r.tuPrecio)} · ${r.vendedor ?? 'un competidor'} lo tiene con entrega inmediata a ${money(r.minPrecio)} · estás ${r.pct}% arriba · para igualarlo bajá ${money(r.tuPrecio - r.minPrecio)}${r.stock ? ` · tenés ${r.stock} en stock` : ''}`;
function pierdeText(p) {
  if (!p?.lista?.length) return [];
  return [pierdeTitulo(p).toUpperCase(), ...p.lista.map(r => `- ${r.title}: ${pierdeLinea(r)}`), `  Antes de bajar, mirá el costo en ${PANEL_URL}/reposicion`, ''];
}
function pierdeHtml(p) {
  if (!p?.lista?.length) return '';
  return `<h2 style="${H2};color:#b91c1c">${escapeHtml(pierdeTitulo(p))}</h2>
    <p style="font-size:13px;color:#666;margin:4px 0 8px">Libros que tenés en stock y otro vendedor ofrece más barato con entrega inmediata. Antes de bajar, mirá el costo en el panel.</p>
    ${p.lista.map(r => `<div style="border:1px solid #e5e2dd;border-left:4px solid #b91c1c;border-radius:6px;padding:12px 14px;margin:12px 0">
      <a href="${escapeHtml(bookLink(r.isbn))}" style="color:#222;font-weight:bold;font-size:15px;text-decoration:none">${escapeHtml(r.title)}</a>
      <table role="presentation" style="border-collapse:separate;border-spacing:0;margin-top:8px"><tr>${[cell('Tu precio', money(r.tuPrecio)), cell(r.vendedor ?? 'Competidor', money(r.minPrecio)), cell('Estás arriba', `${r.pct}%`), cell('Para igualar', `bajá ${money(r.tuPrecio - r.minPrecio)}`)].join('<td style="width:6px"></td>')}</tr></table>
    </div>`).join('')}`;
}

const DELIVERY = { pickup: 'retiro', shipping: 'envío' };
const PROVIDER = { mercadopago: 'Mercado Pago', bank_transfer: 'transferencia' };

function orderLink(code) {
  return `${PANEL_URL}/pedido/${encodeURIComponent(code)}`;
}

function line(row, extra = '') {
  return `${row.public_code} · ${firstName(row.buyer_name)} · ${money(row.payable_total_uyu)} · ${DELIVERY[row.delivery_type] || row.delivery_type}${extra}`;
}

/**
 * Arma el correo. Con `equipo: true` sale la versión para quien atiende la
 * tienda: pedidos, WhatsApp y estado del sistema, sin Brújula, competencia ni
 * montos de Mercado Libre (eso va en el correo del dueño).
 */
export function buildDigestEmail(data, { equipo = false } = {}) {
  const ship = data.toShip;
  const unpaid = data.unpaid;
  const wa = data.whatsapps || [];
  const brujula = equipo ? null : data.brujula;
  const competition = equipo ? null : data.competition;
  const pierde = equipo ? null : data.pierde;
  const ml = data.ml || null;
  const parts = [];
  if (ship.length) parts.push(`${ship.length} para despachar`);
  if (unpaid.length) parts.push(`${unpaid.length} sin pagar`);
  if (wa.length) parts.push(`${wa.length} ${wa.length === 1 ? 'cliente dejó' : 'clientes dejaron'} su WhatsApp`);
  const subject = parts.length
    ? `Amado Libros — hoy: ${parts.join(' y ')}`
    : 'Amado Libros — hoy no hay nada pendiente';
  const resumen = [...(pierde?.total ? [['Perdés por precio', pierde.total, '#b91c1c']] : []), ...resumenBrujula(brujula)];
  const mlText = ml ? `- Ventas en Mercado Libre: ${ml.count}${!equipo && ml.count ? ` (${money(ml.total)})` : ''}` : null;
  const compLabel = e => e.title ? `${e.title} (${e.isbn})` : e.isbn;

  const text = [
    'Buen día. Esto es lo que hay para hacer hoy en la tienda.',
    '',
    ...(resumen.length ? [`RESUMEN: ${resumen.map(([t, n]) => `${t}: ${n}`).join(' · ')}`, ''] : []),
    `PARA DESPACHAR (${ship.length})`,
    ...(ship.length ? ship.slice(0, MAX_ROWS).map(r => `- ${line(r)} — ${orderLink(r.public_code)}`) : ['- Nada pendiente. ¡Todo despachado!']),
    ...(ship.length > MAX_ROWS ? [`  … y ${ship.length - MAX_ROWS} más en el panel.`] : []),
    '',
    `SIN PAGAR — escribile al cliente (${unpaid.length})`,
    ...(unpaid.length
      ? unpaid.slice(0, MAX_ROWS).map(r => `- ${line(r, r.payment_provider ? ` · ${PROVIDER[r.payment_provider] || r.payment_provider}` : '')} — ${orderLink(r.public_code)}`)
      : ['- Ninguno. Todos los pedidos están pagos.']),
    ...(unpaid.length > MAX_ROWS ? [`  … y ${unpaid.length - MAX_ROWS} más en el panel.`] : []),
    unpaid.length ? '  En cada pedido hay un botón para escribirle por WhatsApp con el mensaje ya armado.' : '',
    '',
    ...(wa.length ? [
      `DEJARON SU WHATSAPP — escribiles (${wa.length})`,
      ...wa.slice(0, MAX_ROWS).map(r => `- +${r.whatsapp} · ${r.product_title} — https://wa.me/${r.whatsapp}`),
      ...(wa.length > MAX_ROWS ? [`  … y ${wa.length - MAX_ROWS} más.`] : []),
      '',
    ] : []),
    ...(data.systemProblems?.length ? ['SISTEMA — revisar', ...data.systemProblems.map(p => `- ${p}`), ''] : []),
    ...pierdeText(pierde),
    ...brujulaText(brujula),
    ...(competition ? ['COMPETENCIA EN MERCADO LIBRE', ...competition.eventos.map(e => `- ${compLabel(e)}: ${e.texto}`), `  Todo en ${PANEL_URL}/reposicion`, ''] : []),
    'AYER',
    `- Pedidos nuevos en la web: ${data.createdCount}`,
    `- Ventas cobradas en la web: ${data.soldCount}${data.soldCount ? ` (${money(data.soldTotal)})` : ''}`,
    mlText,
    '',
    `Abrir el panel: ${PANEL_URL}`,
  ].filter(item => item !== null).join('\n');

  const TD = 'padding:9px 8px;border-bottom:1px solid #eee';
  const rowsHtml = (rows, extra) => rows.slice(0, MAX_ROWS).map(r => `
    <tr><td style="${TD}"><a href="${escapeHtml(orderLink(r.public_code))}" style="color:#a94e3d;font-weight:bold;text-decoration:none">${escapeHtml(r.public_code)}</a></td>
        <td style="${TD}">${escapeHtml(firstName(r.buyer_name))}</td>
        <td style="${TD}">${escapeHtml(money(r.payable_total_uyu))}</td>
        <td style="${TD}">${escapeHtml(DELIVERY[r.delivery_type] || r.delivery_type)}${extra && extra(r) ? ` · ${escapeHtml(extra(r))}` : ''}</td></tr>`).join('');

  const section = (title, count, rows, empty, extra) => `
    <h2 style="${H2}">${escapeHtml(title)} <span style="color:#888;font-weight:normal">(${count})</span></h2>
    ${rows.length
      ? `<table style="border-collapse:collapse;width:100%;font-size:14px">${rowsHtml(rows, extra)}</table>${rows.length > MAX_ROWS ? `<p style="font-size:13px;color:#666">… y ${rows.length - MAX_ROWS} más en el panel.</p>` : ''}`
      : `<p style="color:#2e7d32;margin:4px 0">${escapeHtml(empty)}</p>`}`;

  const resumenHtml = resumen.length ? `<table role="presentation" style="border-collapse:separate;border-spacing:6px;margin:16px -6px 0"><tr>${resumen.map(([t, n, color]) =>
    `<td style="padding:10px 12px;background:#f6f4f1;border-top:3px solid ${color};border-radius:4px;text-align:center"><div style="font-size:22px;font-weight:bold;color:${color}">${n}</div><div style="font-size:12px;color:#555">${escapeHtml(t)}</div></td>`).join('')}</tr></table>` : '';

  const html = `<!doctype html><html lang="es"><body style="font-family:Arial,sans-serif;color:#222;line-height:1.5;max-width:680px;margin:0 auto;padding:16px">
    <h1 style="font-size:22px;margin:0 0 4px">Buen día</h1>
    <p style="margin:0;color:#555">Esto es lo que hay para hacer hoy en la tienda.</p>
    ${resumenHtml}
    ${section('Para despachar', ship.length, ship, 'Nada pendiente. ¡Todo despachado!')}
    ${section('Sin pagar: escribile al cliente', unpaid.length, unpaid, 'Ninguno. Todos los pedidos están pagos.', r => PROVIDER[r.payment_provider] || '')}
    ${unpaid.length ? '<p style="font-size:13px;color:#666">En cada pedido hay un botón para escribirle por WhatsApp con el mensaje ya armado.</p>' : ''}
    ${wa.length ? `<h2 style="${H2}">Dejaron su WhatsApp: escribiles <span style="color:#888;font-weight:normal">(${wa.length})</span></h2>
    <table style="border-collapse:collapse;width:100%;font-size:14px">${wa.slice(0, MAX_ROWS).map(r => `<tr><td style="${TD}"><a href="https://wa.me/${escapeHtml(r.whatsapp)}" style="color:#a94e3d;font-weight:bold;text-decoration:none">+${escapeHtml(r.whatsapp)}</a></td><td style="${TD}">${escapeHtml(r.product_title)}</td></tr>`).join('')}</table>` : ''}
    ${data.systemProblems?.length ? `<h2 style="${H2};color:#9a3412">Sistema: revisar</h2><ul>${data.systemProblems.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>` : ''}
    ${pierdeHtml(pierde)}
    ${brujulaHtml(brujula)}
    ${competition ? `<h2 style="${H2}">Competencia en Mercado Libre</h2>${competition.eventos.map(e => cardHtml({ isbn: e.isbn, title: e.title || e.isbn, detalle: e.texto }, '#b45309')).join('')}` : ''}
    <h2 style="${H2}">Ayer</h2>
    <table style="border-collapse:collapse;font-size:14px">
      <tr><td style="padding:4px 16px 4px 0">Pedidos nuevos en la web</td><td><strong>${data.createdCount}</strong></td></tr>
      <tr><td style="padding:4px 16px 4px 0">Ventas cobradas en la web</td><td><strong>${data.soldCount}</strong>${data.soldCount ? ` (${escapeHtml(money(data.soldTotal))})` : ''}</td></tr>
      ${ml ? `<tr><td style="padding:4px 16px 4px 0">Ventas en Mercado Libre</td><td><strong>${ml.count}</strong>${!equipo && ml.count ? ` (${escapeHtml(money(ml.total))})` : ''}</td></tr>` : ''}
    </table>
    <p style="margin:28px 0"><a href="${PANEL_URL}" style="display:inline-block;padding:12px 20px;background:#a94e3d;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">Abrir el panel</a></p>
  </body></html>`;
  return { subject, text, html };
}

const lista = value => cleanString(value).split(/[,;]+/).map(item => item.trim()).filter(Boolean);
function recipients(env) {
  return lista(env?.DAILY_DIGEST_TO);
}

async function sendEmail({ apiKey, from, to, email, idempotencyKey }, fetchFn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);
  try {
    const response = await fetchFn(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ scheduled_at: nextInternalEmailAt(), from, to, ...email }),
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, status: 0, error: error?.name || 'Error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Manda el correo del día. Devuelve un estado corto, nunca lanza.
 * `skipped`: ya se mandó hoy, o falta configuración. `failed`: Resend no lo
 * aceptó (la reserva se libera para que el segundo cron del día lo reintente).
 */
export async function sendDailyPanelDigest(env, { now = new Date(), fetchFn = globalThis.fetch, test = false } = {}) {
  const apiKey = cleanString(env?.RESEND_API_KEY);
  const from = cleanString(env?.SALES_NOTIFICATION_FROM);
  const to = recipients(env);
  if (!apiKey || !from || !to.length || !env?.ORDERS_DB) return { status: 'skipped', reason: 'config' };

  const today = montevideoDay(now).date;
  const claimKey = `digest:panel:${today}`;
  // Una prueba manual no gasta ni libera la reserva del día: el correo real de
  // las 20:00 sale igual.
  const useClaim = Boolean(env.AMADO_KV) && !test;
  if (useClaim) {
    if (await env.AMADO_KV.get(claimKey)) return { status: 'skipped', reason: 'already_sent' };
    await env.AMADO_KV.put(claimKey, now.toISOString(), { expirationTtl: 3 * 86_400 });
  }

  try {
    const catalog = await env.CATALOG_R2?.get('catalog.json').then(obj => (obj ? obj.json() : null)).catch(() => null);
    const data = await loadDigestData(env.ORDERS_DB, now, { catalog });
    // Con DAILY_BRUJULA_TO son dos correos: el corto para quien atiende la
    // tienda y el completo (Brújula, competencia, montos) para el dueño. Sin
    // esa variable sale uno solo, completo, a todos.
    const owner = lista(env?.DAILY_BRUJULA_TO);
    const email = buildDigestEmail(data, { equipo: owner.length > 0 });
    if (test) email.subject = `[PRUEBA] ${email.subject}`;
    let result = await sendEmail({ apiKey, from, to, email, idempotencyKey: test ? `panel-digest-test/${now.toISOString()}` : `panel-digest/${today}` }, fetchFn);
    if (result.ok && owner.length) {
      const full = buildDigestEmail(data);
      full.subject = `${test ? '[PRUEBA] ' : ''}${full.subject.replace('Amado Libros —', 'Brújula Amado —')}`;
      result = await sendEmail({ apiKey, from, to: owner, email: full, idempotencyKey: test ? `panel-brujula-test/${now.toISOString()}` : `panel-brujula/${today}` }, fetchFn);
    }
    if (result.ok) return { status: 'sent', toShip: data.toShip.length, unpaid: data.unpaid.length, correos: owner.length ? 2 : 1 };
    if (useClaim) await env.AMADO_KV.delete(claimKey);
    console.warn('[panel digest] Resend no lo aceptó', { status: result.status, error: result.error });
    return { status: 'failed' };
  } catch (error) {
    if (useClaim) await env.AMADO_KV.delete(claimKey);
    console.warn('[panel digest] error', error?.name || 'Error');
    return { status: 'failed' };
  }
}
