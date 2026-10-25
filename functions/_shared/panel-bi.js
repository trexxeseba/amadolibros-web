/**
 * Inteligencia de negocio del panel (/panel/inteligencia): cómo va el negocio,
 * qué funciona y dónde se pierde plata, con los datos que ya están en D1
 * (ventas ML, pedidos web, compras, competencia) y el stock de catalog.json.
 *
 * Cada bloque se calcula aparte: si uno falla, ese recuadro lo dice y el resto
 * anda. Las consultas agregan en SQL o traen pocas filas (el panel corre en
 * Pages, con tope de consultas a D1 por request).
 */
import { COUNTED_STATUSES } from '../../worker-sync/ml-sales.js';
import { ownStockIndex } from '../../worker-sync/reposicion-facts.js';
import { competitionByIsbn } from '../../worker-sync/ml-competition.js';
import { bookIsbn } from '../../worker-sync/isbn.js';

const DAY = 86400000;
const COUNTED = COUNTED_STATUSES.map(s => `'${s}'`).join(',');
const LEAD_DAYS = 15;

async function rows(db, sql, ...args) {
  const st = db.prepare(sql);
  return (await (args.length ? st.bind(...args) : st).all()).results ?? [];
}
async function section(fn) {
  try { return { ok: true, data: await fn() }; } catch (error) { return { ok: false, error: error?.message || 'error' }; }
}
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);

// Resumen ejecutivo: últimos 7 y 30 días contra el período anterior.
export async function loadKpis(db, now) {
  const [r] = await rows(db, `SELECT
    SUM(CASE WHEN o.date_created_ms>=p.a THEN i.quantity ELSE 0 END) AS u7,
    SUM(CASE WHEN o.date_created_ms>=p.b AND o.date_created_ms<p.a THEN i.quantity ELSE 0 END) AS u7p,
    SUM(CASE WHEN o.date_created_ms>=p.c THEN i.quantity ELSE 0 END) AS u30,
    SUM(CASE WHEN o.date_created_ms>=p.d AND o.date_created_ms<p.c THEN i.quantity ELSE 0 END) AS u30p,
    SUM(CASE WHEN o.date_created_ms>=p.a AND i.currency_id='UYU' THEN i.quantity*i.unit_price ELSE 0 END) AS r7,
    SUM(CASE WHEN o.date_created_ms>=p.b AND o.date_created_ms<p.a AND i.currency_id='UYU' THEN i.quantity*i.unit_price ELSE 0 END) AS r7p,
    SUM(CASE WHEN o.date_created_ms>=p.c AND i.currency_id='UYU' THEN i.quantity*i.unit_price ELSE 0 END) AS r30,
    SUM(CASE WHEN o.date_created_ms>=p.d AND o.date_created_ms<p.c AND i.currency_id='UYU' THEN i.quantity*i.unit_price ELSE 0 END) AS r30p,
    COUNT(DISTINCT CASE WHEN o.date_created_ms>=p.c THEN o.order_id END) AS o30,
    COUNT(DISTINCT CASE WHEN o.date_created_ms>=p.c THEN COALESCE(i.isbn,i.item_id) END) AS t30,
    SUM(CASE WHEN o.date_created_ms>=p.c AND i.seller_sku LIKE 'AMADO-AR-%' THEN i.quantity ELSE 0 END) AS enc30
    FROM (SELECT ? AS a, ? AS b, ? AS c, ? AS d) p, ml_sales_items i JOIN ml_sales_orders o ON o.order_id=i.order_id
    WHERE o.status IN (${COUNTED}) AND o.date_created_ms>=p.d`, now - 7 * DAY, now - 14 * DAY, now - 30 * DAY, now - 60 * DAY);
  const n = k => Number(r?.[k]) || 0;
  let web = { orders: 0, total: 0 };
  try {
    const [w] = await rows(db, `SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(paid_amount_uyu,payable_total_uyu)),0) AS t FROM orders WHERE payment_status='approved' AND paid_at>=?`, new Date(now - 30 * DAY).toISOString());
    web = { orders: Number(w?.n) || 0, total: Number(w?.t) || 0 };
  } catch { /* sin tabla de pedidos web en este entorno */ }
  return {
    u7: n('u7'), u7Delta: pct(n('u7'), n('u7p')), r7: n('r7'), r7Delta: pct(n('r7'), n('r7p')),
    u30: n('u30'), u30Delta: pct(n('u30'), n('u30p')), r30: n('r30'), r30Delta: pct(n('r30'), n('r30p')),
    orders30: n('o30'), titles30: n('t30'), ticket30: n('o30') ? Math.round(n('r30') / n('o30')) : 0,
    encargoPct30: n('u30') ? Math.round((n('enc30') / n('u30')) * 100) : 0, web,
  };
}

// Ventas por semana (26 semanas), la semana 0 es la actual.
export async function loadWeekly(db, now, weeks = 26) {
  const r = await rows(db, `SELECT CAST((p.a-o.date_created_ms)/604800000 AS INTEGER) AS w, SUM(i.quantity) AS u,
    SUM(CASE WHEN i.currency_id='UYU' THEN i.quantity*i.unit_price ELSE 0 END) AS rev
    FROM (SELECT ? AS a, ? AS b) p, ml_sales_items i JOIN ml_sales_orders o ON o.order_id=i.order_id
    WHERE o.status IN (${COUNTED}) AND o.date_created_ms>p.b GROUP BY w`, now, now - weeks * 7 * DAY);
  const byW = new Map(r.map(x => [Number(x.w), x]));
  return Array.from({ length: weeks }, (_, k) => {
    const w = weeks - 1 - k, x = byW.get(w);
    return { start: new Date(now - (w + 1) * 7 * DAY).toISOString().slice(0, 10), units: Number(x?.u) || 0, revenue: Math.round(Number(x?.rev) || 0) };
  });
}

// Ventas por ISBN (365 días) + stock + títulos y editoriales del catálogo.
export async function loadBookTable(db, catalog, now) {
  const sales = await rows(db, `SELECT i.isbn, SUM(i.quantity) AS u365,
    SUM(CASE WHEN o.date_created_ms>=p.b THEN i.quantity ELSE 0 END) AS u90,
    SUM(CASE WHEN o.date_created_ms>=p.c THEN i.quantity ELSE 0 END) AS u180,
    SUM(CASE WHEN i.currency_id='UYU' THEN i.quantity*i.unit_price ELSE 0 END) AS rev365,
    SUM(CASE WHEN o.date_created_ms>=p.b AND i.currency_id='UYU' THEN i.quantity*i.unit_price ELSE 0 END) AS rev90,
    MAX(o.date_created_ms) AS last_ms, MAX(i.title) AS title
    FROM (SELECT ? AS a, ? AS b, ? AS c) p, ml_sales_items i JOIN ml_sales_orders o ON o.order_id=i.order_id
    WHERE o.status IN (${COUNTED}) AND o.date_created_ms>=p.a AND i.isbn IS NOT NULL GROUP BY i.isbn`, now - 365 * DAY, now - 90 * DAY, now - 180 * DAY);
  const stock = ownStockIndex(catalog);
  const meta = new Map();
  for (const item of Array.isArray(catalog?.items) ? catalog.items : []) {
    const isbn = bookIsbn(item?.isbn);
    if (!isbn) continue;
    const m = meta.get(isbn) ?? { title: item.title, publisher: item.publisher || null, start: item.start_time || null };
    if (item.start_time && (!m.start || item.start_time < m.start)) m.start = item.start_time;
    meta.set(isbn, m);
  }
  const books = sales.map(s => ({
    isbn: s.isbn, title: meta.get(s.isbn)?.title || s.title, publisher: meta.get(s.isbn)?.publisher || null,
    u365: Number(s.u365) || 0, u180: Number(s.u180) || 0, u90: Number(s.u90) || 0, rev365: Math.round(Number(s.rev365) || 0), rev90: Math.round(Number(s.rev90) || 0),
    lastMs: Number(s.last_ms) || null, stock: stock.get(s.isbn)?.stock_propio ?? 0,
  }));
  return { books, stock, meta };
}

// ABC por facturación de 365 días: A = 80%, B = hasta 95%, C = el resto.
export function abc(books) {
  const sorted = [...books].sort((a, b) => b.rev365 - a.rev365);
  const total = sorted.reduce((n, b) => n + b.rev365, 0) || 1;
  let acc = 0;
  for (const b of sorted) { acc += b.rev365; b.clase = acc / total <= 0.8 || b === sorted[0] ? 'A' : acc / total <= 0.95 ? 'B' : 'C'; }
  const count = c => sorted.filter(b => b.clase === c).length;
  const share = c => Math.round((sorted.filter(b => b.clase === c).reduce((n, b) => n + b.rev365, 0) / total) * 100);
  return { A: count('A'), B: count('B'), C: count('C'), shareA: share('A'), total: sorted.length, sorted };
}

// Salud del inventario: A sin stock, cobertura baja, stock muerto.
export function inventoryHealth({ books, stock, meta }, now) {
  const A = books.filter(b => b.clase === 'A');
  const aSinStock = A.filter(b => b.stock === 0).sort((a, b) => b.u90 - a.u90);
  const coberturaBaja = A.filter(b => b.stock > 0 && b.u90 > 0).map(b => ({ ...b, dias: Math.round(b.stock / (b.u90 / 90)) }))
    .filter(b => b.dias < LEAD_DAYS * 2).sort((a, b) => a.dias - b.dias);
  const vendidos180 = new Set(books.filter(b => b.u180 > 0).map(b => b.isbn));
  const muerto = [];
  for (const [isbn, s] of stock) {
    if (s.stock_propio <= 0 || vendidos180.has(isbn)) continue;
    const start = meta.get(isbn)?.start;
    if (start && now - Date.parse(start) < 180 * DAY) continue; // publicado hace poco: todavía no es "muerto"
    muerto.push({ isbn, title: meta.get(isbn)?.title, stock: s.stock_propio, start });
  }
  muerto.sort((a, b) => b.stock - a.stock);
  return {
    aSinStock: aSinStock.slice(0, 15), aSinStockCount: aSinStock.length,
    ventaPerdidaMes: Math.round(aSinStock.reduce((n, b) => n + b.u90 / 3, 0)),
    coberturaBaja: coberturaBaja.slice(0, 15), coberturaBajaCount: coberturaBaja.length,
    muerto: muerto.slice(0, 15), muertoCount: muerto.length, muertoUnidades: muerto.reduce((n, b) => n + b.stock, 0),
  };
}

// Rendimiento de compras de los últimos 90 días: cuánto de lo comprado ya se vendió.
export async function loadPurchasePerformance(db, now) {
  const since = now - 90 * DAY;
  const lines = await rows(db, `SELECT o.supplier, i.isbn, o.purchase_date_ms AS d, i.quantity AS q FROM purchase_items i JOIN purchase_orders o ON o.purchase_id=i.purchase_id
    WHERE o.superseded_by IS NULL AND COALESCE(o.purpose,'stock')<>'encargo_cliente' AND COALESCE(o.document_type,'invoice')<>'credit_note' AND o.purchase_date_ms>=? AND i.isbn IS NOT NULL`, since);
  if (!lines.length) return { suppliers: [] };
  const isbns = [...new Set(lines.map(l => l.isbn))];
  const sales = await rows(db, `SELECT i.isbn, o.date_created_ms AS d, i.quantity AS q FROM ml_sales_items i JOIN ml_sales_orders o ON o.order_id=i.order_id
    WHERE o.status IN (${COUNTED}) AND o.date_created_ms>=? AND i.isbn IN (SELECT value FROM json_each(?)) AND (i.seller_sku IS NULL OR i.seller_sku NOT LIKE 'AMADO-AR-%')`, since, JSON.stringify(isbns));
  const by = new Map();
  for (const l of lines) {
    const s = by.get(l.supplier) ?? { supplier: l.supplier, bought: 0, sold: 0, titles: new Set(), sinVenta: 0 };
    const vendido = sales.filter(x => x.isbn === l.isbn && x.d >= l.d).reduce((n, x) => n + Number(x.q), 0);
    s.bought += Number(l.q); s.sold += Math.min(Number(l.q), vendido); s.titles.add(l.isbn);
    if (!vendido) s.sinVenta++;
    by.set(l.supplier, s);
  }
  return { suppliers: [...by.values()].map(s => ({ supplier: s.supplier, bought: s.bought, sold: s.sold, titles: s.titles.size, sinVenta: s.sinVenta, sellThrough: s.bought ? Math.round((s.sold / s.bought) * 100) : 0 }))
    .sort((a, b) => b.bought - a.bought) };
}

export function topPublishers(books, limit = 10) {
  const by = new Map();
  for (const b of books) {
    if (!b.publisher || b.u90 <= 0) continue;
    const key = b.publisher.trim().toUpperCase();
    const p = by.get(key) ?? { publisher: b.publisher.trim(), units: 0, revenue: 0, titles: 0 };
    p.units += b.u90; p.revenue += b.rev90; p.titles++;
    by.set(key, p);
  }
  return [...by.values()].sort((a, b) => b.revenue - a.revenue).slice(0, limit);
}

// Posición competitiva en los productos de catálogo vigilados.
export async function loadCompetitivePosition(db) {
  const targets = await rows(db, 'SELECT isbn FROM comp_targets');
  if (!targets.length) return null;
  const facts = await competitionByIsbn(db, targets.map(t => t.isbn));
  const list = [...facts.values()];
  const conEstado = list.filter(f => f.primer_lugar);
  const ganando = conEstado.filter(f => f.primer_lugar === 'winning').length;
  const rels = list.map(f => f.precio_relativo).filter(Boolean).sort((a, b) => a - b);
  const mediana = rels.length ? rels[Math.floor(rels.length / 2)] : null;
  return {
    vigilados: list.length, conEstado: conEstado.length, ganando, ganandoPct: conEstado.length ? Math.round((ganando / conEstado.length) * 100) : null,
    solos: list.filter(f => f.competidores === 0).length, medianaPrecio: mediana,
    masCaros: list.filter(f => f.precio_relativo && f.precio_relativo >= 1.15).length,
  };
}

export async function loadBi(db, catalog, now = Date.now()) {
  const [kpis, weekly, table, compras, competencia] = await Promise.all([
    section(() => loadKpis(db, now)),
    section(() => loadWeekly(db, now)),
    section(() => loadBookTable(db, catalog, now)),
    section(() => loadPurchasePerformance(db, now)),
    section(() => loadCompetitivePosition(db)),
  ]);
  let abcRes = { ok: false, error: table.error }, inv = { ok: false, error: table.error }, pubs = { ok: false, error: table.error };
  if (table.ok) {
    abcRes = await section(() => abc(table.data.books));
    inv = await section(() => inventoryHealth(table.data, now));
    pubs = await section(() => topPublishers(table.data.books));
  }
  return { generado: new Date(now).toISOString(), kpis, weekly, abc: abcRes, inventario: inv, compras, editoriales: pubs, competencia };
}
