// Ventas reales de Mercado Libre (seller 440298103) en D1, para el motor de
// reposición. Sólo LEE Mercado Libre (GET /orders/search, /items/bulk,
// /products/{id}); nunca escribe en ML.
//
// - Backfill: recorre /orders/search por fecha de creación ascendente desde lo
//   más viejo que ML devuelva. El cursor vive en D1, así que cada invocación
//   retoma donde quedó.
// - Incremental: una vez completo el backfill, vuelve a leer las órdenes con
//   last_updated de los últimos días (cambios de estado, cancelaciones).
// - Idempotencia: PK order_id y (order_id, line_key). Re-ejecutar no duplica;
//   un estado nuevo sólo pisa al anterior si last_updated no retrocede.
// - Identidad: ISBN-13 canónico (SKU AMADO-AR-<ISBN>, atributos ISBN/GTIN/EAN o
//   producto de catálogo). Sin ISBN la venta se guarda igual, con título,
//   item_id y seller_sku para identificarla después por título.
// - Consulta: las ventas se agregan por ISBN, sumando todas las publicaciones
//   (propia + catálogo). Las órdenes canceladas/invalidas no cuentan.
import { getAccessToken } from './meli-auth.js';
import { bulkItemsPath, bulkEntryItem } from './meli-bulk.js';
import { normalizedTitle } from './publication-policy.js';

export const SALES_SELLER_ID = '440298103';
export const COUNTED_STATUSES = Object.freeze(['paid', 'partially_paid', 'partially_refunded']);
export const SALES_WINDOWS = Object.freeze([30, 90, 180, 365]);
const ML_ORIGIN = 'https://api.mercadolibre.com';
const PAGE_SIZE = 50, BULK_SIZE = 20, PRODUCT_LOOKUPS_PER_RUN = 25;
const BACKFILL_START = '2000-01-01T00:00:00.000-00:00';
const INCREMENTAL_EVERY_MS = 55 * 60 * 1000, INCREMENTAL_LOOKBACK_MS = 3 * 86400000, INCREMENTAL_MAX_PAGES = 20;
const IDENTITY_RETRY_MS = 7 * 86400000, LEASE_MS = 240000, DAY_MS = 86400000;
const ITEM_FIELDS = 'id,seller_id,title,seller_custom_field,catalog_product_id,attributes';
const ISBN_ATTRIBUTES = ['ISBN', 'GTIN', 'EAN', 'ISBN_13', 'ISBN_10', 'BAR_CODE'];

export const SALES_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ml_sales_orders(order_id TEXT PRIMARY KEY,seller_id TEXT NOT NULL,status TEXT NOT NULL,date_created TEXT NOT NULL,date_created_ms INTEGER NOT NULL,date_closed TEXT,last_updated TEXT,last_updated_ms INTEGER NOT NULL,total_amount REAL,currency_id TEXT,pack_id TEXT,tags_json TEXT,fetched_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ml_sales_orders_created ON ml_sales_orders(date_created_ms)`,
  `CREATE TABLE IF NOT EXISTS ml_sales_items(order_id TEXT NOT NULL,line_key TEXT NOT NULL,item_id TEXT NOT NULL,variation_id TEXT,title TEXT,title_key TEXT,seller_sku TEXT,quantity INTEGER NOT NULL,unit_price REAL,currency_id TEXT,isbn TEXT,gtin_raw TEXT,identity_source TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(order_id,line_key))`,
  `CREATE INDEX IF NOT EXISTS ml_sales_items_isbn ON ml_sales_items(isbn)`,
  `CREATE INDEX IF NOT EXISTS ml_sales_items_item ON ml_sales_items(item_id)`,
  `CREATE INDEX IF NOT EXISTS ml_sales_items_title ON ml_sales_items(title_key)`,
  `CREATE TABLE IF NOT EXISTS ml_sales_item_identity(item_id TEXT PRIMARY KEY,isbn TEXT,gtin_raw TEXT,source TEXT NOT NULL,title TEXT,author TEXT,publisher TEXT,seller_sku TEXT,catalog_product_id TEXT,checked_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ml_sales_sync_state(name TEXT PRIMARY KEY,cursor_json TEXT NOT NULL,lease_until INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,last_result_json TEXT)`,
];

export class SalesError extends Error {
  constructor(code, status = 502, retryAfter = null) { super(code); this.code = code; this.status = status; this.retryAfter = retryAfter; }
}

// ISBN-13 de libro (978/979) con dígito verificador válido; ISBN-10 se convierte.
export function bookIsbn(input) {
  let s = String(input ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(s)) {
    if ([...s].reduce((n, c, i) => n + (10 - i) * (c === 'X' ? 10 : Number(c)), 0) % 11 !== 0) return null;
    const stem = '978' + s.slice(0, 9);
    s = stem + ((10 - [...stem].reduce((n, c, i) => n + Number(c) * (i % 2 ? 3 : 1), 0) % 10) % 10);
  }
  if (!/^97[89]\d{10}$/.test(s)) return null;
  return [...s].reduce((n, c, i) => n + Number(c) * (i % 2 ? 3 : 1), 0) % 10 === 0 ? s : null;
}

function attributeValues(attributes, ids) {
  const out = [];
  for (const a of Array.isArray(attributes) ? attributes : []) {
    if (!ids.includes(String(a?.id ?? '').toUpperCase())) continue;
    for (const v of [a.value_name, ...(Array.isArray(a.values) ? a.values.map(x => x?.name) : [])]) {
      // Un mismo atributo puede traer varios códigos separados por coma o barra.
      for (const part of String(v ?? '').split(/[,;/|]/)) if (part.trim()) out.push(part.trim());
    }
  }
  return [...new Set(out)];
}
const firstValue = (attributes, ids) => attributeValues(attributes, ids)[0] ?? null;

// Identidad de una publicación a partir de su SKU y atributos. product = /products/{id} opcional.
export function resolveIdentity({ itemId, sellerSku, item, product }) {
  const base = { item_id: itemId, title: item?.title ?? null, seller_sku: sellerSku ?? item?.seller_custom_field ?? null,
    catalog_product_id: item?.catalog_product_id ?? null,
    author: firstValue(item?.attributes, ['AUTHOR']) ?? firstValue(product?.attributes, ['AUTHOR']),
    publisher: firstValue(item?.attributes, ['BOOK_PUBLISHER', 'PUBLISHER']) ?? firstValue(product?.attributes, ['BOOK_PUBLISHER', 'PUBLISHER']) };
  const sku = /^AMADO-AR-(\d{13})$/.exec(String(base.seller_sku ?? '').trim());
  if (sku && bookIsbn(sku[1])) return { ...base, isbn: bookIsbn(sku[1]), gtin_raw: sku[1], source: 'sku' };
  for (const [source, attrs] of [['attribute', item?.attributes], ['catalog_product', product?.attributes]]) {
    const raw = attributeValues(attrs, ISBN_ATTRIBUTES);
    const isbn = raw.map(bookIsbn).find(Boolean);
    if (isbn) return { ...base, isbn, gtin_raw: raw.join(','), source };
  }
  const raw = attributeValues(item?.attributes, ISBN_ATTRIBUTES).concat(attributeValues(product?.attributes, ISBN_ATTRIBUTES));
  return { ...base, isbn: null, gtin_raw: raw.length ? [...new Set(raw)].join(',') : null, source: 'none' };
}

// Una orden de ML → fila de orden + líneas (una por item/variación, cantidades sumadas).
export function projectOrder(order, now) {
  const created = Date.parse(order?.date_created), updated = Date.parse(order?.last_updated ?? order?.date_created);
  if (order?.id == null || !Number.isFinite(created) || typeof order.status !== 'string') throw new SalesError('unexpected_order');
  if (order.seller?.id != null && String(order.seller.id) !== SALES_SELLER_ID) throw new SalesError('foreign_order', 403);
  const lines = new Map();
  for (const line of Array.isArray(order.order_items) ? order.order_items : []) {
    const item = line?.item ?? {};
    if (typeof item.id !== 'string' || !/^MLU\d+$/.test(item.id)) continue;
    const variation = item.variation_id == null ? '' : String(item.variation_id);
    const key = `${item.id}:${variation}`;
    const quantity = Number(line.quantity) || 0;
    const prev = lines.get(key);
    if (prev) { prev.quantity += quantity; continue; }
    lines.set(key, { line_key: key, item_id: item.id, variation_id: variation || null, title: typeof item.title === 'string' ? item.title : null,
      seller_sku: item.seller_sku ?? item.seller_custom_field ?? null, quantity,
      unit_price: Number.isFinite(Number(line.unit_price)) ? Number(line.unit_price) : null, currency_id: line.currency_id ?? order.currency_id ?? null });
  }
  return {
    order: { order_id: String(order.id), seller_id: SALES_SELLER_ID, status: order.status, date_created: order.date_created, date_created_ms: created,
      date_closed: order.date_closed ?? null, last_updated: order.last_updated ?? order.date_created, last_updated_ms: Number.isFinite(updated) ? updated : created,
      total_amount: Number.isFinite(Number(order.total_amount)) ? Number(order.total_amount) : null, currency_id: order.currency_id ?? null,
      pack_id: order.pack_id == null ? null : String(order.pack_id), tags_json: JSON.stringify(Array.isArray(order.tags) ? order.tags : []), fetched_at: now },
    lines: [...lines.values()],
  };
}

export function createMlSales({ fetcher = (...a) => globalThis.fetch(...a), tokenProvider = getAccessToken, now = Date.now } = {}) {
  const ready = new WeakSet();
  async function ensure(db) {
    if (ready.has(db)) return;
    await db.batch(SALES_SCHEMA.map(sql => db.prepare(sql)));
    await db.prepare('INSERT OR IGNORE INTO ml_sales_sync_state(name,cursor_json,lease_until,updated_at) VALUES(?,?,0,?)')
      .bind('orders', JSON.stringify({ phase: 'backfill', from: BACKFILL_START, offset: 0 }), now()).run();
    ready.add(db);
  }
  const dbOf = env => {
    const db = env?.ORDERS_DB;
    if (!db || typeof db.prepare !== 'function') throw new SalesError('sales_storage_not_configured', 503);
    return db;
  };

  async function ml(path, token) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    let res;
    try { res = await fetcher(ML_ORIGIN + path, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'manual', signal: controller.signal }); }
    catch { throw new SalesError('ml_unreachable', 502); }
    finally { clearTimeout(timer); }
    if (!res.ok) throw new SalesError(`ml_http_${res.status}`, res.status === 429 ? 429 : res.status >= 500 ? 502 : res.status, Number(res.headers.get('Retry-After')) || null);
    try { return await res.json(); } catch { throw new SalesError('ml_bad_json'); }
  }

  async function searchOrders(token, params) {
    const query = new URLSearchParams({ seller: SALES_SELLER_ID, limit: String(PAGE_SIZE), ...params });
    const page = await ml(`/orders/search?${query}`, token);
    if (!Array.isArray(page?.results)) throw new SalesError('unexpected_orders_page');
    return page;
  }

  // Resuelve (y cachea en D1) la identidad de los item_id que todavía no la tienen.
  async function identities(db, token, lines, budget) {
    const ids = [...new Set(lines.map(l => l.item_id))];
    const known = new Map();
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const { results } = await db.prepare(`SELECT * FROM ml_sales_item_identity WHERE item_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
      for (const row of results) known.set(row.item_id, row);
    }
    const stale = ids.filter(id => { const r = known.get(id); return !r || (!r.isbn && now() - Number(r.checked_at) > IDENTITY_RETRY_MS); });
    const skuOf = new Map(lines.map(l => [l.item_id, l.seller_sku]));
    const fresh = [];
    for (let i = 0; i < stale.length; i += BULK_SIZE) {
      const chunk = stale.slice(i, i + BULK_SIZE);
      const raw = await ml(bulkItemsPath(chunk, ITEM_FIELDS), token);
      const items = new Map((Array.isArray(raw) ? raw : []).map(bulkEntryItem).filter(Boolean).map(it => [it.id, it]));
      for (const id of chunk) {
        const item = items.get(id) ?? null;
        if (item && item.seller_id != null && String(item.seller_id) !== SALES_SELLER_ID) continue;
        let identity = resolveIdentity({ itemId: id, sellerSku: skuOf.get(id), item });
        if (!identity.isbn && item?.catalog_product_id && budget.products > 0) {
          budget.products--;
          const product = await ml(`/products/${encodeURIComponent(item.catalog_product_id)}`, token).catch(() => null);
          if (product) identity = resolveIdentity({ itemId: id, sellerSku: skuOf.get(id), item, product });
        }
        if (!item) identity.title = lines.find(l => l.item_id === id)?.title ?? null;
        fresh.push(identity);
      }
    }
    if (fresh.length) {
      const t = now();
      await db.batch(fresh.flatMap(r => [
        db.prepare(`INSERT INTO ml_sales_item_identity(item_id,isbn,gtin_raw,source,title,author,publisher,seller_sku,catalog_product_id,checked_at) VALUES(?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(item_id) DO UPDATE SET isbn=excluded.isbn,gtin_raw=excluded.gtin_raw,source=excluded.source,title=excluded.title,author=excluded.author,publisher=excluded.publisher,seller_sku=excluded.seller_sku,catalog_product_id=excluded.catalog_product_id,checked_at=excluded.checked_at`)
          .bind(r.item_id, r.isbn, r.gtin_raw, r.source, r.title, r.author, r.publisher, r.seller_sku, r.catalog_product_id, t),
        // Líneas ya guardadas de ese item heredan la identidad nueva.
        db.prepare('UPDATE ml_sales_items SET isbn=?,gtin_raw=?,identity_source=? WHERE item_id=?').bind(r.isbn, r.gtin_raw, r.source, r.item_id),
      ]));
      for (const r of fresh) known.set(r.item_id, r);
    }
    return known;
  }

  async function storeOrders(db, token, orders, budget) {
    const t = now();
    const projected = orders.map(o => projectOrder(o, t));
    const lines = projected.flatMap(p => p.lines);
    const ids = await identities(db, token, lines, budget);
    const stmts = [];
    for (const { order: o, lines: ls } of projected) {
      stmts.push(db.prepare(`INSERT INTO ml_sales_orders(order_id,seller_id,status,date_created,date_created_ms,date_closed,last_updated,last_updated_ms,total_amount,currency_id,pack_id,tags_json,fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(order_id) DO UPDATE SET status=excluded.status,date_closed=excluded.date_closed,last_updated=excluded.last_updated,last_updated_ms=excluded.last_updated_ms,total_amount=excluded.total_amount,tags_json=excluded.tags_json,fetched_at=excluded.fetched_at
        WHERE excluded.last_updated_ms>=ml_sales_orders.last_updated_ms`)
        .bind(o.order_id, o.seller_id, o.status, o.date_created, o.date_created_ms, o.date_closed, o.last_updated, o.last_updated_ms, o.total_amount, o.currency_id, o.pack_id, o.tags_json, o.fetched_at));
      for (const l of ls) {
        const id = ids.get(l.item_id);
        stmts.push(db.prepare(`INSERT INTO ml_sales_items(order_id,line_key,item_id,variation_id,title,title_key,seller_sku,quantity,unit_price,currency_id,isbn,gtin_raw,identity_source,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(order_id,line_key) DO UPDATE SET title=excluded.title,title_key=excluded.title_key,seller_sku=excluded.seller_sku,quantity=excluded.quantity,unit_price=excluded.unit_price,isbn=excluded.isbn,gtin_raw=excluded.gtin_raw,identity_source=excluded.identity_source,updated_at=excluded.updated_at`)
          .bind(o.order_id, l.line_key, l.item_id, l.variation_id, l.title, normalizedTitle(l.title) || null, l.seller_sku, l.quantity, l.unit_price, l.currency_id, id?.isbn ?? null, id?.gtin_raw ?? null, id?.source ?? 'unresolved', t));
      }
    }
    for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80));
    return { orders: projected.length, lines: lines.length };
  }

  async function lease(db) {
    const t = now();
    const row = await db.prepare('UPDATE ml_sales_sync_state SET lease_until=? WHERE name=? AND lease_until<? RETURNING cursor_json,updated_at,last_result_json').bind(t + LEASE_MS, 'orders', t).first();
    return row ? JSON.parse(row.cursor_json) : null;
  }
  async function release(db, cursor, result) {
    await db.prepare('UPDATE ml_sales_sync_state SET cursor_json=?,lease_until=0,updated_at=?,last_result_json=? WHERE name=?')
      .bind(JSON.stringify(cursor), now(), JSON.stringify(result), 'orders').run();
  }

  // Avanza el backfill o, si ya terminó y toca, la actualización incremental.
  async function sync(env, { pages = 4, mode = 'auto', deadlineMs = 25000 } = {}) {
    const db = dbOf(env);
    await ensure(db);
    const started = now();
    let cursor = await lease(db);
    if (!cursor) return { state: 'busy' };
    const result = { state: 'idle', phase: cursor.phase, pages: 0, orders: 0, lines: 0 };
    const budget = { products: PRODUCT_LOOKUPS_PER_RUN };
    try {
      const token = await tokenProvider(env);
      if (typeof token !== 'string' || !token) throw new SalesError('auth_unavailable', 503);
      const wantBackfill = mode === 'backfill' || (mode === 'auto' && cursor.phase === 'backfill');
      if (wantBackfill) {
        if (mode === 'backfill' && cursor.phase !== 'backfill') cursor = { ...cursor, phase: 'backfill', from: BACKFILL_START, offset: 0 };
        result.state = 'backfill';
        while (result.pages < pages && now() - started < deadlineMs) {
          const page = await searchOrders(token, { 'order.date_created.from': cursor.from, sort: 'date_asc', offset: String(cursor.offset) });
          const stored = await storeOrders(db, token, page.results, budget);
          result.pages++; result.orders += stored.orders; result.lines += stored.lines;
          result.ml_total = page.paging?.total ?? null;
          if (page.results.length < PAGE_SIZE) {
            cursor = { phase: 'incremental', backfill_done_at: new Date(now()).toISOString(), last_incremental_ms: 0 };
            result.state = 'backfill_complete';
            break;
          }
          const last = page.results.at(-1).date_created;
          // Avanza por fecha (inclusive: los repetidos se absorben por la PK); si
          // toda la página comparte la misma fecha, avanza por offset.
          cursor = last === cursor.from ? { ...cursor, offset: cursor.offset + PAGE_SIZE } : { ...cursor, from: last, offset: 0 };
        }
        result.cursor_from = cursor.from ?? null;
      } else if (mode === 'incremental' || now() - Number(cursor.last_incremental_ms || 0) >= INCREMENTAL_EVERY_MS) {
        result.state = 'incremental';
        const since = new Date(now() - INCREMENTAL_LOOKBACK_MS).toISOString();
        let offset = 0, filter = { 'order.last_updated.from': since };
        while (result.pages < Math.max(pages, INCREMENTAL_MAX_PAGES) && now() - started < deadlineMs) {
          let page;
          try { page = await searchOrders(token, { ...filter, sort: 'date_desc', offset: String(offset) }); }
          catch (e) {
            // Si ML no acepta el filtro por last_updated, cae a fecha de creación (30 días).
            if (e.status === 400 && filter['order.last_updated.from']) { filter = { 'order.date_created.from': new Date(now() - 30 * DAY_MS).toISOString() }; result.filter = 'date_created'; continue; }
            throw e;
          }
          const stored = await storeOrders(db, token, page.results, budget);
          result.pages++; result.orders += stored.orders; result.lines += stored.lines;
          if (page.results.length < PAGE_SIZE) break;
          offset += PAGE_SIZE;
        }
        cursor = { ...cursor, last_incremental_ms: now() };
      }
      result.duration_ms = now() - started;
      await release(db, cursor, result);
      return result;
    } catch (error) {
      const failure = { ...result, state: 'error', code: error?.code || 'internal_error', retry_after: error?.retryAfter ?? null };
      await release(db, cursor, failure).catch(() => {});
      return failure;
    }
  }

  return { sync, ensure };
}

const placeholders = n => Array.from({ length: n }, () => '?').join(',');

function aggregate(rows, nowMs) {
  const windows = Object.fromEntries(SALES_WINDOWS.map(d => [`ventas_${d}d`, 0]));
  const out = { ...windows, unidades_totales: 0, unidades_canceladas: 0, ordenes: 0, ultima_venta: null, item_ids: [], titulos: [] };
  const items = new Set(), titles = new Set(), orders = new Set();
  let last = 0;
  for (const r of rows) {
    if (!COUNTED_STATUSES.includes(r.status)) { if (r.status === 'cancelled') out.unidades_canceladas += Number(r.quantity) || 0; continue; }
    const q = Number(r.quantity) || 0, age = nowMs - Number(r.date_created_ms);
    out.unidades_totales += q; orders.add(r.order_id); items.add(r.item_id);
    if (r.title) titles.add(r.title);
    for (const d of SALES_WINDOWS) if (age <= d * DAY_MS) out[`ventas_${d}d`] += q;
    if (Number(r.date_created_ms) > last) { last = Number(r.date_created_ms); out.ultima_venta = r.date_created; }
  }
  out.ordenes = orders.size; out.item_ids = [...items].sort(); out.titulos = [...titles].slice(0, 5);
  return out;
}

const SALES_ROWS = `SELECT i.order_id,i.item_id,i.title,i.title_key,i.isbn,i.quantity,o.status,o.date_created,o.date_created_ms
  FROM ml_sales_items i JOIN ml_sales_orders o ON o.order_id=i.order_id`;

// Hasta 50 ISBN → ventas agregadas por ISBN (todas las publicaciones sumadas).
export async function salesByIsbn(db, isbns, nowMs = Date.now()) {
  if (!Array.isArray(isbns) || isbns.length < 1 || isbns.length > 50) throw new SalesError('isbns_1_to_50', 400);
  const wanted = isbns.map(input => ({ input: String(input), isbn: bookIsbn(input) }));
  const valid = [...new Set(wanted.map(w => w.isbn).filter(Boolean))];
  const rows = valid.length ? (await db.prepare(`${SALES_ROWS} WHERE i.isbn IN (${placeholders(valid.length)})`).bind(...valid).all()).results : [];
  return wanted.map(w => w.isbn ? { isbn: w.isbn, ...aggregate(rows.filter(r => r.isbn === w.isbn), nowMs) } : { input: w.input, error: 'invalid_isbn' });
}

// Búsqueda por título (para ventas sin ISBN). Agrupa por ISBN si existe, si no por título normalizado.
export async function salesByTitle(db, title, nowMs = Date.now()) {
  const key = normalizedTitle(title);
  if (key.length < 3) throw new SalesError('title_too_short', 400);
  const { results } = await db.prepare(`${SALES_ROWS} WHERE i.title_key LIKE ? LIMIT 5000`).bind(`%${key}%`).all();
  const groups = new Map();
  for (const r of results) {
    const g = r.isbn ? `isbn:${r.isbn}` : `titulo:${r.title_key}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  return [...groups.entries()].map(([g, rows]) => ({ isbn: rows[0].isbn ?? null, identificado_por: rows[0].isbn ? 'isbn' : 'titulo', ...aggregate(rows, nowMs) }))
    .sort((a, b) => b.unidades_totales - a.unidades_totales).slice(0, 50);
}

export async function salesStatus(db) {
  const counts = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM ml_sales_orders) AS orders,
    (SELECT COUNT(*) FROM ml_sales_orders WHERE status IN (${COUNTED_STATUSES.map(s => `'${s}'`).join(',')})) AS orders_counted,
    (SELECT COUNT(*) FROM ml_sales_orders WHERE status='cancelled') AS orders_cancelled,
    (SELECT COUNT(*) FROM ml_sales_items) AS lines,
    (SELECT COUNT(*) FROM ml_sales_items WHERE isbn IS NOT NULL) AS lines_with_isbn,
    (SELECT COUNT(*) FROM ml_sales_items WHERE isbn IS NULL) AS lines_title_only,
    (SELECT COUNT(DISTINCT isbn) FROM ml_sales_items WHERE isbn IS NOT NULL) AS distinct_isbn,
    (SELECT MIN(date_created) FROM ml_sales_orders) AS first_order,
    (SELECT MAX(date_created) FROM ml_sales_orders) AS last_order`).first();
  const state = await db.prepare('SELECT cursor_json,lease_until,updated_at,last_result_json FROM ml_sales_sync_state WHERE name=?').bind('orders').first();
  const sources = (await db.prepare('SELECT identity_source AS source,COUNT(*) AS n FROM ml_sales_items GROUP BY identity_source').all()).results;
  return { ...counts, identity_sources: sources, cursor: state ? JSON.parse(state.cursor_json) : null, last_result: state?.last_result_json ? JSON.parse(state.last_result_json) : null, updated_at: state?.updated_at ?? null };
}

// Muestra de ISBN con ventas en ambas publicaciones o recientes, para verificación.
export async function salesSample(db, limit = 5, nowMs = Date.now()) {
  const { results } = await db.prepare(`SELECT i.isbn,COUNT(DISTINCT i.item_id) AS pubs,SUM(i.quantity) AS units FROM ml_sales_items i JOIN ml_sales_orders o ON o.order_id=i.order_id
    WHERE i.isbn IS NOT NULL AND o.status IN (${COUNTED_STATUSES.map(s => `'${s}'`).join(',')}) AND o.date_created_ms>=? GROUP BY i.isbn ORDER BY pubs DESC,units DESC LIMIT ?`).bind(nowMs - 365 * DAY_MS, Math.min(20, Math.max(1, limit))).all();
  return results.length ? salesByIsbn(db, results.map(r => r.isbn), nowMs) : [];
}

export const mlSales = createMlSales();

const reply = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

// Rutas /sales/* (detrás de SYNC_SECRET, validado en index.js).
export async function handleSalesRoute(request, env, service = mlSales) {
  const url = new URL(request.url);
  try {
    const db = env?.ORDERS_DB;
    if (!db) throw new SalesError('sales_storage_not_configured', 503);
    await service.ensure(db);
    if (request.method === 'GET' && url.pathname === '/sales/status') return reply(await salesStatus(db));
    if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    if (url.pathname === '/sales/sync') {
      const pages = Math.min(40, Math.max(1, Number(body.pages) || 20));
      const mode = ['auto', 'backfill', 'incremental'].includes(body.mode) ? body.mode : 'auto';
      return reply(await service.sync(env, { pages, mode }));
    }
    if (url.pathname === '/sales/query') {
      if (body.titulo !== undefined) return reply({ titulo: String(body.titulo), resultados: await salesByTitle(db, String(body.titulo)) });
      return reply({ resultados: await salesByIsbn(db, body.isbns) });
    }
    if (url.pathname === '/sales/sample') return reply({ resultados: await salesSample(db, Number(body.limit) || 5) });
    return reply({ error: 'not_found' }, 404);
  } catch (error) {
    return reply({ error: error?.code || 'internal_error' }, error?.status && error.status < 600 ? error.status : 500);
  }
}
