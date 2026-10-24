// Compras históricas a proveedores (Celesa, Arnoia, Casassa y Lorenzo, Amazon…)
// para el motor de reposición. Recibe documentos ya normalizados (GPT extrae
// los datos de Gmail/PDF); no lee Gmail ni llama a ningún proveedor.
//
// - Idempotencia: purchase_id determinístico (proveedor + documento) y PK
//   (purchase_id, line_key). Re-importar el mismo documento actualiza
//   cantidades/precios y borra líneas que ya no vienen; nunca duplica.
// - Identidad: ISBN-13 → ISBN-10 convertido → título+autor → título+editorial →
//   sólo título (revisión). Los títulos se cruzan contra ISBN ya conocidos
//   (ventas ML y compras con ISBN). Si hay más de un ISBN candidato no se asigna
//   ninguno: la línea queda para revisión con sus candidatos.
import { bookIsbn } from './ml-sales.js';

export const MATCH_METHODS = Object.freeze(['isbn13', 'isbn10', 'title_author', 'title_publisher', 'title_only', 'unresolved']);
export const PURCHASE_WINDOWS = Object.freeze([30, 90, 180, 365]);
const DAY_MS = 86400000, MAX_DOCUMENTS = 50, MAX_ITEMS = 500, MIN_TITLE_KEY = 6;
const SUPPLIER_ALIASES = {
  CELESA: 'CELESA', ARNOIA: 'ARNOIA',
  CASASSA: 'CASASSA_Y_LORENZO', CASASSAYLORENZO: 'CASASSA_Y_LORENZO', CASASSAYLORENZODISTRIBUIDORA: 'CASASSA_Y_LORENZO',
  AMAZON: 'AMAZON_COM', AMAZONCOM: 'AMAZON_COM', AMAZONUS: 'AMAZON_COM', AMAZONES: 'AMAZON_ES',
};

export const PURCHASE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS purchase_orders(purchase_id TEXT PRIMARY KEY,supplier TEXT NOT NULL,supplier_order_id TEXT,document_number TEXT,purchase_date TEXT NOT NULL,purchase_date_ms INTEGER NOT NULL,currency TEXT,total_amount REAL,source_type TEXT,source_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS purchase_orders_date ON purchase_orders(purchase_date_ms)`,
  `CREATE INDEX IF NOT EXISTS purchase_orders_supplier ON purchase_orders(supplier,supplier_order_id)`,
  `CREATE TABLE IF NOT EXISTS purchase_items(purchase_id TEXT NOT NULL,line_key TEXT NOT NULL,isbn TEXT,isbn_raw TEXT,title TEXT,title_key TEXT,author TEXT,publisher TEXT,quantity INTEGER NOT NULL,unit_price REAL,discount_pct REAL,line_total REAL,match_method TEXT NOT NULL,match_confidence INTEGER NOT NULL,match_candidates TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(purchase_id,line_key))`,
  `CREATE INDEX IF NOT EXISTS purchase_items_isbn ON purchase_items(isbn)`,
  `CREATE INDEX IF NOT EXISTS purchase_items_title ON purchase_items(title_key)`,
];

export class PurchaseError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

const fold = v => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// Título normalizado sin el prefijo "Libro" que agregan las publicaciones de ML.
export function titleKey(value) {
  return fold(value).replace(/^\s*(libro|book)\s*[:\-–]?\s*/, '').replace(/[^a-z0-9]/g, '');
}
const tokens = v => fold(v).split(/[^a-z0-9]+/).filter(t => t.length >= 4);

export function supplierKey(value) {
  const compact = fold(value).replace(/[^a-z0-9]/g, '').toUpperCase();
  if (!compact) throw new PurchaseError('supplier_required');
  return SUPPLIER_ALIASES[compact] ?? compact;
}

// ISBN del documento: ISBN-13 válido, ISBN-10 válido convertido, o nada.
export function documentIsbn(raw) {
  const digits = String(raw ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (!digits) return null;
  const isbn = bookIsbn(digits);
  if (!isbn) return null;
  return { isbn, method: digits.length === 10 ? 'isbn10' : 'isbn13', confidence: digits.length === 10 ? 98 : 100 };
}

function number(value, field, { integer = false, min = -Infinity } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value);
  if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) throw new PurchaseError(`invalid_${field}`);
  return n;
}

function parseDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  const ms = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  if (!Number.isFinite(ms) || new Date(ms).getUTCDate() !== +m[3]) throw new PurchaseError('invalid_purchase_date');
  return { date: `${m[1]}-${m[2]}-${m[3]}`, ms };
}

const text = (v, max = 500) => (typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim().slice(0, max) : null;

// Valida y normaliza un documento. No consulta D1.
export function normalizeDocument(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new PurchaseError('invalid_document');
  const supplier = supplierKey(doc.supplier);
  const documentNumber = text(doc.document_number, 120), orderId = text(doc.supplier_order_id, 120);
  if (!documentNumber && !orderId && !text(doc.purchase_id, 200)) throw new PurchaseError('document_number_or_order_required');
  const { date, ms } = parseDate(doc.purchase_date);
  const currency = text(doc.currency, 3)?.toUpperCase() ?? null;
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new PurchaseError('invalid_currency');
  if (!Array.isArray(doc.items) || doc.items.length < 1 || doc.items.length > MAX_ITEMS) throw new PurchaseError('items_1_to_500');
  const purchaseId = text(doc.purchase_id, 200) ?? `${supplier}:${documentNumber ?? `pedido-${orderId}`}`;
  const seen = new Map();
  const items = doc.items.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new PurchaseError(`invalid_item_${i}`);
    const isbnRaw = text(raw.isbn ?? raw.isbn_raw ?? raw.ean, 40);
    const title = text(raw.title, 400);
    const identity = documentIsbn(isbnRaw);
    if (!identity && !title) throw new PurchaseError(`item_${i}_needs_isbn_or_title`);
    const quantity = number(raw.quantity, 'quantity', { integer: true, min: 0 });
    if (quantity === null) throw new PurchaseError(`item_${i}_quantity_required`);
    // line_key estable: el que mande el extractor, o ISBN / título; repetidos se numeran.
    const base = text(raw.line_key, 120) ?? (identity ? identity.isbn : `t:${titleKey(title) || i}`);
    const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
    return { line_key: n > 1 ? `${base}#${n}` : base, isbn_raw: isbnRaw, identity, title, title_key: titleKey(title) || null,
      author: text(raw.author, 200), publisher: text(raw.publisher, 200), quantity,
      unit_price: number(raw.unit_price, 'unit_price', { min: 0 }), discount_pct: number(raw.discount_pct, 'discount_pct', { min: 0 }),
      line_total: number(raw.line_total, 'line_total') };
  });
  return { purchase_id: purchaseId, supplier, supplier_order_id: orderId, document_number: documentNumber, purchase_date: date, purchase_date_ms: ms,
    currency, total_amount: number(doc.total_amount, 'total_amount'), source_type: text(doc.source_type, 40), source_reference: text(doc.source_reference, 500), items };
}

// ISBN conocidos cuyo título contiene (o está contenido en) el título dado.
async function titleCandidates(db, key) {
  if (!key || key.length < MIN_TITLE_KEY) return [];
  const like = `%${key}%`;
  const queries = [
    [`SELECT DISTINCT s.isbn,s.title,s.title_key,d.author,d.publisher FROM ml_sales_items s LEFT JOIN ml_sales_item_identity d ON d.item_id=s.item_id
      WHERE s.isbn IS NOT NULL AND (s.title_key LIKE ? OR (length(s.title_key)>=8 AND ? LIKE '%'||s.title_key||'%')) LIMIT 300`, [like, key]],
    [`SELECT DISTINCT isbn,title,title_key,author,publisher FROM purchase_items WHERE isbn IS NOT NULL AND match_method IN ('isbn13','isbn10')
      AND (title_key LIKE ? OR (length(title_key)>=8 AND ? LIKE '%'||title_key||'%')) LIMIT 300`, [like, key]],
  ];
  const out = [];
  for (const [sql, args] of queries) {
    try { out.push(...(await db.prepare(sql).bind(...args).all()).results); } catch { /* tabla aún no creada */ }
  }
  return out;
}

// Resuelve la identidad de una línea sin ISBN válido. Nunca elige entre ediciones dudosas.
export async function matchByTitle(db, item) {
  const cands = await titleCandidates(db, item.title_key);
  const isbnsOf = rows => [...new Set(rows.map(r => r.isbn))];
  const hay = r => titleKey(`${r.title ?? ''} ${r.author ?? ''} ${r.publisher ?? ''}`);
  const steps = [
    ['title_author', 85, tokens(item.author)],
    ['title_publisher', 70, tokens(item.publisher)],
  ];
  for (const [method, confidence, toks] of steps) {
    if (!toks.length) continue;
    const hits = cands.filter(r => toks.some(t => hay(r).includes(t)));
    const isbns = isbnsOf(hits);
    if (isbns.length === 1) return { isbn: isbns[0], method, confidence, candidates: null };
    if (isbns.length > 1) return { isbn: null, method: 'title_only', confidence: 30, candidates: isbns.slice(0, 10) };
  }
  const isbns = isbnsOf(cands);
  if (isbns.length) return { isbn: null, method: 'title_only', confidence: isbns.length === 1 ? 50 : 30, candidates: isbns.slice(0, 10) };
  return { isbn: null, method: 'unresolved', confidence: 0, candidates: null };
}

export async function ensurePurchases(db) {
  await db.batch(PURCHASE_SCHEMA.map(sql => db.prepare(sql)));
}

// Importa un lote de documentos. Cada documento se escribe en una transacción;
// un documento inválido no impide importar los demás.
export async function importPurchases(db, payload, now = Date.now()) {
  const docs = Array.isArray(payload) ? payload : Array.isArray(payload?.documents) ? payload.documents : payload && typeof payload === 'object' && payload.items ? [payload] : null;
  if (!docs || docs.length < 1 || docs.length > MAX_DOCUMENTS) throw new PurchaseError('documents_1_to_50');
  await ensurePurchases(db);
  const results = [];
  for (const [index, raw] of docs.entries()) {
    try {
      const doc = normalizeDocument(raw);
      for (const item of doc.items) {
        item.match = item.identity ? { isbn: item.identity.isbn, method: item.identity.method, confidence: item.identity.confidence, candidates: null } : await matchByTitle(db, item);
      }
      const keys = doc.items.map(i => i.line_key);
      const stmts = [
        db.prepare(`INSERT INTO purchase_orders(purchase_id,supplier,supplier_order_id,document_number,purchase_date,purchase_date_ms,currency,total_amount,source_type,source_reference,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(purchase_id) DO UPDATE SET supplier=excluded.supplier,supplier_order_id=excluded.supplier_order_id,document_number=excluded.document_number,purchase_date=excluded.purchase_date,purchase_date_ms=excluded.purchase_date_ms,currency=excluded.currency,total_amount=excluded.total_amount,source_type=excluded.source_type,source_reference=excluded.source_reference,updated_at=excluded.updated_at`)
          .bind(doc.purchase_id, doc.supplier, doc.supplier_order_id, doc.document_number, doc.purchase_date, doc.purchase_date_ms, doc.currency, doc.total_amount, doc.source_type, doc.source_reference, now, now),
        // Líneas que ya no vienen en la versión nueva del documento se eliminan.
        // json_each evita el límite de 100 parámetros por sentencia de D1.
        db.prepare('DELETE FROM purchase_items WHERE purchase_id=? AND line_key NOT IN (SELECT value FROM json_each(?))').bind(doc.purchase_id, JSON.stringify(keys)),
        ...doc.items.map(i => db.prepare(`INSERT INTO purchase_items(purchase_id,line_key,isbn,isbn_raw,title,title_key,author,publisher,quantity,unit_price,discount_pct,line_total,match_method,match_confidence,match_candidates,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(purchase_id,line_key) DO UPDATE SET isbn=excluded.isbn,isbn_raw=excluded.isbn_raw,title=excluded.title,title_key=excluded.title_key,author=excluded.author,publisher=excluded.publisher,quantity=excluded.quantity,unit_price=excluded.unit_price,discount_pct=excluded.discount_pct,line_total=excluded.line_total,match_method=excluded.match_method,match_confidence=excluded.match_confidence,match_candidates=excluded.match_candidates,updated_at=excluded.updated_at`)
          .bind(doc.purchase_id, i.line_key, i.match.isbn, i.isbn_raw, i.title, i.title_key, i.author, i.publisher, i.quantity, i.unit_price, i.discount_pct, i.line_total, i.match.method, i.match.confidence, i.match.candidates ? JSON.stringify(i.match.candidates) : null, now, now)),
      ];
      await db.batch(stmts);
      const methods = {};
      for (const i of doc.items) methods[i.match.method] = (methods[i.match.method] ?? 0) + 1;
      results.push({ index, purchase_id: doc.purchase_id, status: 'imported', lines: doc.items.length, match_methods: methods,
        review: doc.items.filter(i => !i.match.isbn).map(i => ({ line_key: i.line_key, title: i.title, method: i.match.method, candidates: i.match.candidates ?? [] })) });
    } catch (error) {
      results.push({ index, status: 'error', error: error instanceof PurchaseError ? error.code : 'internal_error' });
    }
  }
  return { imported: results.filter(r => r.status === 'imported').length, errors: results.filter(r => r.status === 'error').length, results };
}

const ROWS = `SELECT i.purchase_id,i.line_key,i.isbn,i.title,i.title_key,i.quantity,i.unit_price,i.discount_pct,i.line_total,i.match_method,i.match_confidence,i.match_candidates,
  o.supplier,o.supplier_order_id,o.document_number,o.purchase_date,o.purchase_date_ms,o.currency FROM purchase_items i JOIN purchase_orders o ON o.purchase_id=i.purchase_id`;

function describe(rows, limit = 10) {
  const sorted = [...rows].sort((a, b) => b.purchase_date_ms - a.purchase_date_ms || String(a.purchase_id).localeCompare(String(b.purchase_id)));
  return {
    compras_totales: new Set(rows.map(r => r.purchase_id)).size,
    unidades_compradas: rows.reduce((n, r) => n + (Number(r.quantity) || 0), 0),
    primera_compra: sorted.at(-1)?.purchase_date ?? null,
    ultima_compra: sorted[0]?.purchase_date ?? null,
    proveedores: [...new Set(rows.map(r => r.supplier))].sort(),
    ultimas_compras: sorted.slice(0, limit).map(r => ({ fecha: r.purchase_date, proveedor: r.supplier, cantidad: r.quantity, precio_unitario: r.unit_price,
      descuento_pct: r.discount_pct, total_linea: r.line_total, moneda: r.currency, documento: r.document_number, pedido: r.supplier_order_id, titulo: r.title,
      match_method: r.match_method, match_confidence: r.match_confidence })),
  };
}

function parseIsbns(isbns) {
  if (!Array.isArray(isbns) || isbns.length < 1 || isbns.length > 50) throw new PurchaseError('isbns_1_to_50');
  return isbns.map(input => ({ input: String(input), isbn: bookIsbn(input) }));
}
async function rowsForIsbns(db, valid) {
  return valid.length ? (await db.prepare(`${ROWS} WHERE i.isbn IN (${valid.map(() => '?').join(',')})`).bind(...valid).all()).results : [];
}
// Líneas sin ISBN que tienen ese ISBN entre sus candidatos por título.
async function pendingForIsbns(db, valid) {
  if (!valid.length) return [];
  return (await db.prepare(`${ROWS} WHERE i.isbn IS NULL AND (${valid.map(() => 'i.match_candidates LIKE ?').join(' OR ')})`).bind(...valid.map(v => `%"${v}"%`)).all()).results;
}

export async function purchasesByIsbn(db, isbns) {
  await ensurePurchases(db);
  const wanted = parseIsbns(isbns), valid = [...new Set(wanted.map(w => w.isbn).filter(Boolean))];
  const rows = await rowsForIsbns(db, valid), pending = await pendingForIsbns(db, valid);
  return wanted.map(w => w.isbn ? { isbn: w.isbn, ...describe(rows.filter(r => r.isbn === w.isbn)),
    posibles_sin_isbn: pending.filter(r => JSON.parse(r.match_candidates || '[]').includes(w.isbn)).map(r => ({ fecha: r.purchase_date, proveedor: r.supplier, titulo: r.title, cantidad: r.quantity, documento: r.document_number })) }
    : { input: w.input, error: 'invalid_isbn' });
}

// Resumen para el motor de reposición (sin decidir cuánto comprar).
export async function purchaseSummary(db, isbns, nowMs = Date.now()) {
  await ensurePurchases(db);
  const wanted = parseIsbns(isbns), valid = [...new Set(wanted.map(w => w.isbn).filter(Boolean))];
  const rows = await rowsForIsbns(db, valid), pending = await pendingForIsbns(db, valid);
  return wanted.map(w => {
    if (!w.isbn) return { input: w.input, error: 'invalid_isbn' };
    const mine = rows.filter(r => r.isbn === w.isbn).sort((a, b) => b.purchase_date_ms - a.purchase_date_ms);
    const out = { isbn: w.isbn };
    for (const d of PURCHASE_WINDOWS) out[`unidades_${d}d`] = mine.filter(r => nowMs - r.purchase_date_ms <= d * DAY_MS).reduce((n, r) => n + (Number(r.quantity) || 0), 0);
    const lastDate = mine[0]?.purchase_date_ms;
    const last = mine.filter(r => r.purchase_date_ms === lastDate);
    out.ultima_compra_fecha = mine[0]?.purchase_date ?? null;
    out.ultima_compra_cantidad = last.length ? last.reduce((n, r) => n + (Number(r.quantity) || 0), 0) : null;
    out.ultima_compra_proveedor = last.length ? [...new Set(last.map(r => r.supplier))].join(',') : null;
    out.documentos = new Set(mine.map(r => r.purchase_id)).size;
    const maybe = pending.filter(r => JSON.parse(r.match_candidates || '[]').includes(w.isbn));
    out.compras_sin_isbn_posibles = maybe.length;
    return out;
  });
}

export async function purchasesByTitle(db, title) {
  await ensurePurchases(db);
  const key = titleKey(title);
  if (key.length < 3) throw new PurchaseError('title_too_short');
  const { results } = await db.prepare(`${ROWS} WHERE i.title_key LIKE ? LIMIT 2000`).bind(`%${key}%`).all();
  const groups = new Map();
  for (const r of results) {
    const g = r.isbn ? `isbn:${r.isbn}` : `titulo:${r.title_key}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  return [...groups.values()].map(rows => ({ isbn: rows[0].isbn ?? null, identificado_por: rows[0].isbn ? rows[0].match_method : 'titulo',
    candidatos: rows[0].isbn ? [] : JSON.parse(rows[0].match_candidates || '[]'), ...describe(rows) })).slice(0, 50);
}

const reply = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

// Rutas /purchases/* (detrás de SYNC_SECRET, validado en index.js).
export async function handlePurchasesRoute(request, env) {
  const url = new URL(request.url);
  try {
    const db = env?.ORDERS_DB;
    if (!db) throw new PurchaseError('purchases_storage_not_configured', 503);
    if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
    let body;
    try { body = await request.json(); } catch { throw new PurchaseError('invalid_json'); }
    if (url.pathname === '/purchases/import') return reply(await importPurchases(db, body));
    if (url.pathname === '/purchases/query') {
      if (body?.titulo !== undefined) return reply({ titulo: String(body.titulo), resultados: await purchasesByTitle(db, String(body.titulo)) });
      return reply({ resultados: await purchasesByIsbn(db, body?.isbns) });
    }
    if (url.pathname === '/purchases/summary') return reply({ resultados: await purchaseSummary(db, body?.isbns) });
    return reply({ error: 'not_found' }, 404);
  } catch (error) {
    return reply({ error: error instanceof PurchaseError ? error.code : 'internal_error' }, error instanceof PurchaseError ? error.status : 500);
  }
}
