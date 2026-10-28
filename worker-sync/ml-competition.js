// Competencia en Mercado Libre por API oficial (sin Nubimetrics ni Administrado).
// Sólo LEE ML con el token propio: /products/{id}/items (quién vende el mismo
// producto de catálogo y a qué precio), /items/{id}/price_to_win (si ganamos el
// primer lugar) y /users/{id} (ventas totales del vendedor, para inferir).
//
// Una foto por día (fecha de Montevideo) de los productos que importan: los de
// catálogo de los libros que más vendemos (no las ~7.000 publicaciones). El
// cron de 5 minutos avanza por tandas con un cursor en D1.
//
// Integridad (regla de la casa): una foto cuenta como COMPLETA sólo si se leyó
// el listado entero de la ficha (todas las páginas). Una foto parcial, un error
// o una página faltante nunca equivale a "el competidor se quedó sin stock" ni
// a una venta. Las comparaciones usan siempre la última foto completa de cada
// producto, aunque la captura del día esté en curso, y dicen qué edad tiene.
// Cada corrida queda registrada (comp_runs) con cobertura, errores y límites.
//
// Los datos de terceros (vendedores, precios) quedan en D1: nunca en logs, en
// el repo ni en Actions. Un endpoint cerrado no rompe nada: se registra como
// capacidad no disponible y el resto sigue.
import { getAccessToken } from './meli-auth.js';
import { topOwnSalesIsbns, SALES_SELLER_ID } from './ml-sales.js';
import { bookIsbn } from './isbn.js';
import { bulkItemsPath, bulkEntryItem } from './meli-bulk.js';

const ML_ORIGIN = 'https://api.mercadolibre.com';
const DAY_MS = 86400000, HOUR_MS = 3600000, LEASE_MS = 240000, MAX_TARGETS = 400, MAX_SELLERS = 60, SNAPSHOT_VERSION = 4;
// Páginas del listado de una ficha por foto: más de eso se registra como parcial.
const MAX_PAGES = 5, RUNS_KEPT = 400;
export const OWN_CURRENCY = 'UYU';

// Días de preparación de una publicación (venta a pedido). 0 = entrega
// inmediata; null = no se sabe (ML no mandó sale_terms).
export function manufacturingDays(item) {
  if (!Array.isArray(item?.sale_terms)) return null;
  const t = item.sale_terms.find(x => x?.id === 'MANUFACTURING_TIME');
  if (!t) return 0;
  const n = Number(t.value_struct?.number ?? parseInt(String(t.value_name ?? ''), 10));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}
export const COMPETITION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS comp_targets(catalog_product_id TEXT PRIMARY KEY,isbn TEXT,own_item_ids TEXT,own_catalog_item_id TEXT,own_price REAL,priority INTEGER NOT NULL,updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS comp_snapshots(snap_date TEXT NOT NULL,catalog_product_id TEXT NOT NULL,item_id TEXT NOT NULL,seller_id TEXT NOT NULL,price REAL,currency_id TEXT,free_shipping INTEGER,logistic_type TEXT,is_winner INTEGER,fetched_at INTEGER NOT NULL,PRIMARY KEY(snap_date,catalog_product_id,item_id))`,
  `CREATE INDEX IF NOT EXISTS comp_snapshots_product ON comp_snapshots(catalog_product_id,snap_date)`,
  `CREATE TABLE IF NOT EXISTS comp_product_days(snap_date TEXT NOT NULL,catalog_product_id TEXT NOT NULL,status TEXT NOT NULL,winner_item_id TEXT,own_status TEXT,price_to_win REAL,fetched_at INTEGER NOT NULL,PRIMARY KEY(snap_date,catalog_product_id))`,
  `CREATE TABLE IF NOT EXISTS comp_seller_days(snap_date TEXT NOT NULL,seller_id TEXT NOT NULL,nickname TEXT,transactions_completed INTEGER,power_seller_status TEXT,fetched_at INTEGER NOT NULL,PRIMARY KEY(snap_date,seller_id))`,
  `CREATE TABLE IF NOT EXISTS comp_state(name TEXT PRIMARY KEY,cursor_json TEXT NOT NULL,lease_until INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,last_result_json TEXT)`,
  // Registro de cada corrida: qué se leyó, cuánto cupo se usó, qué falló.
  `CREATE TABLE IF NOT EXISTS comp_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,started_at INTEGER NOT NULL,duration_ms INTEGER NOT NULL,snap_date TEXT,state TEXT NOT NULL,phase TEXT,products INTEGER NOT NULL DEFAULT 0,products_ok INTEGER NOT NULL DEFAULT 0,products_partial INTEGER NOT NULL DEFAULT 0,products_error INTEGER NOT NULL DEFAULT 0,sellers INTEGER NOT NULL DEFAULT 0,calls_used INTEGER NOT NULL DEFAULT 0,code TEXT,caps_json TEXT)`,
];

export const montevideoDate = ms => new Date(ms - 3 * 3600000).toISOString().slice(0, 10);

class CompError extends Error { constructor(code, status = 502) { super(code); this.code = code; this.status = status; } }

export function createMlCompetition({ fetcher = (...a) => globalThis.fetch(...a), tokenProvider = getAccessToken, now = Date.now, loadCatalog = null } = {}) {
  const ready = new WeakSet();
  async function ensure(db) {
    if (ready.has(db)) return;
    await db.batch(COMPETITION_SCHEMA.map(sql => db.prepare(sql)));
    // Columnas agregadas después (ALTER aditivo): condición, envío internacional,
    // días de preparación, y la cobertura del listado (paginación) por foto.
    const cols = async table => new Set((await db.prepare(`PRAGMA table_info(${table})`).all()).results.map(c => c.name));
    const snapCols = await cols('comp_snapshots');
    for (const [col, type] of [['condition', 'TEXT'], ['international', 'INTEGER'], ['manufacturing_days', 'INTEGER']]) if (!snapCols.has(col)) await db.prepare(`ALTER TABLE comp_snapshots ADD COLUMN ${col} ${type}`).run();
    const dayCols = await cols('comp_product_days');
    for (const [col, type] of [['items_total', 'INTEGER'], ['items_fetched', 'INTEGER'], ['pages', 'INTEGER'], ['bulk_pending', 'INTEGER'], ['code', 'TEXT']]) if (!dayCols.has(col)) await db.prepare(`ALTER TABLE comp_product_days ADD COLUMN ${col} ${type}`).run();
    await db.prepare('INSERT OR IGNORE INTO comp_state(name,cursor_json,lease_until,updated_at) VALUES(?,?,0,?)').bind('daily', '{}', now()).run();
    ready.add(db);
  }

  async function ml(path, token) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    let res;
    try { res = await fetcher(ML_ORIGIN + path, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'manual', signal: controller.signal }); }
    catch { throw new CompError('ml_unreachable'); }
    finally { clearTimeout(timer); }
    if (!res.ok) throw new CompError(`ml_http_${res.status}`, res.status);
    try { return await res.json(); } catch { throw new CompError('ml_bad_json'); }
  }

  // Productos a vigilar: los de catálogo de los libros con más ventas propias.
  async function buildTargets(db, catalog) {
    const byIsbn = new Map();
    for (const item of Array.isArray(catalog?.items) ? catalog.items : []) {
      const isbn = bookIsbn(item?.isbn);
      const pid = typeof item?.catalog_product_id === 'string' ? item.catalog_product_id.trim().toUpperCase() : '';
      if (!isbn || !pid) continue;
      const entry = byIsbn.get(isbn) ?? { pid, items: [], catalogItem: null, price: null };
      entry.items.push(item.id);
      if (item.catalog_listing === true && item.status === 'active') entry.catalogItem = item.id;
      if (item.status === 'active' && Number.isFinite(Number(item.price))) entry.price = entry.price == null ? Number(item.price) : Math.min(entry.price, Number(item.price));
      byIsbn.set(isbn, entry);
    }
    const top = await topOwnSalesIsbns(db, { minUnits365: 1, limit: MAX_TARGETS * 2, nowMs: now() });
    // Los que se agotaron y ya no están en el catálogo: el producto de catálogo
    // sale de la identidad de sus ventas, para saber si otro lo vende hoy.
    const missing = top.map(r => r.isbn).filter(isbn => !byIsbn.has(isbn));
    if (missing.length) {
      try {
        const { results } = await db.prepare(`SELECT isbn, MAX(catalog_product_id) AS pid FROM ml_sales_item_identity
          WHERE isbn IN (SELECT value FROM json_each(?)) AND catalog_product_id IS NOT NULL AND catalog_product_id<>'' GROUP BY isbn`).bind(JSON.stringify(missing)).all();
        for (const r of results) byIsbn.set(r.isbn, { pid: String(r.pid).trim().toUpperCase(), items: [], catalogItem: null, price: null });
      } catch { /* sin identidades: sólo lo del catálogo */ }
    }
    const rows = [];
    for (const r of top) {
      const e = byIsbn.get(r.isbn);
      if (!e || rows.some(x => x.pid === e.pid)) continue;
      rows.push({ ...e, isbn: r.isbn });
      if (rows.length >= MAX_TARGETS) break;
    }
    const t = now();
    const stmts = [db.prepare('DELETE FROM comp_targets')];
    rows.forEach((e, i) => stmts.push(db.prepare('INSERT INTO comp_targets(catalog_product_id,isbn,own_item_ids,own_catalog_item_id,own_price,priority,updated_at) VALUES(?,?,?,?,?,?,?)')
      .bind(e.pid, e.isbn, JSON.stringify(e.items), e.catalogItem, e.price, MAX_TARGETS - i, t)));
    for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80));
    return rows.length;
  }

  // Listado completo de la ficha, página por página. Devuelve también cuántos
  // dice ML que hay (paging.total) y cuántos se leyeron: si no coinciden, la
  // foto es parcial y no sirve para inferir ausencias.
  async function listProductItems(pid, token) {
    const items = [], seen = new Set();
    let offset = 0, pages = 0, total = null, code = null;
    while (pages < MAX_PAGES) {
      let data;
      try { data = await ml(`/products/${encodeURIComponent(pid)}/items${offset ? `?offset=${offset}` : ''}`, token); }
      catch (e) { if (e.status === 429 || !pages) throw e; code = e.code; break; }
      pages++;
      const page = Array.isArray(data?.results) ? data.results : [];
      let added = 0;
      for (const it of page) { const id = typeof it?.item_id === 'string' ? it.item_id : null; if (!id || seen.has(id)) continue; seen.add(id); items.push(it); added++; }
      const t = Number(data?.paging?.total);
      total = Number.isFinite(t) && t >= 0 ? t : (total ?? items.length);
      const limit = Number(data?.paging?.limit) > 0 ? Number(data.paging.limit) : page.length;
      offset += limit;
      // Sin avance (ML ignora offset o repite), o ya está todo: se corta.
      if (!added || items.length >= total) break;
    }
    if (total == null) total = items.length;
    return { items, total, fetched: items.length, pages, complete: !code && items.length >= total, code };
  }

  async function snapProduct(db, token, target, date, caps) {
    const t = now();
    let listing = null, errorCode = null, ptw = null, calls = 0;
    try {
      listing = await listProductItems(target.catalog_product_id, token);
      calls += listing.pages;
      caps.products_items = 'ok';
    } catch (e) { caps.products_items = e.code; errorCode = e.code; calls++; if (e.status === 429) throw e; }
    const items = listing?.items ?? null;
    if (target.own_catalog_item_id && caps.price_to_win !== 'ml_http_403' && caps.price_to_win !== 'ml_http_404') {
      calls++;
      try { ptw = await ml(`/items/${encodeURIComponent(target.own_catalog_item_id)}/price_to_win?version=v2`, token); caps.price_to_win = 'ok'; }
      catch (e) { caps.price_to_win = e.code; if (e.status === 429) throw e; }
    }
    const winner = ptw?.winner?.item_id ?? null;
    // Condición y días de preparación de cada competidor salen siempre de
    // /items/bulk: el listado del catálogo no trae el plazo de preparación.
    // Si ML no lo manda, queda sin dato (null), nunca como entrega inmediata.
    const competitors = (items ?? []).filter(it => String(it.seller_id ?? '') !== SALES_SELLER_ID).map(it => it.item_id);
    const extra = new Map();
    if (competitors.length && caps.items_bulk !== 'ml_http_403' && caps.items_bulk !== 'ml_http_401') {
      for (let i = 0; i < competitors.length; i += 20) {
        try {
          const raw = await ml(bulkItemsPath(competitors.slice(i, i + 20), 'id,condition,shipping,international_delivery_mode,sale_terms'), token);
          calls++; caps.items_bulk = 'ok';
          for (const item of (Array.isArray(raw) ? raw : []).map(bulkEntryItem).filter(Boolean)) extra.set(item.id, item);
        } catch (e) { calls++; caps.items_bulk = e.code; if (e.status === 429) throw e; break; }
      }
    }
    let bulkPending = 0;
    const stmts = [];
    if (items) for (const it of items) {
      const x = extra.get(it.item_id);
      const own = String(it.seller_id ?? '') === SALES_SELLER_ID;
      if (!own && !x) bulkPending++;
      const condition = typeof it.condition === 'string' ? it.condition : typeof x?.condition === 'string' ? x.condition : null;
      const intlMode = typeof it.international_delivery_mode === 'string' ? it.international_delivery_mode : typeof x?.international_delivery_mode === 'string' ? x.international_delivery_mode : null;
      const shipping = it.shipping ?? x?.shipping ?? null;
      const days = own ? 0 : manufacturingDays({ sale_terms: Array.isArray(x?.sale_terms) ? x.sale_terms : undefined });
      stmts.push(db.prepare(`INSERT INTO comp_snapshots(snap_date,catalog_product_id,item_id,seller_id,price,currency_id,free_shipping,logistic_type,is_winner,fetched_at,condition,international,manufacturing_days) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(snap_date,catalog_product_id,item_id) DO UPDATE SET price=excluded.price,currency_id=excluded.currency_id,free_shipping=excluded.free_shipping,logistic_type=excluded.logistic_type,is_winner=excluded.is_winner,fetched_at=excluded.fetched_at,condition=excluded.condition,international=excluded.international,manufacturing_days=excluded.manufacturing_days`)
        .bind(date, target.catalog_product_id, it.item_id, String(it.seller_id ?? ''), Number.isFinite(Number(it.price)) ? Number(it.price) : null, typeof it.currency_id === 'string' ? it.currency_id : null,
          shipping?.free_shipping ? 1 : 0, shipping?.logistic_type ?? null, winner && winner === it.item_id ? 1 : 0, t,
          condition, intlMode ? (intlMode !== 'none' ? 1 : 0) : null, days));
    }
    const status = !items ? 'error' : listing.complete ? 'ok' : 'partial';
    stmts.push(db.prepare(`INSERT INTO comp_product_days(snap_date,catalog_product_id,status,winner_item_id,own_status,price_to_win,fetched_at,items_total,items_fetched,pages,bulk_pending,code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(snap_date,catalog_product_id) DO UPDATE SET status=excluded.status,winner_item_id=excluded.winner_item_id,own_status=excluded.own_status,price_to_win=excluded.price_to_win,fetched_at=excluded.fetched_at,items_total=excluded.items_total,items_fetched=excluded.items_fetched,pages=excluded.pages,bulk_pending=excluded.bulk_pending,code=excluded.code`)
      .bind(date, target.catalog_product_id, status, winner, typeof ptw?.status === 'string' ? ptw.status : null, Number.isFinite(Number(ptw?.price_to_win)) ? Number(ptw.price_to_win) : null, t,
        listing?.total ?? null, listing?.fetched ?? null, listing?.pages ?? 0, bulkPending, errorCode ?? listing?.code ?? null));
    await db.batch(stmts);
    return { status, calls };
  }

  async function snapSeller(db, token, sellerId, date, caps) {
    try {
      const u = await ml(`/users/${encodeURIComponent(sellerId)}`, token);
      caps.users = 'ok';
      await db.prepare(`INSERT INTO comp_seller_days(snap_date,seller_id,nickname,transactions_completed,power_seller_status,fetched_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(snap_date,seller_id) DO UPDATE SET nickname=excluded.nickname,transactions_completed=excluded.transactions_completed,power_seller_status=excluded.power_seller_status,fetched_at=excluded.fetched_at`)
        .bind(date, sellerId, typeof u?.nickname === 'string' ? u.nickname : null, Number.isFinite(Number(u?.seller_reputation?.transactions?.completed)) ? Number(u.seller_reputation.transactions.completed) : null,
          u?.seller_reputation?.power_seller_status ?? null, now()).run();
    } catch (e) { caps.users = e.code; if (e.status === 429) throw e; }
  }

  async function logRun(db, started, result, cursor) {
    try {
      await db.prepare(`INSERT INTO comp_runs(started_at,duration_ms,snap_date,state,phase,products,products_ok,products_partial,products_error,sellers,calls_used,code,caps_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(started, result.duration_ms, cursor?.date ?? null, result.state, cursor?.phase ?? null, result.products, result.products_ok, result.products_partial, result.products_error, result.sellers, result.calls_used, result.code ?? null, JSON.stringify(result.caps ?? {})).run();
      await db.prepare('DELETE FROM comp_runs WHERE id<(SELECT MAX(id) FROM comp_runs)-?').bind(RUNS_KEPT).run();
    } catch { /* el registro nunca frena la captura */ }
  }

  async function sync(env, { calls = 40, deadlineMs = 20000 } = {}) {
    const started = now();
    const db = env?.ORDERS_DB;
    if (!db) return { state: 'error', code: 'storage_not_configured' };
    await ensure(db);
    const token_ = started + LEASE_MS;
    const row = await db.prepare('UPDATE comp_state SET lease_until=? WHERE name=? AND lease_until<? RETURNING cursor_json').bind(token_, 'daily', started).first();
    if (!row) return { state: 'busy' };
    let cursor = JSON.parse(row.cursor_json || '{}');
    const budget = calls;
    const result = { state: 'idle', products: 0, products_ok: 0, products_partial: 0, products_error: 0, sellers: 0, calls_used: 0 };
    const date = montevideoDate(started);
    const hasTime = () => calls > 0 && now() - started < deadlineMs;
    try {
      // Una versión nueva de la foto rehace la del día (más datos por competidor).
      if (cursor.date !== date || cursor.v !== SNAPSHOT_VERSION) {
        const loader = loadCatalog ?? (async () => { const obj = await env.CATALOG_R2?.get('catalog.json'); return obj ? obj.json() : null; });
        const catalog = await loader();
        if (!catalog) throw new CompError('catalog_unavailable', 503);
        result.targets = await buildTargets(db, catalog);
        cursor = { date, v: SNAPSHOT_VERSION, phase: 'products', offset: 0, fails: 0, okToday: 0, partialToday: 0, errorToday: 0, caps: cursor.caps ?? {} };
      }
      const caps = cursor.caps ?? {};
      if (cursor.phase === 'products' && hasTime()) {
        const token = await tokenProvider(env);
        result.state = 'products';
        while (hasTime()) {
          const t = await db.prepare('SELECT * FROM comp_targets ORDER BY priority DESC LIMIT 1 OFFSET ?').bind(cursor.offset).first();
          if (!t) {
            if (!cursor.okToday && cursor.fails) { cursor = { ...cursor, phase: 'done' }; result.state = 'products_endpoint_unavailable'; }
            else cursor = { ...cursor, phase: 'sellers', offset: 0 };
            break;
          }
          const { status, calls: used } = await snapProduct(db, token, t, date, caps);
          calls -= used; cursor.offset++; result.products++;
          const ok = status !== 'error';
          cursor.fails = ok ? 0 : (cursor.fails ?? 0) + 1;
          cursor.okToday = (cursor.okToday ?? 0) + (status === 'ok' ? 1 : 0);
          cursor.partialToday = (cursor.partialToday ?? 0) + (status === 'partial' ? 1 : 0);
          cursor.errorToday = (cursor.errorToday ?? 0) + (ok ? 0 : 1);
          result[status === 'ok' ? 'products_ok' : status === 'partial' ? 'products_partial' : 'products_error']++;
          // Si los primeros productos del día fallan todos, el endpoint está cerrado:
          // no tiene sentido seguir quemando cupo hasta mañana.
          if (!cursor.okToday && !cursor.partialToday && cursor.fails >= 3) { cursor = { ...cursor, phase: 'done' }; result.state = 'products_endpoint_unavailable'; break; }
        }
      }
      if (cursor.phase === 'sellers' && hasTime()) {
        const token = await tokenProvider(env);
        result.state = 'sellers';
        // Vendedores de hoy y de la foto anterior: el que dejó de ofrecer un libro
        // también se lee, para comparar su contador de ventas.
        const { results } = await db.prepare(`SELECT seller_id,COUNT(DISTINCT catalog_product_id) AS n FROM comp_snapshots
          WHERE (snap_date=? OR snap_date=(SELECT MAX(snap_date) FROM comp_snapshots WHERE snap_date<?)) AND seller_id<>? AND seller_id<>''
          GROUP BY seller_id ORDER BY n DESC LIMIT ?`).bind(date, date, SALES_SELLER_ID, MAX_SELLERS).all();
        while (hasTime() && cursor.offset < results.length) {
          await snapSeller(db, token, results[cursor.offset].seller_id, date, caps);
          calls--; cursor.offset++; result.sellers++;
        }
        if (cursor.offset >= results.length) { cursor = { ...cursor, phase: 'done' }; result.state = 'done'; }
      }
      cursor.caps = caps;
      result.caps = caps;
    } catch (error) {
      Object.assign(result, { state: 'error', code: error?.code || 'internal_error' });
    }
    result.duration_ms = now() - started;
    result.calls_used = Math.max(0, budget - calls);
    result.calls_budget = budget;
    await db.prepare('UPDATE comp_state SET cursor_json=?,lease_until=0,updated_at=?,last_result_json=? WHERE name=? AND lease_until=?')
      .bind(JSON.stringify(cursor), now(), JSON.stringify(result), 'daily', token_).run().catch(() => {});
    // Las corridas sin trabajo (nada que leer, o fuera de horario) no se anotan.
    if (result.products || result.sellers || result.targets != null || result.state === 'error' || result.state === 'products_endpoint_unavailable') await logRun(db, started, result, cursor);
    return result;
  }

  return { sync, ensure };
}

export const mlCompetition = createMlCompetition();

const money = v => v == null ? '—' : `$ ${Math.round(v).toLocaleString('es-UY')}`;

// Últimas dos fotos COMPLETAS (status ok) de cada producto, y la última foto de
// cualquier estado (para decir si hay una captura en curso, parcial o fallida).
async function productDays(db, pids) {
  const win = `SELECT *, ROW_NUMBER() OVER (PARTITION BY catalog_product_id ORDER BY snap_date DESC) AS rn FROM comp_product_days WHERE catalog_product_id IN (SELECT value FROM json_each(?))`;
  const [complete, latest] = (await Promise.all([
    db.prepare(`SELECT * FROM (${win.replace('WHERE', "WHERE status='ok' AND")}) WHERE rn<=2`).bind(pids).all(),
    db.prepare(`SELECT * FROM (${win}) WHERE rn=1`).bind(pids).all(),
  ])).map(r => r.results);
  const byPid = new Map();
  for (const r of complete) { const e = byPid.get(r.catalog_product_id) ?? { today: null, prev: null, latest: null }; if (r.rn === 1) e.today = r; else e.prev = r; byPid.set(r.catalog_product_id, e); }
  for (const r of latest) { const e = byPid.get(r.catalog_product_id) ?? { today: null, prev: null, latest: null }; e.latest = r; byPid.set(r.catalog_product_id, e); }
  return byPid;
}

// Hechos de competencia por ISBN comparando la última foto completa de cada
// producto con la anterior completa. Pocas consultas en total (json_each), no
// una por producto: el panel en Pages tiene tope de consultas a D1 por request.
//
// Etiquetas: lo que se vio en la ficha es "observado"; la venta que se infiere
// de un vendedor que dejó de ofrecer el libro es "estimado" (su contador de
// ventas es de toda su cuenta, no de este ISBN); un competidor sin condición
// o sin plazo de entrega legible es "desconocido" y no entra en precios.
export async function competitionByIsbn(db, isbns, nowMs = Date.now()) {
  const out = new Map();
  const valid = [...new Set(isbns.filter(Boolean))];
  if (!valid.length) return out;
  let targets, days;
  try {
    targets = (await db.prepare('SELECT * FROM comp_targets WHERE isbn IN (SELECT value FROM json_each(?))').bind(JSON.stringify(valid)).all()).results;
    if (!targets.length) return out;
    days = await productDays(db, JSON.stringify(targets.map(t => t.catalog_product_id)));
  } catch { return out; }
  const dates = new Set();
  for (const e of days.values()) for (const r of [e.today, e.prev]) if (r) dates.add(r.snap_date);
  if (!dates.size) return out;
  const pids = JSON.stringify(targets.map(t => t.catalog_product_id)), inDates = JSON.stringify([...dates]);
  const [snaps, sellers] = (await Promise.all([
    db.prepare(`SELECT * FROM comp_snapshots WHERE snap_date IN (SELECT value FROM json_each(?)) AND catalog_product_id IN (SELECT value FROM json_each(?))`).bind(inDates, pids).all(),
    db.prepare(`SELECT * FROM comp_seller_days WHERE snap_date IN (SELECT value FROM json_each(?))`).bind(inDates).all(),
  ])).map(r => r.results);
  const sellerDay = new Map(sellers.map(r => [`${r.snap_date}|${r.seller_id}`, r]));
  for (const t of targets) {
    const d = days.get(t.catalog_product_id);
    const pd = d?.today;
    if (!pd) continue;
    const today = pd.snap_date, pdPrev = d.prev, prev = pdPrev?.snap_date ?? null;
    const name = sid => sellerDay.get(`${today}|${sid}`)?.nickname ?? (prev ? sellerDay.get(`${prev}|${sid}`)?.nickname : null) ?? `vendedor ${sid}`;
    const rows = snaps.filter(r => r.catalog_product_id === t.catalog_product_id);
    const others = dd => rows.filter(r => r.snap_date === dd && r.seller_id !== SALES_SELLER_ID);
    const ownToday = rows.some(r => r.snap_date === today && r.seller_id === SALES_SELLER_ID);
    const hoy = others(today), ayer = prev ? others(prev) : [];
    const sellersHoy = new Set(hoy.map(r => r.seller_id)), sellersAyer = new Set(ayer.map(r => r.seller_id));
    // Precio justo: sólo competidores nuevos (no usados), nacionales, en pesos,
    // con entrega inmediata (sin días de preparación) y con el mismo tipo de
    // envío que nuestra publicación. Los que venden a pedido tardan semanas: no
    // le compiten a un libro en stock. Si algo no se pudo saber, no se compara.
    const ownRow = rows.find(r => r.snap_date === today && r.seller_id === SALES_SELLER_ID) ?? null;
    const enPesos = hoy.filter(r => r.price != null && (r.currency_id == null || r.currency_id === OWN_CURRENCY));
    const otraMoneda = hoy.filter(r => r.price != null && r.currency_id != null && r.currency_id !== OWN_CURRENCY).length;
    const desconocidos = enPesos.filter(r => r.condition == null || r.manufacturing_days == null || r.international == null).length;
    const nuevosNacionales = enPesos.filter(r => r.condition === 'new' && r.international === 0 && r.manufacturing_days != null);
    const aPedido = nuevosNacionales.filter(r => Number(r.manufacturing_days) > 0);
    const comparables = nuevosNacionales.filter(r => Number(r.manufacturing_days) === 0
      && (ownRow ? Number(r.free_shipping) === Number(ownRow.free_shipping) : true));
    const minAPedido = aPedido.reduce((m, r) => (m == null || r.price < m) ? r.price : m, null);
    const minPrice = comparables.reduce((m, r) => (m == null || r.price < m) ? r.price : m, null);
    const ownPrice = ownRow?.price ?? t.own_price;
    const excluidos = hoy.length - comparables.length;
    const avisos = [];
    // Vendedores que dejaron de ofrecerlo: sólo entre dos fotos completas (si
    // alguna página faltó, un ausente puede ser un no leído). La venta nunca se
    // afirma: el contador es de toda la cuenta del vendedor.
    for (const s of sellersAyer) {
      if (sellersHoy.has(s)) continue;
      const a = sellerDay.get(`${prev}|${s}`), b = sellerDay.get(`${today}|${s}`);
      const subio = a?.transactions_completed != null && b?.transactions_completed != null && b.transactions_completed > a.transactions_completed;
      avisos.push({ tipo: 'competidor_sin_stock', etiqueta: subio ? 'estimado' : 'observado', texto: `${name(s)} dejó de ofrecer este libro en el catálogo${subio ? ` (estimado: su contador de ventas subió ${b.transactions_completed - a.transactions_completed}; puede ser cualquier otro libro)` : ''}.` });
    }
    if (prev) for (const s of sellersHoy) if (!sellersAyer.has(s)) avisos.push({ tipo: 'competidor_nuevo', etiqueta: 'observado', texto: `Competidor nuevo: ${name(s)} a ${money(hoy.find(r => r.seller_id === s)?.price)}.` });
    if (ownToday && !hoy.length) avisos.push({ tipo: 'solos_en_catalogo', etiqueta: 'observado', texto: 'No detectamos otra oferta en esta ficha de catálogo de ML (fuente: foto diaria por API).' });
    else if (ownToday && !comparables.length && aPedido.length) avisos.push({ tipo: 'solos_en_catalogo', etiqueta: 'observado', texto: `Sos el único con entrega inmediata en la ficha: los otros ${aPedido.length} lo venden a pedido (desde ${money(minAPedido)}).` });
    const winning = pd.own_status === 'winning', winningPrev = pdPrev?.own_status === 'winning';
    if (pdPrev?.own_status && pd.own_status && winning !== winningPrev) {
      avisos.push(winning ? { tipo: 'primer_lugar_ganado', etiqueta: 'observado', texto: 'Ganaste el primer lugar del catálogo.' }
        : { tipo: 'primer_lugar_perdido', etiqueta: 'observado', texto: `Perdiste el primer lugar del catálogo${pd.price_to_win ? `: para ganar, ${money(pd.price_to_win)}` : ''}.` });
    }
    const rel = ownPrice && minPrice ? ownPrice / minPrice : null;
    const ref = `del más barato con entrega inmediata${ownRow ? (Number(ownRow.free_shipping) ? ' con envío gratis' : ' sin envío gratis') : ''}`;
    if (rel && rel >= 1.15) avisos.push({ tipo: 'precio_arriba', etiqueta: 'observado', texto: `Tu precio (${money(ownPrice)}) está ${Math.round((rel - 1) * 100)}% arriba ${ref} (${money(minPrice)}).` });
    if (rel && rel <= 0.9) avisos.push({ tipo: 'precio_abajo', etiqueta: 'observado', texto: `Tu precio (${money(ownPrice)}) está ${Math.round((1 - rel) * 100)}% abajo ${ref} (${money(minPrice)}): podrías estar regalando margen.` });
    const latest = d.latest;
    const captura = latest && latest.snap_date > today ? { estado: latest.status === 'partial' ? 'parcial' : 'error', fecha: latest.snap_date, leidos: latest.items_fetched ?? null, total: latest.items_total ?? null, codigo: latest.code ?? null } : null;
    out.set(t.isbn, {
      catalog_product_id: t.catalog_product_id, foto: today, foto_anterior: prev, foto_edad_horas: Math.max(0, Math.round((nowMs - Number(pd.fetched_at)) / HOUR_MS)),
      foto_completa: true, captura_posterior: captura, listado: { total: pd.items_total ?? null, leidos: pd.items_fetched ?? null, sin_detalle: pd.bulk_pending ?? 0 },
      competidores: sellersHoy.size, competidores_comparables: comparables.length, excluidos_de_precio: excluidos,
      competidores_a_pedido: aPedido.length, precio_minimo_a_pedido: minAPedido, otra_moneda: otraMoneda, desconocidos,
      precio_minimo: minPrice, tu_precio: ownPrice, precio_relativo: rel ? Math.round(rel * 100) / 100 : null,
      primer_lugar: pd.own_status ?? null, precio_para_ganar: pd.price_to_win ?? null,
      vendedores: [...sellersHoy].slice(0, 8).map(s => { const r = hoy.find(x => x.seller_id === s); return { vendedor: name(s), precio: r?.price ?? null, moneda: r?.currency_id ?? null, full: hoy.some(x => x.seller_id === s && x.logistic_type === 'fulfillment'), dias_preparacion: r?.manufacturing_days ?? null, condicion: r?.condition ?? null }; }),
      etiquetas: { competidores: 'observado', precio_minimo: minPrice != null ? 'observado' : 'desconocido', ventas_competidor: 'desconocido' },
      avisos,
    });
  }
  return out;
}

// Eventos del día en todos los productos vigilados (para el panel, el correo y GPT).
export async function competitionEvents(db, { limit = 30 } = {}) {
  let targets;
  try { targets = (await db.prepare('SELECT isbn FROM comp_targets ORDER BY priority DESC').all()).results; } catch { return { foto: null, eventos: [], vigilados: 0 }; }
  const facts = await competitionByIsbn(db, targets.map(t => t.isbn));
  const order = ['primer_lugar_perdido', 'competidor_sin_stock', 'solos_en_catalogo', 'precio_arriba', 'competidor_nuevo', 'primer_lugar_ganado', 'precio_abajo'];
  const eventos = [];
  for (const t of targets) {
    const f = facts.get(t.isbn);
    if (!f) continue;
    for (const a of f.avisos) eventos.push({ isbn: t.isbn, foto: f.foto, ...a });
  }
  eventos.sort((a, b) => order.indexOf(a.tipo) - order.indexOf(b.tipo));
  const foto = [...facts.values()].reduce((m, f) => (f.foto > (m ?? '') ? f.foto : m), null);
  const porTipo = eventos.reduce((m, e) => (m[e.tipo] = (m[e.tipo] ?? 0) + 1, m), {});
  return { foto, vigilados: targets.length, con_foto_completa: facts.size, por_tipo: porTipo, eventos: eventos.slice(0, limit) };
}

export async function competitionStatus(db) {
  try {
    const s = await db.prepare('SELECT cursor_json,updated_at,last_result_json FROM comp_state WHERE name=?').bind('daily').first();
    const n = await db.prepare('SELECT COUNT(*) AS n FROM comp_targets').first();
    return s ? { cursor: JSON.parse(s.cursor_json), updated_at: Number(s.updated_at), last: s.last_result_json ? JSON.parse(s.last_result_json) : null, vigilados: Number(n?.n ?? 0) } : null;
  } catch { return null; }
}

// Cobertura y frescura de la vigilancia, por segmento, para el panel y GPT:
// cuántas fichas se revisaron hoy (completas, parciales, con error), cuántas
// faltan, qué edad tiene la foto completa más vieja, y qué parte del catálogo
// queda fuera del radar (sin ficha de catálogo ML no hay listado comparable).
export async function competitionCoverage(db, catalog = null, nowMs = Date.now()) {
  const today = montevideoDate(nowMs);
  let targets, state, runs;
  try {
    targets = (await db.prepare('SELECT catalog_product_id,isbn,own_item_ids FROM comp_targets').all()).results;
    const s = await db.prepare('SELECT cursor_json,updated_at,last_result_json FROM comp_state WHERE name=?').bind('daily').first();
    state = s ? { cursor: JSON.parse(s.cursor_json || '{}'), updated_at: Number(s.updated_at), last: s.last_result_json ? JSON.parse(s.last_result_json) : null } : null;
    runs = (await db.prepare('SELECT * FROM comp_runs ORDER BY id DESC LIMIT 12').all().catch(() => ({ results: [] }))).results;
  } catch { return null; }
  const days = targets.length ? await productDays(db, JSON.stringify(targets.map(t => t.catalog_product_id))) : new Map();
  const segment = () => ({ total: 0, hoy_completas: 0, hoy_parciales: 0, hoy_errores: 0, pendientes_hoy: 0, sin_foto_completa: 0, foto_completa_mas_vieja: null, edad_max_horas: null });
  const segmentos = { ventas_propias: segment(), agotados: segment() };
  for (const t of targets) {
    const seg = segmentos[t.own_item_ids && t.own_item_ids !== '[]' ? 'ventas_propias' : 'agotados'];
    seg.total++;
    const d = days.get(t.catalog_product_id);
    const latest = d?.latest;
    if (!latest || latest.snap_date !== today) seg.pendientes_hoy++;
    else if (latest.status === 'ok') seg.hoy_completas++;
    else if (latest.status === 'partial') seg.hoy_parciales++;
    else seg.hoy_errores++;
    if (!d?.today) seg.sin_foto_completa++;
    else {
      if (!seg.foto_completa_mas_vieja || d.today.snap_date < seg.foto_completa_mas_vieja) seg.foto_completa_mas_vieja = d.today.snap_date;
      const edad = Math.round((nowMs - Number(d.today.fetched_at)) / HOUR_MS);
      if (seg.edad_max_horas == null || edad > seg.edad_max_horas) seg.edad_max_horas = edad;
    }
  }
  // Brechas: lo que el radar no mira. Sin ficha de catálogo no hay listado de
  // vendedores comparable por API; con ficha pero fuera del tope, queda sin foto.
  let catalogo = null;
  if (catalog) {
    const vigilados = new Set(targets.map(t => t.isbn));
    const conFicha = new Set(), sinFicha = new Set();
    let sinIsbn = 0;
    for (const item of Array.isArray(catalog.items) ? catalog.items : []) {
      if (item?.status !== 'active') continue;
      const isbn = bookIsbn(item?.isbn);
      if (!isbn) { sinIsbn++; continue; }
      if (typeof item.catalog_product_id === 'string' && item.catalog_product_id.trim()) conFicha.add(isbn); else sinFicha.add(isbn);
    }
    for (const i of conFicha) sinFicha.delete(i);
    catalogo = { activos_con_isbn: conFicha.size + sinFicha.size, con_ficha_ml: conFicha.size, con_ficha_vigilados: [...conFicha].filter(i => vigilados.has(i)).length,
      con_ficha_sin_vigilar: [...conFicha].filter(i => !vigilados.has(i)).length, sin_ficha_ml: sinFicha.size, publicaciones_sin_isbn: sinIsbn, tope_vigilados: MAX_TARGETS, actualizado: catalog.updated_at ?? null };
  }
  const hoy = runs.filter(r => r.snap_date === today);
  return {
    fecha: today, fase: state?.cursor?.phase ?? null, foto_del_dia: state?.cursor?.date ?? null, ultima_corrida: state?.updated_at ?? null, ultimo_estado: state?.last?.state ?? null, ultimo_codigo: state?.last?.code ?? null,
    capacidades: state?.cursor?.caps ?? {}, vigilados: targets.length, segmentos, catalogo,
    corridas_hoy: { cantidad: hoy.length, llamadas: hoy.reduce((n, r) => n + Number(r.calls_used), 0), fichas: hoy.reduce((n, r) => n + Number(r.products), 0), parciales: hoy.reduce((n, r) => n + Number(r.products_partial), 0), errores: hoy.reduce((n, r) => n + Number(r.products_error), 0) },
    corridas: runs.map(r => ({ inicio: Number(r.started_at), duracion_ms: Number(r.duration_ms), fecha: r.snap_date, estado: r.state, fase: r.phase, fichas: Number(r.products), completas: Number(r.products_ok), parciales: Number(r.products_partial), errores: Number(r.products_error), vendedores: Number(r.sellers), llamadas: Number(r.calls_used), codigo: r.code ?? null })),
  };
}
