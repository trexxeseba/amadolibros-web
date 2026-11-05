// Revisión de precios de TODO el catálogo con foto de competencia (top diario y
// rotación): para cada ficha, precio actual, comparables con entrega inmediata,
// ventaja inmediata (los demás venden a pedido), sugerencia de suba, rango de
// prueba parametrizable, costo con fecha, comisión, flete, contribución y lo
// que falta. Sin costo o sin comisión no hay "precio rentable firme": la
// sugerencia queda provisional y lo dice. Nunca inventa elasticidad ni
// ganancias: "más por mes" supone el mismo ritmo de los últimos 90 días.
//
// Corre en el Worker (cron del correo diario y ruta manual) por tandas y deja
// el resultado en la bandeja (comp_opportunities, tipo subir_precio) y un
// resumen en comp_state (name = price_review). No cambia ningún precio.
import { competitionByIsbn } from './ml-competition.js';
import { loadCostModel, marginOf } from '../functions/_shared/panel-bi.js';
import { COUNTED_STATUSES } from './ml-sales.js';
import { bookIsbn } from './isbn.js';

const DAY_MS = 86400000;
const COUNTED = COUNTED_STATUSES.map(s => `'${s}'`).join(',');
const CHUNK = 120;

// Parámetros de la revisión. Se pueden pisar por llamada (ruta manual) para
// probar otros rangos; ninguno es "el óptimo": son reglas de prueba.
export const PRICE_PARAMS = Object.freeze({
  undercut_pct: 2,        // sugerido = más barato comparable − 2 %
  min_gap_pct: 15,        // sólo si el más barato está 15 % o más arriba del precio actual
  probe_step_pct: 5,      // rango de prueba: pasos de 5 %
  probe_max_pct: 20,      // y hasta 20 % arriba cuando no hay referencia comparable
  stale_hours: 48,        // foto más vieja que esto baja la confianza
});

const round10 = v => Math.floor(v / 10) * 10;
const money = v => `$ ${Math.round(v).toLocaleString('es-UY')}`;

function probeRange(from, to, stepPct) {
  const out = [];
  let p = round10(from * (1 + stepPct / 100));
  while (p <= to && out.length < 8) { out.push(p); p = round10(p * (1 + stepPct / 100)); }
  if (!out.length || out[out.length - 1] < to) out.push(round10(to));
  return [...new Set(out)];
}

// Una ficha. `f` es el hecho de competitionByIsbn (foto completa); `costo` el
// de loadCostModel ({cost, d, supplier, currency}) o null; `feeRate` la
// comisión mediana observada o null; `flete` por unidad en pesos o null.
export function revisarPrecio({ isbn, titulo = null, precio_actual, stock = 0, u90 = 0, u365 = 0, f, costo = null, feeRate = null, flete = null, params = PRICE_PARAMS }) {
  const p = { ...PRICE_PARAMS, ...params };
  const faltantes = [];
  if (!f) return { isbn, titulo, nivel: 'bloqueado', motivo: 'sin foto completa de competencia', faltantes: ['foto'] };
  if (!(precio_actual > 0)) return { isbn, titulo, nivel: 'bloqueado', motivo: 'sin precio propio activo', faltantes: ['precio_actual'] };
  // Costo y comisión son críticos: sin ellos no hay precio rentable firme. El
  // flete se lista como faltante (hoy no hay fuente) pero no bloquea: la
  // contribución se informa "sin flete".
  if (!costo) faltantes.push('costo');
  if (feeRate == null) faltantes.push('comision');
  if (flete == null) faltantes.push('flete');
  const criticos = faltantes.filter(x => x !== 'flete');
  const comparables = f.competidores_comparables ?? 0, min = f.precio_minimo, aPedido = f.competidores_a_pedido ?? 0, minAPedido = f.precio_minimo_a_pedido;
  const ventajaInmediata = stock > 0 && comparables === 0 && aPedido > 0;
  const gapMin = 1 + p.min_gap_pct / 100, under = 1 - p.undercut_pct / 100;
  let sugerido = null, referencia = null, motivo = null;
  if (comparables > 0 && min > 0) {
    referencia = { tipo: 'inmediato', precio: min, cantidad: comparables };
    if (min / precio_actual >= gapMin) { sugerido = Math.max(precio_actual, round10(min * under)); motivo = `el más barato con entrega inmediata está ${Math.round((min / precio_actual - 1) * 100)} % arriba`; }
    else motivo = `el más barato con entrega inmediata está a ${money(min)} (menos de ${p.min_gap_pct} % arriba): sin margen claro para subir`;
  } else if (ventajaInmediata && minAPedido > 0) {
    referencia = { tipo: 'a_pedido', precio: minAPedido, cantidad: aPedido };
    if (minAPedido / precio_actual >= gapMin) { sugerido = Math.max(precio_actual, round10(minAPedido * under)); motivo = `sos el único con entrega inmediata; los ${aPedido} a pedido arrancan ${Math.round((minAPedido / precio_actual - 1) * 100)} % arriba`; }
    else { sugerido = round10(precio_actual * (1 + p.probe_max_pct / 100)); motivo = `sos el único con entrega inmediata; los a pedido están cerca de tu precio: probar de a ${p.probe_step_pct} %`; }
  } else if (comparables === 0 && aPedido === 0 && (f.competidores ?? 0) === 0) {
    referencia = { tipo: 'ninguna', precio: null, cantidad: 0 };
    sugerido = round10(precio_actual * (1 + p.probe_max_pct / 100));
    motivo = `no detectamos otra oferta en la ficha de ML: probar de a ${p.probe_step_pct} % hasta ${p.probe_max_pct} %`;
  } else {
    referencia = { tipo: 'desconocida', precio: null, cantidad: f.competidores ?? 0 };
    motivo = `${f.desconocidos ?? 0} competidor${(f.desconocidos ?? 0) === 1 ? '' : 'es'} sin datos de entrega o moneda: no se compara`;
  }
  const comision = v => (feeRate == null ? null : Math.round(v * feeRate));
  const contribucion = v => (costo ? v - (comision(v) ?? 0) - costo.cost - (flete ?? 0) : null);
  const rango = sugerido && sugerido > precio_actual ? probeRange(precio_actual, sugerido, p.probe_step_pct) : [];
  const masPorMes = sugerido && sugerido > precio_actual && u90 > 0 ? Math.round((sugerido - precio_actual) * u90 / 3) : 0;
  let nivel, confianza;
  if (!sugerido || sugerido <= precio_actual) { nivel = 'sin_suba'; confianza = null; }
  else if (!criticos.length && contribucion(sugerido) > 0) { nivel = 'firme'; confianza = referencia.tipo === 'inmediato' && comparables >= 2 ? 'alta' : 'media'; }
  else { nivel = 'provisional'; confianza = referencia.tipo === 'inmediato' ? 'media' : 'baja'; }
  if (confianza && (f.foto_edad_horas > p.stale_hours || f.captura_posterior)) confianza = 'baja';
  if (confianza && !(stock > 0)) confianza = 'baja';
  return {
    isbn, titulo, precio_actual, stock, u90, u365, segmento: f.segmento ?? 'top', foto: f.foto, foto_edad_horas: f.foto_edad_horas,
    comparables, mas_barato: min ?? null, a_pedido: aPedido, mas_barato_a_pedido: minAPedido ?? null, otra_moneda: f.otra_moneda ?? 0, desconocidos: f.desconocidos ?? 0, ventaja_inmediata: ventajaInmediata,
    referencia, sugerido, suba_pct: sugerido ? Math.round((sugerido / precio_actual - 1) * 100) : 0, rango_prueba: rango, mas_por_mes: masPorMes,
    costo: costo ? { valor: costo.cost, fecha: new Date(costo.d).toISOString().slice(0, 10), proveedor: costo.supplier, moneda: costo.currency } : null,
    comision: { tasa: feeRate, actual: comision(precio_actual), sugerida: sugerido ? comision(sugerido) : null },
    flete: flete ?? null,
    contribucion: costo ? { actual: contribucion(precio_actual), sugerida: sugerido ? contribucion(sugerido) : null } : null,
    faltantes, nivel, confianza, motivo, params: { undercut_pct: p.undercut_pct, min_gap_pct: p.min_gap_pct, probe_step_pct: p.probe_step_pct, probe_max_pct: p.probe_max_pct },
  };
}

// Texto para la bandeja y el correo, con fuentes y faltantes siempre dichos.
export function textoPrecio(r) {
  const partes = [`Lo tenés a ${money(r.precio_actual)}.`];
  if (r.referencia?.tipo === 'inmediato') partes.push(`El más barato con entrega inmediata está a ${money(r.referencia.precio)} (${r.referencia.cantidad} comparable${r.referencia.cantidad === 1 ? '' : 's'} en la ficha de ML).`);
  else if (r.referencia?.tipo === 'a_pedido') partes.push(`Sos el único con entrega inmediata: ${r.referencia.cantidad} lo venden a pedido desde ${money(r.referencia.precio)}.`);
  else if (r.referencia?.tipo === 'ninguna') partes.push('No detectamos otra oferta en esta ficha de catálogo de ML (foto diaria por API).');
  if (r.sugerido && r.sugerido > r.precio_actual) partes.push(`Sugerencia: ${money(r.sugerido)} (+${r.suba_pct} %); rango de prueba ${r.rango_prueba.map(money).join(' → ')}.`);
  if (r.mas_por_mes) partes.push(`Al ritmo de 90 días (${r.u90} vendidos) son ${money(r.mas_por_mes)} más por mes si sigue vendiendo igual.`);
  if (r.costo) partes.push(`Costo ${money(r.costo.valor)} (${r.costo.proveedor}, ${r.costo.fecha.split('-').reverse().join('/')})${r.comision?.tasa != null ? `, comisión ML ${Math.round(r.comision.tasa * 1000) / 10} %` : ''}${r.contribucion?.sugerida != null ? `: te quedan ${money(r.contribucion.actual)} hoy y ${money(r.contribucion.sugerida)} con el sugerido${r.flete == null ? ' (sin contar flete)' : ''}` : ''}.`);
  if (r.faltantes?.length) partes.push(`Faltan: ${r.faltantes.join(', ')}.${r.nivel === 'provisional' ? ' Sin costo y comisión no hay precio rentable firme: es una prueba.' : ''}`);
  return partes.join(' ');
}

async function salesIndex(db, isbns, nowMs) {
  const out = new Map();
  try {
    const { results } = await db.prepare(`SELECT i.isbn, SUM(CASE WHEN o.date_created_ms>=? THEN i.quantity ELSE 0 END) AS u90, SUM(i.quantity) AS u365, MAX(i.title) AS title
      FROM ml_sales_items i JOIN ml_sales_orders o ON o.order_id=i.order_id
      WHERE o.status IN (${COUNTED}) AND o.date_created_ms>=? AND i.isbn IN (SELECT value FROM json_each(?)) AND (i.seller_sku IS NULL OR i.seller_sku NOT LIKE 'AMADO-AR-%') GROUP BY i.isbn`)
      .bind(nowMs - 90 * DAY_MS, nowMs - 365 * DAY_MS, JSON.stringify(isbns)).all();
    for (const r of results) out.set(r.isbn, { u90: Number(r.u90) || 0, u365: Number(r.u365) || 0, title: r.title });
  } catch { /* sin ventas cargadas */ }
  return out;
}

// Precio activo, stock (máximo entre publicaciones) y título por ISBN.
export function ownPriceIndex(catalog) {
  const out = new Map();
  for (const item of Array.isArray(catalog?.items) ? catalog.items : []) {
    const isbn = bookIsbn(item?.isbn);
    if (!isbn) continue;
    const e = out.get(isbn) ?? { price: null, stock: 0, title: item.title ?? null, currency: item.currency ?? null };
    if (item.status === 'active') {
      const q = Math.max(0, Number(item.available_quantity) || 0);
      e.stock = Math.max(e.stock, q);
      if (Number.isFinite(Number(item.price)) && Number(item.price) > 0 && (item.currency == null || item.currency === 'UYU')) e.price = e.price == null ? Number(item.price) : Math.min(e.price, Number(item.price));
    }
    out.set(isbn, e);
  }
  return out;
}

// Todas las fichas vigiladas (top + rotación) por tandas. Devuelve la lista de
// revisiones y un resumen; guarda el resumen en comp_state. `flete` por unidad
// en pesos si se conoce (hoy no hay fuente: queda como faltante).
export async function reviewCatalogPrices(db, catalog, { nowMs = Date.now(), params = {}, flete = null, limit = 5000 } = {}) {
  let isbns = [];
  try {
    const a = (await db.prepare('SELECT isbn FROM comp_targets WHERE isbn IS NOT NULL').all()).results.map(r => r.isbn);
    const b = (await db.prepare('SELECT isbn FROM comp_rotation WHERE isbn IS NOT NULL').all().catch(() => ({ results: [] }))).results.map(r => r.isbn);
    isbns = [...new Set([...a, ...b])].slice(0, limit);
  } catch { return { state: 'error', code: 'competition_unavailable', revisiones: [] }; }
  const own = ownPriceIndex(catalog);
  const revisiones = [];
  const resumen = { fichas_vigiladas: isbns.length, con_foto: 0, sin_precio_propio: 0, con_suba: 0, firmes: 0, provisionales: 0, sin_suba: 0, bloqueadas: 0, sin_costo: 0, sin_comision: 0, mas_por_mes: 0, generado: new Date(nowMs).toISOString(), params: { ...PRICE_PARAMS, ...params } };
  for (let i = 0; i < isbns.length; i += CHUNK) {
    const chunk = isbns.slice(i, i + CHUNK);
    const [facts, model, sales] = await Promise.all([competitionByIsbn(db, chunk, nowMs), loadCostModel(db, chunk), salesIndex(db, chunk, nowMs)]);
    for (const isbn of chunk) {
      const f = facts.get(isbn);
      if (!f) continue;
      resumen.con_foto++;
      const o = own.get(isbn), s = sales.get(isbn);
      const precio = f.tu_precio ?? o?.price ?? null;
      if (!(precio > 0)) { resumen.sin_precio_propio++; continue; }
      const r = revisarPrecio({ isbn, titulo: o?.title ?? s?.title ?? null, precio_actual: precio, stock: o?.stock ?? 0, u90: s?.u90 ?? 0, u365: s?.u365 ?? 0, f, costo: model.costs.get(isbn) ?? null, feeRate: model.feeRate, flete, params });
      revisiones.push(r);
      if (r.nivel === 'bloqueado') resumen.bloqueadas++;
      else if (r.nivel === 'sin_suba') resumen.sin_suba++;
      else { resumen.con_suba++; resumen[r.nivel === 'firme' ? 'firmes' : 'provisionales']++; resumen.mas_por_mes += r.mas_por_mes; }
      if (!r.costo) resumen.sin_costo++;
      if (r.comision?.tasa == null) resumen.sin_comision++;
    }
  }
  try {
    await db.prepare('INSERT INTO comp_state(name,cursor_json,lease_until,updated_at) VALUES(?,?,0,?) ON CONFLICT(name) DO UPDATE SET cursor_json=excluded.cursor_json,updated_at=excluded.updated_at')
      .bind('price_review', JSON.stringify(resumen), nowMs).run();
  } catch { /* sin tabla todavía: el resumen igual se devuelve */ }
  return { state: 'ok', resumen, revisiones };
}

export async function lastPriceReview(db) {
  try {
    const r = await db.prepare('SELECT cursor_json,updated_at FROM comp_state WHERE name=?').bind('price_review').first();
    return r ? { ...JSON.parse(r.cursor_json || '{}'), updated_at: Number(r.updated_at) } : null;
  } catch { return null; }
}

// Oportunidades de la bandeja a partir de las revisiones con suba.
export function opportunitiesFromPriceReview(revisiones, { meta = new Map(), nowMs = Date.now() } = {}) {
  const out = [];
  for (const r of revisiones) {
    if (r.nivel !== 'firme' && r.nivel !== 'provisional') continue;
    const m = meta.get(r.isbn);
    out.push({
      id: `subir_precio:${r.isbn}`, isbn: r.isbn, tipo: 'subir_precio', titulo: r.titulo ?? m?.title ?? null,
      accion: `${r.rango_prueba.length > 1 ? 'Probar' : 'Subir'} de ${money(r.precio_actual)} a ${money(r.sugerido)} (+${r.suba_pct}%)${!(r.stock > 0) ? ' cuando lo repongas' : ''}${r.nivel === 'provisional' ? ' · provisional' : ''}`,
      impacto_mes: r.mas_por_mes || null, confianza: r.confianza, cantidad: null, cantidad_nivel: null,
      evidencia: { tu_precio: r.precio_actual, sugerido: r.sugerido, suba_pct: r.suba_pct, rango_prueba: r.rango_prueba, referencia: r.referencia, comparables: r.comparables, mas_barato: r.mas_barato, a_pedido: r.a_pedido, mas_barato_a_pedido: r.mas_barato_a_pedido,
        ventaja_inmediata: r.ventaja_inmediata, u90: r.u90, u365: r.u365, stock: r.stock, agotado: !(r.stock > 0), costo: r.costo, costo_conocido: Boolean(r.costo), comision: r.comision, flete: r.flete, contribucion: r.contribucion,
        faltantes: r.faltantes, nivel: r.nivel, motivo: r.motivo, segmento: r.segmento, foto: r.foto, foto_edad_horas: r.foto_edad_horas, params: r.params, texto: textoPrecio(r), calculado: new Date(nowMs).toISOString() },
      enlaces: { panel: `/panel/reposicion?q=${r.isbn}`, ml: m?.permalink ?? (m?.item ? `https://articulo.mercadolibre.com.uy/${m.item.replace(/^MLU/, 'MLU-')}` : null), tapa: m?.thumbnail ?? null },
    });
  }
  return out;
}
