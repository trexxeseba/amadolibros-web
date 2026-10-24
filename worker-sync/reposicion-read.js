// POST /operations/reposicion — lectura firmada para GPT ("Amado Operaciones")
// de los hechos del motor de reposición: ventas ML por ISBN, compras, stock
// propio, disponibilidad SBS y banderas FUENTE INCOMPLETA / REVISAR.
//
// Mismo sobre que /operations/read (Amado-Signature, ECDSA P-256, misma clave
// pública) con aud "amado-reposicion-read". Cada jti se usa una sola vez
// (ml_pub_nonces). Sólo lee D1 y R2: no llama a Mercado Libre ni escribe datos.
// No calcula URGENTE / COMPRAR N / NO REPONER: entrega los hechos para decidir.
import { OPERATIONS_PUBLIC_KEY, OPERATIONS_ISSUER } from './operations-read.js';
import { salesByIsbn, salesByTitle, topOwnSalesIsbns, SALES_SELLER_ID } from './ml-sales.js';
import { purchaseSummary, purchasesByTitle, readCoverage, missingCoverage, purchasesWithoutIsbn, SUPPLIER_LEAD_DAYS } from './purchases.js';
import { readSalesHealth, evaluateSalesHealth } from './sales-health.js';
import { bookIsbn } from './isbn.js';

export const REPOSICION_PATH = '/operations/reposicion';
export const REPOSICION_AUD = 'amado-reposicion-read';
const ACTIONS = ['estado', 'reposicion_hechos', 'candidatos', 'ventas_titulo', 'compras_titulo', 'revision_identidad'];
const DAY_MS = 86400000, CATALOG_STALE_MS = 48 * 3600000, SBS_STALE_DAYS = 7, CATALOG_CACHE_MS = 10 * 60 * 1000;

class RepoError extends Error { constructor(code, status = 400) { super(code); this.code = code; this.status = status; } }
const reply = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const decode = v => { if (!/^[A-Za-z0-9_-]+$/.test(v)) throw new Error('enc'); return Uint8Array.from(atob(v.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(v.length / 4) * 4, '=')), c => c.charCodeAt(0)); };

export async function verifyReposicionRequest(request, { now = Date.now, publicKey = OPERATIONS_PUBLIC_KEY } = {}) {
  const auth = request.headers.get('authorization') || '';
  try {
    if (request.method !== 'POST' || new URL(request.url).pathname !== REPOSICION_PATH || auth.length > 8192 || !auth.startsWith('Amado-Signature ')) throw new Error('env');
    const parts = auth.slice(16).split('.');
    if (parts.length !== 2) throw new Error('env');
    const key = await crypto.subtle.importKey('jwk', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, decode(parts[1]), new TextEncoder().encode(parts[0]))) throw new Error('sig');
    const p = JSON.parse(new TextDecoder().decode(decode(parts[0]))), seconds = Math.floor(now() / 1000);
    if (p.v !== 1 || p.iss !== OPERATIONS_ISSUER || p.aud !== REPOSICION_AUD || p.method !== 'POST' || p.path !== REPOSICION_PATH || p.seller_id !== SALES_SELLER_ID
      || !Number.isInteger(p.iat) || !Number.isInteger(p.exp) || p.exp <= seconds || p.iat > seconds + 15 || p.exp - p.iat > 60 || p.exp <= p.iat || !/^[a-f0-9-]{36}$/.test(p.jti)) throw new Error('claims');
    return p;
  } catch { throw new RepoError('unauthorized_or_expired', 401); }
}

async function useNonce(db, jti, expiresMs, nowMs) {
  await db.prepare('CREATE TABLE IF NOT EXISTS ml_pub_nonces (id TEXT PRIMARY KEY,expires_at INTEGER NOT NULL)').run();
  await db.prepare('DELETE FROM ml_pub_nonces WHERE expires_at<?').bind(nowMs).run();
  try { await db.prepare('INSERT INTO ml_pub_nonces(id,expires_at) VALUES(?,?)').bind(`rep:${jti}`, expiresMs).run(); }
  catch { throw new RepoError('request_already_used', 409); }
}

function args(raw, fields) {
  const a = raw ?? {};
  if (typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(k => !fields.includes(k))) throw new RepoError('invalid_args');
  return a;
}
const isbnList = a => { if (!Array.isArray(a.isbns) || a.isbns.length < 1 || a.isbns.length > 50) throw new RepoError('isbns_1_to_50'); return a.isbns; };
const titleArg = a => { const t = String(a.titulo ?? '').trim(); if (t.length < 3 || t.length > 120) throw new RepoError('titulo_3_to_120'); return t; };
const limitArg = (a, max) => Math.min(max, Math.max(1, Number.isInteger(a.limite) ? a.limite : 20));

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

export function createReposicionReader({ now = Date.now, publicKey = OPERATIONS_PUBLIC_KEY } = {}) {
  let cache = null;
  async function catalog(env) {
    if (cache && now() - cache.at < CATALOG_CACHE_MS) return cache;
    const obj = await env.CATALOG_R2?.get('catalog.json');
    if (!obj) return { at: now(), index: new Map(), updated_at: null };
    const data = await obj.json();
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

  async function globalState(env, db) {
    const health = evaluateSalesHealth(await readSalesHealth(db), now());
    const cat = await catalog(env);
    const coverage = await readCoverage(db);
    const missing = missingCoverage(coverage, now());
    const flags = [];
    if (health.problemas.length) flags.push('ventas_ml_desactualizadas');
    if (!cat.updated_at || now() - Date.parse(cat.updated_at) > CATALOG_STALE_MS) flags.push('stock_propio_desactualizado');
    return { health, catalog_updated_at: cat.updated_at, coverage, missing, flags, cat };
  }

  async function facts(env, db, isbnsIn) {
    const g = await globalState(env, db);
    const [sales, purchases] = await Promise.all([salesByIsbn(db, isbnsIn, now()), purchaseSummary(db, isbnsIn, now())]);
    const valid = [...new Set(sales.filter(s => s.isbn).map(s => s.isbn))];
    const sup = valid.length ? await sbs(db, valid) : { feed: null, rows: new Map() };
    const sbsAge = sup.feed ? Math.floor((now() - Date.parse(sup.feed.source_date)) / DAY_MS) : null;
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
      return {
        isbn: s.isbn, titulo: s.titulos[0] ?? null,
        stock_propio: stock.stock_propio, publicaciones: stock.publicaciones,
        ventas: { propio: { d30: s.ventas_propio_30d, d90: s.ventas_propio_90d, d180: s.ventas_propio_180d, d365: s.ventas_propio_365d }, encargo_sbs: { d30: s.ventas_encargo_30d, d90: s.ventas_encargo_90d, d180: s.ventas_encargo_180d, d365: s.ventas_encargo_365d },
          ultima_venta: s.ultima_venta, ultima_venta_propio: s.ultima_venta_propio, canceladas: s.unidades_canceladas, item_ids: s.item_ids, cobertura_desde: s.cobertura_desde, ventana_365d_completa: s.ventana_365d_completa },
        compras: { d30: p.unidades_30d, d90: p.unidades_90d, d180: p.unidades_180d, d365: p.unidades_365d, ultima_fecha: p.ultima_compra_fecha, ultima_cantidad: p.ultima_compra_cantidad, ultimo_proveedor: p.ultima_compra_proveedor, documentos: p.documentos, en_transito_estimado: p.en_transito_estimado, sin_isbn_posibles: p.compras_sin_isbn_posibles },
        sbs: sup.feed ? { disponible: sbsRow ? sbsRow.stock ?? null : 'no_figura', feed_fecha: sup.feed.source_date, feed_edad_dias: sbsAge, vigente: sbsAge <= SBS_STALE_DAYS } : { disponible: 'desconocida', feed_fecha: null },
        plazo_entrega_dias: SUPPLIER_LEAD_DAYS.default,
        fuente_incompleta: fuente, revisar,
        estado_datos: fuente.length ? 'FUENTE INCOMPLETA' : revisar.length ? 'REVISAR' : 'LISTO_PARA_DECIDIR',
      };
    });
    return { generado: new Date(now()).toISOString(), advertencias_globales: g.flags, cobertura_faltante: g.missing, resultados };
  }

  async function run(action, a, env, db) {
    if (action === 'estado') {
      const g = await globalState(env, db);
      return { salud: g.health, catalogo_actualizado: g.catalog_updated_at, cobertura_compras: g.coverage, proveedores_sin_cobertura: g.missing, advertencias_globales: g.flags };
    }
    if (action === 'reposicion_hechos') return facts(env, db, isbnList(args(a, ['isbns'])));
    if (action === 'candidatos') {
      const lim = limitArg(args(a, ['limite']), 50);
      const cat = await catalog(env);
      const top = (await topOwnSalesIsbns(db, { nowMs: now() })).filter(r => (cat.index.get(r.isbn)?.stock_propio ?? 0) <= 1).slice(0, lim);
      return top.length ? facts(env, db, top.map(r => r.isbn)) : { resultados: [] };
    }
    if (action === 'ventas_titulo') return { resultados: await salesByTitle(db, titleArg(args(a, ['titulo'])), now()) };
    if (action === 'compras_titulo') return { resultados: await purchasesByTitle(db, titleArg(args(a, ['titulo']))) };
    if (action === 'revision_identidad') {
      const lim = limitArg(args(a, ['limite']), 100);
      const { results } = await db.prepare(`SELECT i.item_id,MAX(i.title) AS titulo,MAX(i.seller_sku) AS sku,SUM(i.quantity) AS unidades,MAX(o.date_created) AS ultima
        FROM ml_sales_items i JOIN ml_sales_orders o ON o.order_id=i.order_id WHERE i.isbn IS NULL AND o.status<>'cancelled' GROUP BY i.item_id ORDER BY unidades DESC LIMIT ?`).bind(lim).all();
      return { ventas_sin_isbn: results, compras_sin_isbn: await purchasesWithoutIsbn(db, lim) };
    }
    throw new RepoError('unknown_action');
  }

  return async function handle(request, env) {
    try {
      const p = await verifyReposicionRequest(request, { now, publicKey });
      if (!ACTIONS.includes(p.action)) throw new RepoError('unknown_action');
      const db = env?.ORDERS_DB;
      if (!db) throw new RepoError('storage_not_configured', 503);
      await useNonce(db, p.jti, p.exp * 1000, now());
      const data = await run(p.action, p.args, env, db);
      return reply({ source: 'Amado D1', action: p.action, read_only: true, data });
    } catch (error) {
      return reply({ error: error instanceof RepoError ? error.code : 'internal_error' }, error instanceof RepoError ? error.status : 500);
    }
  };
}

export const handleReposicionRead = createReposicionReader();
