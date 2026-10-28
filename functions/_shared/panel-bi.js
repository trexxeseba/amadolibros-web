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
import { latestFx } from '../../worker-sync/fx-rates.js';
import { longTailReview, loadVisitsIndex } from '../../worker-sync/long-tail.js';

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
  const [e] = await rows(db, `SELECT COALESCE(SUM(i.quantity),0) AS u, MAX(o.date_created_ms) AS last FROM ml_sales_items i JOIN ml_sales_orders o ON o.order_id=i.order_id
    WHERE o.status IN (${COUNTED}) AND o.date_created_ms>=? AND i.seller_sku LIKE 'AMADO-AR-%'`, now - 365 * DAY);
  let web = { orders: 0, total: 0 };
  try {
    const [w] = await rows(db, `SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(paid_amount_uyu,payable_total_uyu)),0) AS t FROM orders WHERE payment_status='approved' AND paid_at>=?`, new Date(now - 30 * DAY).toISOString());
    web = { orders: Number(w?.n) || 0, total: Number(w?.t) || 0 };
  } catch { /* sin tabla de pedidos web en este entorno */ }
  return {
    u7: n('u7'), u7Delta: pct(n('u7'), n('u7p')), r7: n('r7'), r7Delta: pct(n('r7'), n('r7p')),
    u30: n('u30'), u30Delta: pct(n('u30'), n('u30p')), r30: n('r30'), r30Delta: pct(n('r30'), n('r30p')),
    orders30: n('o30'), titles30: n('t30'), ticket30: n('o30') ? Math.round(n('r30') / n('o30')) : 0,
    encargoPct30: n('u30') ? Math.round((n('enc30') / n('u30')) * 100) : 0, enc30: n('enc30'),
    enc365: Number(e?.u) || 0, encLastMs: Number(e?.last) || null, web,
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

// En catalog.json la editorial cae a la marca de la publicación (BRAND = Amado
// Libros) cuando ML la guarda en BOOK_PUBLISHER. La real sale de la identidad
// de cada venta (atributos de ML) o de las facturas del proveedor.
const PLACEHOLDER_PUBLISHER = /^(amado|gen[eé]ric|sin editorial|otros?$|varios$)/i;
export const realPublisher = v => { const t = String(v ?? '').trim(); return t && !PLACEHOLDER_PUBLISHER.test(t) ? t : null; };

async function publisherIndex(db) {
  const votes = new Map();
  const add = (list, weight) => { for (const r of list) { const pub = realPublisher(r.publisher); if (!pub) continue; const m = votes.get(r.isbn) ?? new Map(); m.set(pub, (m.get(pub) ?? 0) + Number(r.n) * weight); votes.set(r.isbn, m); } };
  try { add(await rows(db, 'SELECT isbn, publisher, COUNT(*) AS n FROM ml_sales_item_identity WHERE isbn IS NOT NULL AND publisher IS NOT NULL GROUP BY isbn, publisher'), 2); } catch { /* sin tabla */ }
  try { add(await rows(db, 'SELECT isbn, publisher, COUNT(*) AS n FROM purchase_items WHERE isbn IS NOT NULL AND publisher IS NOT NULL GROUP BY isbn, publisher'), 1); } catch { /* sin tabla */ }
  const out = new Map();
  for (const [isbn, m] of votes) out.set(isbn, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  return out;
}

// Ventas por ISBN (365 días) + stock + títulos del catálogo y editorial real.
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
  const pubIndex = await publisherIndex(db);
  const meta = new Map();
  for (const item of Array.isArray(catalog?.items) ? catalog.items : []) {
    const isbn = bookIsbn(item?.isbn);
    if (!isbn) continue;
    const m = meta.get(isbn) ?? { title: item.title, publisher: realPublisher(item.publisher), start: item.start_time || null };
    if (item.start_time && (!m.start || item.start_time < m.start)) m.start = item.start_time;
    meta.set(isbn, m);
  }
  const books = sales.map(s => ({
    isbn: s.isbn, title: meta.get(s.isbn)?.title || s.title, publisher: pubIndex.get(s.isbn) || meta.get(s.isbn)?.publisher || null,
    u365: Number(s.u365) || 0, u180: Number(s.u180) || 0, u90: Number(s.u90) || 0, rev365: Math.round(Number(s.rev365) || 0), rev90: Math.round(Number(s.rev90) || 0),
    avgPrice: Number(s.u90) ? Math.round((Number(s.rev90) || 0) / Number(s.u90)) : Number(s.u365) ? Math.round((Number(s.rev365) || 0) / Number(s.u365)) : null, lastMs: Number(s.last_ms) || null, stock: stock.get(s.isbn)?.stock_propio ?? 0,
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
    solos: list.filter(f => !(f.competidores_inmediatos ?? f.competidores_comparables) && f.tu_precio != null).length, medianaPrecio: mediana,
    masCaros: list.filter(f => f.precio_relativo && f.precio_relativo >= 1.15).length,
    facts,
  };
}

// Libros que vendés muy por debajo del competidor nacional más barato (nuevo):
// precio sugerido apenas debajo de él y cuánto más entraría por mes al ritmo
// de los últimos 90 días. Los agotados entran con su precio promedio de venta
// (es el precio al que se volvería a publicar). Sólo sugiere: no cambia precios.
const RAISE_THRESHOLD = 0.85, RAISE_UNDERCUT = 0.98;
const round10 = v => Math.floor(v / 10) * 10;

export function priceRaises(facts, books, model = null) {
  if (!facts) return null;
  const byIsbn = new Map(books.map(b => [b.isbn, b]));
  const lista = [], solos = [];
  for (const [isbn, f] of facts) {
    const b = byIsbn.get(isbn);
    if (!b) continue;
    // Hay inmediatos con otro tipo de envío: ni "solo" ni comparable; no se sugiere.
    if ((f.competidores_inmediatos ?? 0) > 0 && !f.competidores_comparables) continue;
    const c = model?.costs.get(isbn);
    // Nadie más lo tiene con entrega inmediata. Si los que lo venden a pedido
    // cobran mucho más, el precio sugerido sale de ellos; si no, probar +10%.
    const aPedido = f.precio_minimo_a_pedido;
    if (!f.competidores_comparables && f.tu_precio > 0 && aPedido > 0 && f.tu_precio / aPedido <= RAISE_THRESHOLD) {
      const sugerido = Math.max(f.tu_precio, round10(aPedido * RAISE_UNDERCUT));
      lista.push({ isbn, title: b.title, actual: f.tu_precio, min: aPedido, aPedido: true, competidores: f.competidores_a_pedido, sugerido,
        subaPct: Math.round((sugerido / f.tu_precio - 1) * 100), ganaMes: Math.round((sugerido - f.tu_precio) * b.u90 / 3), u90: b.u90, stock: b.stock, agotado: !(b.stock > 0),
        margenActual: c ? marginOf(f.tu_precio, c.cost, model.feeRate) : null, margenSugerido: c ? marginOf(sugerido, c.cost, model.feeRate) : null });
      continue;
    }
    if (!f.competidores_comparables && f.tu_precio > 0) {
      const sugerido = round10(f.tu_precio * 1.1);
      solos.push({ isbn, title: b.title, actual: f.tu_precio, sugerido, u90: b.u90, stock: b.stock, ganaMes: Math.round((sugerido - f.tu_precio) * b.u90 / 3) });
      continue;
    }
    const min = f.precio_minimo, actual = f.tu_precio ?? b.avgPrice;
    if (!(min > 0) || !(actual > 0) || actual / min > RAISE_THRESHOLD) continue;
    const sugerido = Math.max(actual, round10(min * RAISE_UNDERCUT));
    lista.push({
      isbn, title: b.title, actual, min, competidores: f.competidores_comparables, sugerido,
      subaPct: Math.round((sugerido / actual - 1) * 100), ganaMes: Math.round((sugerido - actual) * b.u90 / 3),
      u90: b.u90, stock: b.stock, agotado: !(b.stock > 0),
      margenActual: c ? marginOf(actual, c.cost, model.feeRate) : null, margenSugerido: c ? marginOf(sugerido, c.cost, model.feeRate) : null,
    });
  }
  lista.sort((a, b) => b.ganaMes - a.ganaMes || b.subaPct - a.subaPct);
  solos.sort((a, b) => b.ganaMes - a.ganaMes);
  return {
    total: lista.length, conStock: lista.filter(x => !x.agotado).length,
    ganaMesTotal: lista.reduce((n, x) => n + x.ganaMes, 0), lista: lista.slice(0, 40),
    solos: solos.slice(0, 15), solosTotal: solos.length, umbral: RAISE_THRESHOLD,
  };
}

// Margen por libro: precio de venta − comisión de ML − costo de la última
// compra. El costo lleva el descuento de la línea y el reparto de lo que la
// factura suma o resta (envío, gastos) y se pasa a pesos al cambio de hoy:
// es lo que costaría reponerlo. No incluye el flete hasta Uruguay ni el envío
// que paga el vendedor en ML.
const OVERHEAD_MIN = 0.85, OVERHEAD_MAX = 1.6, DEFAULT_FEE_SAMPLE = 5;

export async function loadCostModel(db, isbns) {
  const fx = await latestFx(db);
  const costs = new Map();
  if (isbns.length) {
    const lines = await rows(db, `SELECT i.isbn, i.unit_price, i.discount_pct, i.quantity, o.purchase_id, o.supplier, o.currency, o.total_amount, o.purchase_date_ms AS d, t.net
      FROM purchase_items i JOIN purchase_orders o ON o.purchase_id=i.purchase_id
      LEFT JOIN (SELECT purchase_id, SUM(unit_price*(1-COALESCE(discount_pct,0)/100.0)*quantity) AS net FROM purchase_items WHERE unit_price IS NOT NULL GROUP BY purchase_id) t ON t.purchase_id=o.purchase_id
      WHERE o.superseded_by IS NULL AND COALESCE(o.document_type,'invoice')<>'credit_note' AND i.unit_price IS NOT NULL AND i.unit_price>0 AND o.currency IS NOT NULL
        AND i.isbn IN (SELECT value FROM json_each(?))`, JSON.stringify(isbns));
    for (const l of lines) {
      const rate = fx[String(l.currency).toUpperCase()];
      if (!rate) continue;
      const prev = costs.get(l.isbn);
      if (prev && prev.d >= Number(l.d)) continue;
      const net = Number(l.unit_price) * (1 - (Number(l.discount_pct) || 0) / 100);
      let overhead = Number(l.total_amount) > 0 && Number(l.net) > 0 ? Number(l.total_amount) / Number(l.net) : 1;
      overhead = Math.min(OVERHEAD_MAX, Math.max(OVERHEAD_MIN, overhead));
      costs.set(l.isbn, { cost: Math.round(net * overhead * rate), supplier: l.supplier, currency: l.currency, d: Number(l.d) });
    }
  }
  // Comisión de ML: mediana de comisión/precio en las ventas de una unidad que ya la traen.
  let feeRate = null, feeSample = 0;
  try {
    const f = await rows(db, `SELECT sale_fee*1.0/unit_price AS r FROM ml_sales_items WHERE sale_fee IS NOT NULL AND sale_fee>0 AND unit_price>0 AND quantity=1 ORDER BY updated_at DESC LIMIT 500`);
    const rs = f.map(x => Number(x.r)).filter(r => r > 0 && r < 0.5).sort((a, b) => a - b);
    feeSample = rs.length;
    if (rs.length >= DEFAULT_FEE_SAMPLE) feeRate = rs[Math.floor(rs.length / 2)];
  } catch { /* columna todavía sin crear */ }
  return { costs, fx, feeRate, feeSample };
}

export function marginOf(price, cost, feeRate) {
  if (!(price > 0) || !(cost > 0)) return null;
  const fee = feeRate == null ? 0 : Math.round(price * feeRate);
  const margin = price - fee - cost;
  return { price, fee, cost, margin, pct: Math.round((margin / price) * 100), feeKnown: feeRate != null };
}

export function marginSummary(books, model) {
  const withCost = [];
  for (const b of books) {
    const c = model.costs.get(b.isbn);
    const m = c ? marginOf(b.avgPrice, c.cost, model.feeRate) : null;
    if (m) withCost.push({ ...b, ...m, supplier: c.supplier });
  }
  const A = withCost.filter(b => b.clase === 'A');
  const rev = A.reduce((n, b) => n + b.price * b.u365, 0), marg = A.reduce((n, b) => n + b.margin * b.u365, 0);
  return {
    feeRate: model.feeRate, feeSample: model.feeSample, fxDate: model.fx._date ?? null,
    conCosto: withCost.length, conCostoA: A.length, totalA: books.filter(b => b.clase === 'A').length,
    margenPctA: rev ? Math.round((marg / rev) * 100) : null,
    bajoMargen: A.filter(b => b.pct < 15).length, perdida: A.filter(b => b.margin < 0).length,
    top: [...A].sort((a, b) => b.margin * b.u365 - a.margin * a.u365).slice(0, 10),
    peores: [...A].sort((a, b) => a.pct - b.pct).slice(0, 10),
  };
}

// Libros A sin stock: ¿alguien lo vende hoy en ML desde Uruguay, a qué precio,
// y dónde lo compramos la última vez? Con eso se decide si conviene reponer.
export async function loadSinStockMarket(db, aSinStock, model = null) {
  const isbns = aSinStock.map(b => b.isbn);
  const facts = await competitionByIsbn(db, isbns);
  const compra = new Map();
  try {
    for (const r of await rows(db, `SELECT i.isbn, o.supplier, MAX(o.purchase_date_ms) AS d FROM purchase_items i JOIN purchase_orders o ON o.purchase_id=i.purchase_id
      WHERE o.superseded_by IS NULL AND COALESCE(o.document_type,'invoice')<>'credit_note' AND i.isbn IN (SELECT value FROM json_each(?)) GROUP BY i.isbn, o.supplier`, JSON.stringify(isbns))) {
      if (!compra.has(r.isbn) || compra.get(r.isbn).d < r.d) compra.set(r.isbn, { supplier: r.supplier, d: Number(r.d) });
    }
  } catch { /* sin compras */ }
  const resumen = { vigilados: 0, solo: 0, sostenible: 0, masBarato: 0, noConviene: 0 };
  const verdict = b => {
    const f = facts.get(b.isbn);
    if (!f) return { estado: 'sin_dato' };
    resumen.vigilados++;
    const nacionales = f.competidores_inmediatos ?? f.competidores_comparables ?? 0, min = f.precio_minimo;
    if (!nacionales) { resumen.solo++; return { estado: 'solo', nacionales: 0, texto: `No detectamos otra oferta con entrega inmediata verificada en la ficha de ML${f.competidores_a_pedido ? ` (${f.competidores_a_pedido} lo venden a pedido)` : ''}: reponer y quedarte con la venta.` }; }
    if (min == null) return { estado: 'sin_dato', texto: 'Hay vendedores con stock verificado, pero falta un precio comparable con el mismo envío. Revisar antes de reponer.' };
    const c = model?.costs.get(b.isbn), atMin = c ? marginOf(min, c.cost, model.feeRate) : null;
    if (atMin) {
      if (atMin.margin > 0) { resumen.sostenible++; return { estado: 'sostenible', nacionales, min, margenAlMin: atMin.margin, texto: `${nacionales} lo tienen con entrega inmediata; al precio del más barato todavía ganás $ ${atMin.margin.toLocaleString('es-UY')} por libro: conviene reponer.` }; }
      resumen.noConviene++; return { estado: 'no_conviene', nacionales, min, margenAlMin: atMin.margin, texto: `${nacionales} lo tienen con entrega inmediata; al precio del más barato perdés $ ${Math.abs(atMin.margin).toLocaleString('es-UY')} por libro: no conviene reponerlo a este costo.` };
    }
    if (!b.avgPrice || min >= b.avgPrice * 0.9) { resumen.sostenible++; return { estado: 'sostenible', nacionales, min, texto: `${nacionales} lo tienen con entrega inmediata, el más barato a tu precio de siempre o más: conviene reponer.` }; }
    resumen.masBarato++;
    return { estado: 'mas_barato', nacionales, min, texto: `${nacionales} lo tienen con entrega inmediata más barato que tu precio promedio: reponer sólo si el costo da.` };
  };
  return { libros: aSinStock.map(b => { const c = model?.costs.get(b.isbn); return { isbn: b.isbn, mercado: verdict(b), compra: compra.get(b.isbn) ?? null, costo: c?.cost ?? null, margen: c ? marginOf(b.avgPrice, c.cost, model.feeRate) : null }; }), resumen };
}

export async function loadBi(db, catalog, now = Date.now()) {
  const [kpis, weekly, table, compras, competencia] = await Promise.all([
    section(() => loadKpis(db, now)),
    section(() => loadWeekly(db, now)),
    section(() => loadBookTable(db, catalog, now)),
    section(() => loadPurchasePerformance(db, now)),
    section(() => loadCompetitivePosition(db)),
  ]);
  let abcRes = { ok: false, error: table.error }, inv = { ok: false, error: table.error }, pubs = { ok: false, error: table.error }, margen = { ok: false, error: table.error }, precios = { ok: false, error: table.error ?? competencia.error };
  if (table.ok) {
    abcRes = await section(() => abc(table.data.books));
    inv = await section(() => inventoryHealth(table.data, now));
    pubs = await section(() => topPublishers(table.data.books));
    const model = await section(() => loadCostModel(db, table.data.books.map(b => b.isbn)));
    margen = model.ok ? await section(() => marginSummary(table.data.books, model.data)) : { ok: false, error: model.error };
    if (competencia.ok) precios = await section(() => priceRaises(competencia.data?.facts, table.data.books, model.ok ? model.data : null));
    if (inv.ok) {
      const A = table.data.books.filter(b => b.clase === 'A' && b.stock === 0).sort((a, b) => b.u90 - a.u90);
      const market = await section(() => loadSinStockMarket(db, A, model.ok ? model.data : null));
      if (market.ok) {
        const by = new Map(market.data.libros.map(l => [l.isbn, l]));
        inv.data.aSinStock = inv.data.aSinStock.map(b => ({ ...b, ...by.get(b.isbn) }));
        inv.data.mercado = market.data.resumen;
      }
    }
  }
  // Long tail: cómo está cada título (quiebre, con ventas, lentas, sin evidencia,
  // poca exposición, visitas sin conversión) y parejas catálogo / no catálogo.
  let longTail = { ok: false, error: table.error };
  if (table.ok) {
    longTail = await section(async () => {
      const visits = await loadVisitsIndex(db, now);
      let ventanaCompleta = true;
      try { const f = await db.prepare('SELECT MIN(date_created_ms) AS first FROM ml_sales_orders').first(); ventanaCompleta = f?.first != null && now - Number(f.first) >= 365 * DAY; } catch { ventanaCompleta = false; }
      return longTailReview({ books: table.data.books, stock: table.data.stock, meta: table.data.meta, visits, catalog, ventana_365_completa: ventanaCompleta, nowMs: now });
    });
  }
  return { generado: new Date(now).toISOString(), kpis, weekly, abc: abcRes, inventario: inv, margen, precios, compras, editoriales: pubs, competencia, longTail };
}

// Lo más urgente de Brújula para el correo de la mañana: pocas filas por
// bloque, sólo lo que pide una acción hoy. Recibe el resultado de loadBi.
const DIGEST_ROWS = 5;
export function brujulaDigest(bi) {
  const inv = bi?.inventario?.ok ? bi.inventario.data : null;
  const reponer = (inv?.aSinStock ?? [])
    .filter(b => b.mercado && ['solo', 'sostenible'].includes(b.mercado.estado))
    .slice(0, DIGEST_ROWS)
    .map(b => ({ isbn: b.isbn, title: b.title, detalle: b.mercado.estado === 'solo'
      ? `vendiste ${b.u90} en 90 días y nadie más lo tiene con entrega inmediata`
      : `vendiste ${b.u90} en 90 días${b.mercado.margenAlMin != null ? `; al precio del más barato ganás $ ${b.mercado.margenAlMin.toLocaleString('es-UY')} por libro` : ''}` }));
  const subir = (bi?.precios?.ok && bi.precios.data ? bi.precios.data.lista : [])
    .filter(b => !b.agotado)
    .slice(0, DIGEST_ROWS)
    .map(b => ({ isbn: b.isbn, title: b.title, detalle: `de $ ${b.actual.toLocaleString('es-UY')} a $ ${b.sugerido.toLocaleString('es-UY')} (+${b.subaPct}%; ${b.aPedido ? 'sos el único con entrega inmediata y a pedido lo venden desde' : 'el más barato con entrega inmediata está a'} $ ${b.min.toLocaleString('es-UY')})` }));
  const agotan = (inv?.coberturaBaja ?? [])
    .slice(0, DIGEST_ROWS)
    .map(b => ({ isbn: b.isbn, title: b.title, detalle: `quedan ${b.stock}, alcanzan para unos ${b.dias} días` }));
  const perdida = (bi?.margen?.ok ? bi.margen.data.peores : [])
    .filter(b => b.margin < 0)
    .slice(0, DIGEST_ROWS)
    .map(b => ({ isbn: b.isbn, title: b.title, detalle: `lo vendés a $ ${b.price.toLocaleString('es-UY')} y reponerlo cuesta $ ${b.cost.toLocaleString('es-UY')}` }));
  if (!reponer.length && !subir.length && !agotan.length && !perdida.length) return null;
  return { reponer, subir, agotan, perdida };
}
