// Hechos del motor de reposición por ISBN: ventas ML (propio / encargo SBS),
// compras, stock propio, disponibilidad SBS y banderas FUENTE INCOMPLETA /
// REVISAR. Lo usan la ruta firmada de GPT (worker-sync/reposicion-read.js) y la
// sección Reposición del panel (functions/panel/reposicion.js). No calcula
// URGENTE / COMPRAR N / NO REPONER.
//
// loadCatalog(): devuelve catalog.json ya parseado. El Worker lo lee de R2 y
// Pages de la URL pública; cada uno pasa su propio cargador.
import { salesByIsbn, topOwnSalesIsbns } from './ml-sales.js';
import { purchaseSummary, readCoverage, missingCoverage, purchasesWithoutIsbn, SUPPLIER_LEAD_DAYS } from './purchases.js';
import { readSalesHealth, evaluateSalesHealth } from './sales-health.js';
import { bookIsbn } from './isbn.js';
import { competitionByIsbn, competitionEvents } from './ml-competition.js';

const RECENT_PURCHASE_DAYS = 60;

const DAY_MS = 86400000, CATALOG_STALE_MS = 48 * 3600000, SBS_STALE_DAYS = 7, CATALOG_CACHE_MS = 10 * 60 * 1000;
export const DATA_STATES = Object.freeze(['FUENTE INCOMPLETA', 'REVISAR', 'LISTO_PARA_DECIDIR']);

// Stock propio por ISBN desde catalog.json (excluye publicaciones AMADO-AR de
// proveedor). Propia y de catálogo comparten ejemplar: se toma el máximo.
export function ownStockIndex(catalog) {
  const map = new Map();
  for (const item of Array.isArray(catalog?.items) ? catalog.items : []) {
    const isbn = bookIsbn(item?.isbn);
    if (!isbn) continue;
    const entry = map.get(isbn) ?? { stock_propio: 0, publicaciones: [] };
    const qty = item.status === 'active' ? Math.max(0, Number(item.available_quantity) || 0) : 0;
    entry.publicaciones.push({ id: item.id, estado: item.status, cantidad: Number(item.available_quantity) || 0, catalogo: item.catalog_listing === true });
    entry.stock_propio = Math.max(entry.stock_propio, qty);
    map.set(isbn, entry);
  }
  return map;
}

export function createReposicionFacts({ now = Date.now, loadCatalog }) {
  let cache = null;
  async function catalog() {
    if (cache && now() - cache.at < CATALOG_CACHE_MS) return cache;
    const data = await loadCatalog().catch(() => null);
    if (!data) return { at: now(), index: new Map(), updated_at: null };
    cache = { at: now(), index: ownStockIndex(data), updated_at: data.updated_at ?? null };
    return cache;
  }

  async function sbs(db, isbns) {
    try {
      const feed = await db.prepare("SELECT id,source_date FROM sbs_supplier_feeds WHERE state='ready' ORDER BY source_date DESC LIMIT 1").first();
      if (!feed) return { feed: null, rows: new Map() };
      const { results } = await db.prepare(`SELECT isbn,data_json FROM sbs_supplier_stock WHERE feed_id=? AND isbn IN (${isbns.map(() => '?').join(',')})`).bind(feed.id, ...isbns).all();
      return { feed, rows: new Map(results.map(r => [r.isbn, JSON.parse(r.data_json)])) };
    } catch { return { feed: null, rows: new Map() }; }
  }

  async function globalState(db) {
    const health = evaluateSalesHealth(await readSalesHealth(db), now());
    const cat = await catalog();
    const coverage = await readCoverage(db);
    const missing = missingCoverage(coverage, now());
    const flags = [];
    if (health.problemas.length) flags.push('ventas_ml_desactualizadas');
    if (!cat.updated_at || now() - Date.parse(cat.updated_at) > CATALOG_STALE_MS) flags.push('stock_propio_desactualizado');
    return { health, catalog_updated_at: cat.updated_at, coverage, missing, flags, cat };
  }

  async function facts(db, isbnsIn) {
    const g = await globalState(db);
    const [sales, purchases] = await Promise.all([salesByIsbn(db, isbnsIn, now()), purchaseSummary(db, isbnsIn, now())]);
    const valid = [...new Set(sales.filter(s => s.isbn).map(s => s.isbn))];
    const sup = valid.length ? await sbs(db, valid) : { feed: null, rows: new Map() };
    const sbsAge = sup.feed ? Math.floor((now() - Date.parse(sup.feed.source_date)) / DAY_MS) : null;
    const comp = await competitionByIsbn(db, valid).catch(() => new Map());
    const resultados = sales.map((s, i) => {
      if (!s.isbn) return s;
      const p = purchases[i], stock = g.cat.index.get(s.isbn) ?? { stock_propio: 0, publicaciones: [] };
      const sbsRow = sup.rows.get(s.isbn);
      const fuente = [...g.flags], revisar = [];
      if (p.documentos === 0 && g.missing.length) fuente.push(`compras_no_cargadas:${g.missing.join(',')}`);
      if (p.compras_sin_isbn_posibles > 0) revisar.push('compras_sin_isbn_posibles');
      const active = stock.publicaciones.filter(x => x.estado === 'active');
      if (new Set(active.map(x => x.cantidad)).size > 1) revisar.push('publicaciones_con_stock_distinto');
      if (stock.stock_propio === 0 && s.ventas_propio_365d >= 2 && s.ventas_propio_90d === 0) revisar.push('posible_demanda_censurada');
      if (s.ventas_encargo_365d > s.ventas_propio_365d) revisar.push('encargo_sbs_supera_propio');
      if (stock.stock_propio + p.en_transito_estimado >= s.ventas_propio_180d && s.ventas_propio_180d > 0 && stock.stock_propio > 0) revisar.push('posible_sobrestock');
      // Aviso anti-doble compra: lo primero que hay que ver antes de pedir.
      const avisos = [];
      const diasCompra = p.ultima_compra_fecha ? Math.floor((now() - Date.parse(`${p.ultima_compra_fecha}T12:00:00Z`)) / DAY_MS) : null;
      if (diasCompra != null && diasCompra <= RECENT_PURCHASE_DAYS) {
        avisos.push({ tipo: 'compra_reciente', texto: `Compraste ${p.ultima_compra_cantidad} hace ${diasCompra} ${diasCompra === 1 ? 'día' : 'días'} (${p.ultima_compra_proveedor})${p.en_transito_estimado ? ': puede estar en camino' : ''}.` });
      }
      const c = comp.get(s.isbn) ?? null;
      if (c) avisos.push(...c.avisos);
      return {
        isbn: s.isbn, titulo: s.titulos[0] ?? null,
        stock_propio: stock.stock_propio, publicaciones: stock.publicaciones,
        ventas: { propio: { d30: s.ventas_propio_30d, d90: s.ventas_propio_90d, d180: s.ventas_propio_180d, d365: s.ventas_propio_365d }, encargo_sbs: { d30: s.ventas_encargo_30d, d90: s.ventas_encargo_90d, d180: s.ventas_encargo_180d, d365: s.ventas_encargo_365d },
          ultima_venta: s.ultima_venta, ultima_venta_propio: s.ultima_venta_propio, canceladas: s.unidades_canceladas, item_ids: s.item_ids, cobertura_desde: s.cobertura_desde, ventana_365d_completa: s.ventana_365d_completa },
        compras: { d30: p.unidades_30d, d90: p.unidades_90d, d180: p.unidades_180d, d365: p.unidades_365d, ultima_fecha: p.ultima_compra_fecha, ultima_cantidad: p.ultima_compra_cantidad, ultimo_proveedor: p.ultima_compra_proveedor, documentos: p.documentos, en_transito_estimado: p.en_transito_estimado, sin_isbn_posibles: p.compras_sin_isbn_posibles },
        sbs: sup.feed ? { disponible: sbsRow ? sbsRow.stock ?? null : 'no_figura', feed_fecha: sup.feed.source_date, feed_edad_dias: sbsAge, vigente: sbsAge <= SBS_STALE_DAYS } : { disponible: 'desconocida', feed_fecha: null },
        plazo_entrega_dias: SUPPLIER_LEAD_DAYS.default,
        competencia: c ? { catalog_product_id: c.catalog_product_id, foto: c.foto, competidores: c.competidores, precio_minimo: c.precio_minimo, tu_precio: c.tu_precio, precio_relativo: c.precio_relativo, primer_lugar: c.primer_lugar, precio_para_ganar: c.precio_para_ganar, vendedores: c.vendedores } : null,
        avisos,
        fuente_incompleta: fuente, revisar,
        estado_datos: fuente.length ? 'FUENTE INCOMPLETA' : revisar.length ? 'REVISAR' : 'LISTO_PARA_DECIDIR',
      };
    });
    return { generado: new Date(now()).toISOString(), advertencias_globales: g.flags, cobertura_faltante: g.missing, resultados };
  }

  // ISBN con ≥2 ventas propias en 365 días y stock propio ≤1, por ventas de 90 días.
  async function candidates(db, limit = 50) {
    const cat = await catalog();
    const top = (await topOwnSalesIsbns(db, { nowMs: now() })).filter(r => (cat.index.get(r.isbn)?.stock_propio ?? 0) <= 1).slice(0, Math.min(50, Math.max(1, limit)));
    return top.length ? facts(db, top.map(r => r.isbn)) : { generado: new Date(now()).toISOString(), advertencias_globales: [], cobertura_faltante: [], resultados: [] };
  }

  async function identityQueue(db, limit = 20) {
    const { results } = await db.prepare(`SELECT i.item_id,MAX(i.title) AS titulo,MAX(i.seller_sku) AS sku,SUM(i.quantity) AS unidades,MAX(o.date_created) AS ultima
      FROM ml_sales_items i JOIN ml_sales_orders o ON o.order_id=i.order_id WHERE i.isbn IS NULL AND o.status<>'cancelled' GROUP BY i.item_id ORDER BY unidades DESC LIMIT ?`).bind(Math.min(100, limit)).all();
    return { ventas_sin_isbn: results, compras_sin_isbn: await purchasesWithoutIsbn(db, limit) };
  }

  const events = (db, limit = 30) => competitionEvents(db, { limit });

  return { globalState, facts, candidates, identityQueue, events };
}
