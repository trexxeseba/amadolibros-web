// Ventas y long tail: cómo está cada título del catálogo, separando lo que se
// puede afirmar de lo que no. Un libro sin ventas en 30 días no está muerto;
// uno sin visitas conocidas no tiene "0 visitas": tiene visitas desconocidas.
//
// Categorías (una por ISBN):
//   quiebre                 sin stock y con demanda propia reciente (vendió en 90 d o 2+ en el año)
//   oferta_con_ventas       con stock y ventas en 90 días
//   ventas_lentas           con stock, sin ventas en 90 d pero sí en el año: se mantiene 1 unidad
//   sin_ventas_reciente     con stock, sin ventas en el año y menos de 180 días disponible: evidencia insuficiente
//   visitas_sin_conversion  con stock, sin ventas en 90 d y visitas observadas por encima del umbral
//   poca_exposicion         con stock, sin ventas en el año, 180+ días disponible y visitas observadas bajas
//   sin_ventas_sin_visitas  con stock, sin ventas en el año, 180+ días disponible y visitas desconocidas:
//                           no se puede distinguir poca exposición de falta de demanda
//   sin_stock_sin_demanda   sin stock y sin ventas propias en el año (fuera de la revisión)
//
// "Días disponible" sale de la fecha de alta de la publicación más vieja del
// ISBN (start_time); no hay historial de stock, así que es un techo: se dice.
// Las parejas catálogo / no catálogo se listan para revisar, nunca se fusionan
// ni se suman sus stocks.
import { bookIsbn } from './isbn.js';

const DAY_MS = 86400000;
export const LONG_TAIL_RULES = Object.freeze({ dias_minimos_evidencia: 180, visitas_umbral_90d: 30 });

export const CATEGORIAS = Object.freeze({
  quiebre: 'Quiebre: se vende y no hay stock',
  oferta_con_ventas: 'Oferta con ventas',
  ventas_lentas: 'Ventas lentas: mantener 1',
  sin_ventas_reciente: 'Sin ventas, publicado hace poco',
  visitas_sin_conversion: 'Visitas sin conversión',
  poca_exposicion: 'Poca exposición',
  sin_ventas_sin_visitas: 'Sin ventas, visitas desconocidas',
  sin_stock_sin_demanda: 'Sin stock y sin demanda',
});

export function diasDisponibles(startIso, nowMs, ventanaDias) {
  const start = startIso ? Date.parse(startIso) : NaN;
  if (!Number.isFinite(start)) return null;
  return Math.max(0, Math.min(ventanaDias, Math.floor((nowMs - start) / DAY_MS)));
}

// Un título. visitas_90d: número observado por API de ML, o null si no se sabe.
export function clasificarTitulo({ isbn, u90 = 0, u365 = 0, stock = 0, start = null, visitas_90d = null, ventana_365_completa = true, nowMs = Date.now(), rules = LONG_TAIL_RULES } = {}) {
  const d365 = diasDisponibles(start, nowMs, 365), d90 = diasDisponibles(start, nowMs, 90);
  const base = { isbn, u90, u365, stock, dias_disponibles_365: d365, dias_disponibles_90: d90, visitas_90d, visitas: visitas_90d == null ? 'desconocidas' : 'observadas' };
  const r = (categoria, motivo, accion) => ({ ...base, categoria, motivo, accion });
  if (!(stock > 0)) {
    if (u90 > 0 || u365 >= 2) return r('quiebre', `sin stock y vendió ${u90} en 90 días (${u365} en el año)`, 'reponer: ver Oportunidades');
    return r('sin_stock_sin_demanda', u365 ? 'sin stock, una sola venta en el año' : 'sin stock y sin ventas propias en el año', null);
  }
  if (u90 > 0) return r('oferta_con_ventas', `vendió ${u90} en 90 días con stock`, null);
  if (u365 > 0) return r('ventas_lentas', `sin ventas en 90 días pero ${u365} en el año`, 'mantener 1 unidad: la amplitud vende');
  if (!ventana_365_completa || d365 == null || d365 < rules.dias_minimos_evidencia) return r('sin_ventas_reciente', d365 == null ? 'sin fecha de alta: no se sabe cuánto estuvo disponible' : `publicado hace ${d365} días (menos de ${rules.dias_minimos_evidencia}): todavía no se puede juzgar`, 'esperar');
  if (visitas_90d == null) return r('sin_ventas_sin_visitas', `sin ventas en el año, ${d365}+ días disponible y visitas desconocidas: no se distingue poca exposición de falta de demanda`, 'conseguir visitas (API de ML) antes de decidir');
  if (visitas_90d >= rules.visitas_umbral_90d) return r('visitas_sin_conversion', `${visitas_90d} visitas en 90 días y ninguna venta: la gente llega y no compra`, 'revisar precio, foto y ficha');
  return r('poca_exposicion', `${visitas_90d} visitas en 90 días (menos de ${rules.visitas_umbral_90d}): casi nadie lo ve`, 'revisar título, categoría y ficha de catálogo');
}

// Parejas catálogo / no catálogo del mismo ISBN. Se listan si difieren en
// stock o precio; no se fusionan ni se suman (no hay inventario canónico).
export function paresCatalogo(catalog) {
  const by = new Map();
  for (const item of Array.isArray(catalog?.items) ? catalog.items : []) {
    const isbn = bookIsbn(item?.isbn);
    if (!isbn || item.status !== 'active') continue;
    const e = by.get(isbn) ?? { isbn, title: item.title ?? null, catalogo: [], sueltas: [] };
    (item.catalog_listing === true ? e.catalogo : e.sueltas).push({ id: item.id, precio: Number(item.price) || null, cantidad: Number(item.available_quantity) || 0 });
    by.set(isbn, e);
  }
  const out = [];
  for (const e of by.values()) {
    if (!e.catalogo.length || !e.sueltas.length) continue;
    const precios = new Set([...e.catalogo, ...e.sueltas].map(p => p.precio)), cantidades = new Set([...e.catalogo, ...e.sueltas].map(p => p.cantidad));
    const motivos = [];
    if (precios.size > 1) motivos.push('precios distintos');
    if (cantidades.size > 1) motivos.push('cantidades distintas');
    out.push({ isbn: e.isbn, title: e.title, catalogo: e.catalogo, sueltas: e.sueltas, motivos, revisar: motivos.length > 0 });
  }
  return out.sort((a, b) => Number(b.revisar) - Number(a.revisar) || a.isbn.localeCompare(b.isbn));
}

// Revisión de todo el catálogo. `books`: ventas por ISBN (loadBookTable);
// `stock`: ownStockIndex; `meta`: ISBN → {title, start}; `visits`: ISBN → visitas 90 d.
export function longTailReview({ books = [], stock = new Map(), meta = new Map(), visits = new Map(), catalog = null, ventana_365_completa = true, nowMs = Date.now(), rules = LONG_TAIL_RULES } = {}) {
  const sales = new Map(books.map(b => [b.isbn, b]));
  const isbns = new Set([...sales.keys(), ...stock.keys()]);
  const titulos = [];
  for (const isbn of isbns) {
    const b = sales.get(isbn), s = stock.get(isbn);
    const c = clasificarTitulo({ isbn, u90: b?.u90 ?? 0, u365: b?.u365 ?? 0, stock: s?.stock_propio ?? 0, start: meta.get(isbn)?.start ?? null, visitas_90d: visits.has(isbn) ? visits.get(isbn) : null, ventana_365_completa, nowMs, rules });
    titulos.push({ ...c, title: b?.title ?? meta.get(isbn)?.title ?? null, publicaciones: s?.publicaciones?.length ?? 0 });
  }
  const conteo = Object.fromEntries(Object.keys(CATEGORIAS).map(k => [k, 0]));
  for (const t of titulos) conteo[t.categoria]++;
  const unidades = cat => titulos.filter(t => t.categoria === cat).reduce((n, t) => n + t.stock, 0);
  const top = (cat, key, n = 12) => titulos.filter(t => t.categoria === cat).sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0)).slice(0, n);
  return {
    generado: new Date(nowMs).toISOString(), titulos_revisados: titulos.length, conteo, rules,
    visitas_observadas: titulos.filter(t => t.visitas === 'observadas').length,
    capital: { ventas_lentas_unidades: unidades('ventas_lentas'), sin_ventas_largo_unidades: unidades('sin_ventas_sin_visitas') + unidades('poca_exposicion') + unidades('visitas_sin_conversion') },
    listas: { quiebre: top('quiebre', 'u90'), visitas_sin_conversion: top('visitas_sin_conversion', 'visitas_90d'), poca_exposicion: top('poca_exposicion', 'dias_disponibles_365'), sin_ventas_sin_visitas: top('sin_ventas_sin_visitas', 'stock'), ventas_lentas: top('ventas_lentas', 'stock') },
    pares: catalog ? paresCatalogo(catalog) : [],
  };
}

// Visitas por ISBN desde la tabla del Worker (última ventana de 90 días por
// publicación; se toma la publicación con más visitas del ISBN, no la suma:
// la propia y la de catálogo pueden ser la misma ficha vista dos veces).
export async function loadVisitsIndex(db, nowMs = Date.now()) {
  const out = new Map();
  try {
    const { results } = await db.prepare(`SELECT isbn, MAX(visits) AS v FROM comp_item_visits WHERE isbn IS NOT NULL AND visits IS NOT NULL AND fetched_at>=? GROUP BY isbn`).bind(nowMs - 8 * DAY_MS).all();
    for (const r of results) out.set(r.isbn, Number(r.v));
  } catch { /* sin tabla todavía */ }
  return out;
}
