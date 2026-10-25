// Competencia en Mercado Libre por API oficial (sin Nubimetrics ni Administrado).
// Sólo LEE ML con el token propio: /products/{id}/items (quién vende el mismo
// producto de catálogo y a qué precio), /items/{id}/price_to_win (si ganamos el
// primer lugar) y /users/{id} (ventas totales del vendedor, para inferir).
//
// Una foto por día (fecha de Montevideo) de los productos que importan: los de
// catálogo de los libros que más vendemos (no las ~7.000 publicaciones). El
// cron de 5 minutos avanza por tandas con un cursor en D1.
//
// Los datos de terceros (vendedores, precios) quedan en D1: nunca en logs, en
// el repo ni en Actions. Un endpoint cerrado no rompe nada: se registra como
// capacidad no disponible y el resto sigue.
import { getAccessToken } from './meli-auth.js';
import { topOwnSalesIsbns, SALES_SELLER_ID } from './ml-sales.js';
import { bookIsbn } from './isbn.js';
import { bulkItemsPath, bulkEntryItem } from './meli-bulk.js';

const ML_ORIGIN = 'https://api.mercadolibre.com';
const DAY_MS = 86400000, LEASE_MS = 240000, MAX_TARGETS = 400, MAX_SELLERS = 60, SNAPSHOT_VERSION = 2;
export const COMPETITION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS comp_targets(catalog_product_id TEXT PRIMARY KEY,isbn TEXT,own_item_ids TEXT,own_catalog_item_id TEXT,own_price REAL,priority INTEGER NOT NULL,updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS comp_snapshots(snap_date TEXT NOT NULL,catalog_product_id TEXT NOT NULL,item_id TEXT NOT NULL,seller_id TEXT NOT NULL,price REAL,currency_id TEXT,free_shipping INTEGER,logistic_type TEXT,is_winner INTEGER,fetched_at INTEGER NOT NULL,PRIMARY KEY(snap_date,catalog_product_id,item_id))`,
  `CREATE INDEX IF NOT EXISTS comp_snapshots_product ON comp_snapshots(catalog_product_id,snap_date)`,
  `CREATE TABLE IF NOT EXISTS comp_product_days(snap_date TEXT NOT NULL,catalog_product_id TEXT NOT NULL,status TEXT NOT NULL,winner_item_id TEXT,own_status TEXT,price_to_win REAL,fetched_at INTEGER NOT NULL,PRIMARY KEY(snap_date,catalog_product_id))`,
  `CREATE TABLE IF NOT EXISTS comp_seller_days(snap_date TEXT NOT NULL,seller_id TEXT NOT NULL,nickname TEXT,transactions_completed INTEGER,power_seller_status TEXT,fetched_at INTEGER NOT NULL,PRIMARY KEY(snap_date,seller_id))`,
  `CREATE TABLE IF NOT EXISTS comp_state(name TEXT PRIMARY KEY,cursor_json TEXT NOT NULL,lease_until INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,last_result_json TEXT)`,
];

export const montevideoDate = ms => new Date(ms - 3 * 3600000).toISOString().slice(0, 10);

class CompError extends Error { constructor(code, status = 502) { super(code); this.code = code; this.status = status; } }

export function createMlCompetition({ fetcher = (...a) => globalThis.fetch(...a), tokenProvider = getAccessToken, now = Date.now, loadCatalog = null } = {}) {
  const ready = new WeakSet();
  async function ensure(db) {
    if (ready.has(db)) return;
    await db.batch(COMPETITION_SCHEMA.map(sql => db.prepare(sql)));
    // Columnas agregadas después (ALTER aditivo): condición y envío internacional.
    const have = new Set((await db.prepare('PRAGMA table_info(comp_snapshots)').all()).results.map(c => c.name));
    for (const [col, type] of [['condition', 'TEXT'], ['international', 'INTEGER']]) if (!have.has(col)) await db.prepare(`ALTER TABLE comp_snapshots ADD COLUMN ${col} ${type}`).run();
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

  async function snapProduct(db, token, target, date, caps) {
    const t = now();
    let items = null, winner = null;
    try {
      const data = await ml(`/products/${encodeURIComponent(target.catalog_product_id)}/items`, token);
      items = Array.isArray(data?.results) ? data.results : [];
      caps.products_items = 'ok';
    } catch (e) { caps.products_items = e.code; if (e.status === 429) throw e; }
    const ok = items !== null;
    let ptw = null;
    if (target.own_catalog_item_id && caps.price_to_win !== 'ml_http_403' && caps.price_to_win !== 'ml_http_404') {
      try { ptw = await ml(`/items/${encodeURIComponent(target.own_catalog_item_id)}/price_to_win?version=v2`, token); caps.price_to_win = 'ok'; }
      catch (e) { caps.price_to_win = e.code; if (e.status === 429) throw e; }
    }
    winner = ptw?.winner?.item_id ?? null;
    let extraCalls = 0;
    // Si el listado no trae la condición (nuevo/usado), se completa con /items/bulk.
    const sinCondicion = (items ?? []).filter(it => typeof it?.item_id === 'string' && typeof it.condition !== 'string').map(it => it.item_id);
    if (sinCondicion.length && caps.items_bulk !== 'ml_http_403' && caps.items_bulk !== 'ml_http_401') {
      const extra = new Map();
      for (let i = 0; i < sinCondicion.length; i += 20) {
        try {
          const raw = await ml(bulkItemsPath(sinCondicion.slice(i, i + 20), 'id,condition,shipping,international_delivery_mode'), token);
          extraCalls++; caps.items_bulk = 'ok';
          for (const item of (Array.isArray(raw) ? raw : []).map(bulkEntryItem).filter(Boolean)) extra.set(item.id, item);
        } catch (e) { caps.items_bulk = e.code; if (e.status === 429) throw e; break; }
      }
      for (const it of items) { const x = extra.get(it.item_id); if (x) { it.condition ??= x.condition; it.international_delivery_mode ??= x.international_delivery_mode; it.shipping ??= x.shipping; } }
    }
    const stmts = [];
    if (items) for (const it of items) {
      if (typeof it?.item_id !== 'string') continue;
      const intl = typeof it.international_delivery_mode === 'string' ? (it.international_delivery_mode !== 'none' ? 1 : 0) : null;
      stmts.push(db.prepare(`INSERT INTO comp_snapshots(snap_date,catalog_product_id,item_id,seller_id,price,currency_id,free_shipping,logistic_type,is_winner,fetched_at,condition,international) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(snap_date,catalog_product_id,item_id) DO UPDATE SET price=excluded.price,free_shipping=excluded.free_shipping,logistic_type=excluded.logistic_type,is_winner=excluded.is_winner,fetched_at=excluded.fetched_at,condition=excluded.condition,international=excluded.international`)
        .bind(date, target.catalog_product_id, it.item_id, String(it.seller_id ?? ''), Number.isFinite(Number(it.price)) ? Number(it.price) : null, it.currency_id ?? null,
          it.shipping?.free_shipping ? 1 : 0, it.shipping?.logistic_type ?? null, winner && winner === it.item_id ? 1 : 0, t,
          typeof it.condition === 'string' ? it.condition : null, intl));
    }
    stmts.push(db.prepare(`INSERT INTO comp_product_days(snap_date,catalog_product_id,status,winner_item_id,own_status,price_to_win,fetched_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(snap_date,catalog_product_id) DO UPDATE SET status=excluded.status,winner_item_id=excluded.winner_item_id,own_status=excluded.own_status,price_to_win=excluded.price_to_win,fetched_at=excluded.fetched_at`)
      .bind(date, target.catalog_product_id, items ? 'ok' : 'error', winner, typeof ptw?.status === 'string' ? ptw.status : null, Number.isFinite(Number(ptw?.price_to_win)) ? Number(ptw.price_to_win) : null, t));
    await db.batch(stmts);
    return { ok, extraCalls };
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

  async function sync(env, { calls = 40, deadlineMs = 20000 } = {}) {
    const started = now();
    const db = env?.ORDERS_DB;
    if (!db) return { state: 'error', code: 'storage_not_configured' };
    await ensure(db);
    const token_ = started + LEASE_MS;
    const row = await db.prepare('UPDATE comp_state SET lease_until=? WHERE name=? AND lease_until<? RETURNING cursor_json').bind(token_, 'daily', started).first();
    if (!row) return { state: 'busy' };
    let cursor = JSON.parse(row.cursor_json || '{}');
    const result = { state: 'idle', products: 0, sellers: 0 };
    const date = montevideoDate(started);
    const hasTime = () => calls > 0 && now() - started < deadlineMs;
    try {
      // v2 agrega condición y envío internacional: una foto vieja del mismo día se rehace.
      if (cursor.date !== date || cursor.v !== SNAPSHOT_VERSION) {
        const loader = loadCatalog ?? (async () => { const obj = await env.CATALOG_R2?.get('catalog.json'); return obj ? obj.json() : null; });
        const catalog = await loader();
        if (!catalog) throw new CompError('catalog_unavailable', 503);
        result.targets = await buildTargets(db, catalog);
        cursor = { date, v: SNAPSHOT_VERSION, phase: 'products', offset: 0, fails: 0, okToday: 0, caps: cursor.caps ?? {} };
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
          const { ok, extraCalls } = await snapProduct(db, token, t, date, caps);
          calls -= (t.own_catalog_item_id ? 2 : 1) + extraCalls; cursor.offset++; result.products++;
          cursor.fails = ok ? 0 : (cursor.fails ?? 0) + 1;
          cursor.okToday = (cursor.okToday ?? 0) + (ok ? 1 : 0);
          // Si los primeros productos del día fallan todos, el endpoint está cerrado:
          // no tiene sentido seguir quemando cupo hasta mañana.
          if (!cursor.okToday && cursor.fails >= 3) { cursor = { ...cursor, phase: 'done' }; result.state = 'products_endpoint_unavailable'; break; }
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
    await db.prepare('UPDATE comp_state SET cursor_json=?,lease_until=0,updated_at=?,last_result_json=? WHERE name=? AND lease_until=?')
      .bind(JSON.stringify(cursor), now(), JSON.stringify(result), 'daily', token_).run().catch(() => {});
    return result;
  }

  return { sync, ensure };
}

export const mlCompetition = createMlCompetition();

const money = v => v == null ? '—' : `$ ${Math.round(v).toLocaleString('es-UY')}`;

// Hechos de competencia por ISBN comparando la última foto con la anterior.
// Pocas consultas en total (json_each), no una por producto: el panel en Pages
// tiene tope de consultas a D1 por request.
export async function competitionByIsbn(db, isbns) {
  const out = new Map();
  const valid = [...new Set(isbns.filter(Boolean))];
  if (!valid.length) return out;
  let targets, days;
  try {
    targets = (await db.prepare('SELECT * FROM comp_targets WHERE isbn IN (SELECT value FROM json_each(?))').bind(JSON.stringify(valid)).all()).results;
    days = (await db.prepare('SELECT DISTINCT snap_date FROM comp_product_days ORDER BY snap_date DESC LIMIT 2').all()).results.map(r => r.snap_date);
  } catch { return out; }
  if (!targets.length || !days.length) return out;
  const [today, prev] = days;
  const pids = JSON.stringify(targets.map(t => t.catalog_product_id));
  const inDays = days.map(() => '?').join(',');
  const [snaps, pdays, sellers] = (await Promise.all([
    db.prepare(`SELECT * FROM comp_snapshots WHERE snap_date IN (${inDays}) AND catalog_product_id IN (SELECT value FROM json_each(?))`).bind(...days, pids).all(),
    db.prepare(`SELECT * FROM comp_product_days WHERE snap_date IN (${inDays}) AND catalog_product_id IN (SELECT value FROM json_each(?))`).bind(...days, pids).all(),
    db.prepare(`SELECT * FROM comp_seller_days WHERE snap_date IN (${inDays})`).bind(...days).all(),
  ])).map(r => r.results);
  const sellerDay = new Map(sellers.map(r => [`${r.snap_date}|${r.seller_id}`, r]));
  const name = sid => sellerDay.get(`${today}|${sid}`)?.nickname ?? sellerDay.get(`${prev}|${sid}`)?.nickname ?? `vendedor ${sid}`;
  for (const t of targets) {
    const rows = snaps.filter(r => r.catalog_product_id === t.catalog_product_id);
    const pd = pdays.find(p => p.catalog_product_id === t.catalog_product_id && p.snap_date === today);
    if (!pd || pd.status !== 'ok') continue;
    const pdPrev = prev ? pdays.find(p => p.catalog_product_id === t.catalog_product_id && p.snap_date === prev) : null;
    const prevOk = pdPrev?.status === 'ok';
    const others = d => rows.filter(r => r.snap_date === d && r.seller_id !== SALES_SELLER_ID);
    const ownToday = rows.some(r => r.snap_date === today && r.seller_id === SALES_SELLER_ID);
    const hoy = others(today), ayer = prevOk ? others(prev) : [];
    const sellersHoy = new Set(hoy.map(r => r.seller_id)), sellersAyer = new Set(ayer.map(r => r.seller_id));
    // Precio justo: sólo competidores nuevos (no usados), nacionales y con el
    // mismo tipo de envío que nuestra publicación en este catálogo. Si la
    // condición no se pudo saber, no se compara (mejor sin aviso que uno falso).
    const ownRow = rows.find(r => r.snap_date === today && r.seller_id === SALES_SELLER_ID) ?? null;
    const comparables = hoy.filter(r => r.price != null && r.condition === 'new' && r.international !== 1
      && (ownRow ? Number(r.free_shipping) === Number(ownRow.free_shipping) : true));
    const minPrice = comparables.reduce((m, r) => (m == null || r.price < m) ? r.price : m, null);
    const ownPrice = ownRow?.price ?? t.own_price;
    const excluidos = hoy.length - comparables.length;
    const avisos = [];
    for (const s of sellersAyer) {
      if (sellersHoy.has(s)) continue;
      const a = sellerDay.get(`${prev}|${s}`), b = sellerDay.get(`${today}|${s}`);
      // Venta inferida: dejó de ofrecerlo y su contador total de ventas subió. Nunca es seguro.
      const probable = a?.transactions_completed != null && b?.transactions_completed != null && b.transactions_completed > a.transactions_completed;
      avisos.push({ tipo: 'competidor_sin_stock', texto: `${name(s)} dejó de ofrecer este libro en el catálogo${probable ? ' (probablemente lo vendió)' : ''}.` });
    }
    if (prevOk) for (const s of sellersHoy) if (!sellersAyer.has(s)) avisos.push({ tipo: 'competidor_nuevo', texto: `Competidor nuevo: ${name(s)} a ${money(hoy.find(r => r.seller_id === s)?.price)}.` });
    if (ownToday && !hoy.length) avisos.push({ tipo: 'solos_en_catalogo', texto: 'Estás solo en el catálogo: ningún competidor lo ofrece hoy.' });
    const winning = pd.own_status === 'winning', winningPrev = pdPrev?.own_status === 'winning';
    if (pdPrev?.own_status && pd.own_status && winning !== winningPrev) {
      avisos.push(winning ? { tipo: 'primer_lugar_ganado', texto: 'Ganaste el primer lugar del catálogo.' }
        : { tipo: 'primer_lugar_perdido', texto: `Perdiste el primer lugar del catálogo${pd.price_to_win ? `: para ganar, ${money(pd.price_to_win)}` : ''}.` });
    }
    const rel = ownPrice && minPrice ? ownPrice / minPrice : null;
    const ref = `del más barato nuevo${ownRow ? (Number(ownRow.free_shipping) ? ' con envío gratis' : ' sin envío gratis') : ''}`;
    if (rel && rel >= 1.15) avisos.push({ tipo: 'precio_arriba', texto: `Tu precio (${money(ownPrice)}) está ${Math.round((rel - 1) * 100)}% arriba ${ref} (${money(minPrice)}).` });
    if (rel && rel <= 0.9) avisos.push({ tipo: 'precio_abajo', texto: `Tu precio (${money(ownPrice)}) está ${Math.round((1 - rel) * 100)}% abajo ${ref} (${money(minPrice)}): podrías estar regalando margen.` });
    out.set(t.isbn, {
      catalog_product_id: t.catalog_product_id, foto: today, foto_anterior: prevOk ? prev : null,
      competidores: sellersHoy.size, competidores_comparables: comparables.length, excluidos_de_precio: excluidos,
      precio_minimo: minPrice, tu_precio: ownPrice, precio_relativo: rel ? Math.round(rel * 100) / 100 : null,
      primer_lugar: pd.own_status ?? null, precio_para_ganar: pd.price_to_win ?? null,
      vendedores: [...sellersHoy].slice(0, 8).map(s => ({ vendedor: name(s), precio: hoy.find(r => r.seller_id === s)?.price ?? null, full: hoy.some(r => r.seller_id === s && r.logistic_type === 'fulfillment') })),
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
    for (const a of f.avisos) eventos.push({ isbn: t.isbn, ...a });
  }
  eventos.sort((a, b) => order.indexOf(a.tipo) - order.indexOf(b.tipo));
  const foto = [...facts.values()].reduce((m, f) => (f.foto > (m ?? '') ? f.foto : m), null);
  const porTipo = eventos.reduce((m, e) => (m[e.tipo] = (m[e.tipo] ?? 0) + 1, m), {});
  return { foto, vigilados: targets.length, por_tipo: porTipo, eventos: eventos.slice(0, limit) };
}

export async function competitionStatus(db) {
  try {
    const s = await db.prepare('SELECT cursor_json,updated_at,last_result_json FROM comp_state WHERE name=?').bind('daily').first();
    const n = await db.prepare('SELECT COUNT(*) AS n FROM comp_targets').first();
    return s ? { cursor: JSON.parse(s.cursor_json), updated_at: Number(s.updated_at), last: s.last_result_json ? JSON.parse(s.last_result_json) : null, vigilados: Number(n?.n ?? 0) } : null;
  } catch { return null; }
}
