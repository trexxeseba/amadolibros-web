// Compras históricas a proveedores (Celesa, Arnoia, Casassa y Lorenzo, Amazon…)
// para el motor de reposición. Recibe documentos ya normalizados (contrato en
// worker-sync/docs/reposicion-gpt.md); no lee Gmail ni llama a proveedores.
//
// - Identidad del documento: SUPPLIER:TIPO:AÑO:NÚMERO (invoice|receipt|order|
//   credit_note). Re-importar el mismo documento actualiza y quita líneas que ya
//   no vienen; nunca duplica.
// - Pedido vs factura: una factura (o remito) reemplaza al pedido del mismo
//   proveedor que comparta número de pedido (superseded_by); nada se borra.
//   Las notas de crédito restan.
// - Identidad del libro: ISBN-13 → ISBN-10 convertido → título+autor (todos los
//   apellidos) → título idéntico+editorial → sólo título (revisión) → unresolved.
//   Con más de un ISBN candidato no se asigna ninguno.
// - Cobertura: purchase_coverage registra qué período de cada proveedor está
//   cargado completo, para distinguir "no compramos" de "no cargado".
import { bookIsbn } from './isbn.js';

export const MATCH_METHODS = Object.freeze(['isbn13', 'isbn10', 'title_author', 'title_publisher', 'title_only', 'unresolved']);
export const DOCUMENT_TYPES = Object.freeze(['invoice', 'receipt', 'order', 'credit_note']);
export const PURCHASE_WINDOWS = Object.freeze([30, 90, 180, 365]);
// Proveedores cuya historia debe estar cargada para afirmar "cero compras".
export const REQUIRED_SUPPLIERS = Object.freeze(['CELESA', 'ARNOIA', 'CASASSA_Y_LORENZO', 'AMAZON_COM']);
// Plazo de entrega aproximado (decisión del dueño: 15 días para todos).
export const SUPPLIER_LEAD_DAYS = Object.freeze({ default: 15 });
const DAY_MS = 86400000, MAX_DOCUMENTS = 50, MAX_ITEMS = 500, MAX_TOTAL_ITEMS = 2000, MIN_TITLE_KEY = 6;
const RANK = { invoice: 3, receipt: 2, order: 1 };
const STOPWORDS = new Set(['editorial', 'editorialy', 'ediciones', 'edicions', 'editores', 'libros', 'libro', 'grupo', 'sello', 'penguin', 'random', 'house', 'books', 'press', 'publishing', 'distribuidora']);

export const PURCHASE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS purchase_orders(purchase_id TEXT PRIMARY KEY,supplier TEXT NOT NULL,supplier_order_id TEXT,document_number TEXT,purchase_date TEXT NOT NULL,purchase_date_ms INTEGER NOT NULL,currency TEXT,total_amount REAL,source_type TEXT,source_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS purchase_orders_date ON purchase_orders(purchase_date_ms)`,
  `CREATE INDEX IF NOT EXISTS purchase_orders_supplier ON purchase_orders(supplier,supplier_order_id)`,
  `CREATE TABLE IF NOT EXISTS purchase_items(purchase_id TEXT NOT NULL,line_key TEXT NOT NULL,isbn TEXT,isbn_raw TEXT,title TEXT,title_key TEXT,author TEXT,publisher TEXT,quantity INTEGER NOT NULL,unit_price REAL,discount_pct REAL,line_total REAL,match_method TEXT NOT NULL,match_confidence INTEGER NOT NULL,match_candidates TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(purchase_id,line_key))`,
  `CREATE INDEX IF NOT EXISTS purchase_items_isbn ON purchase_items(isbn)`,
  `CREATE INDEX IF NOT EXISTS purchase_items_title ON purchase_items(title_key)`,
  `CREATE TABLE IF NOT EXISTS purchase_coverage(supplier TEXT PRIMARY KEY,covered_from TEXT NOT NULL,covered_to TEXT NOT NULL,note TEXT,updated_at INTEGER NOT NULL)`,
];
// Columnas agregadas después de la primera versión (ALTER aditivo).
const ADDED_COLUMNS = {
  purchase_orders: { document_type: 'TEXT', order_refs: 'TEXT', superseded_by: 'TEXT', purpose: 'TEXT', received_date: 'TEXT' },
  purchase_items: { quantity_ordered: 'INTEGER', review_flags: 'TEXT' },
};

export class PurchaseError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

const fold = v => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const titleKey = value => fold(value).replace(/[^a-z0-9]/g, '');
const tokens = v => fold(v).split(/[^a-z0-9]+/).filter(t => t.length >= 4 && !STOPWORDS.has(t));

export function supplierKey(value) {
  let s = fold(value).replace(/&/g, 'y').replace(/[^a-z0-9 ]/g, ' ').replace(/\b(s ?a|s ?l|s ?r ?l|sas|ltda|distribuidora|libreria|libreros|editorial)\b/g, ' ').replace(/[^a-z0-9]/g, '').toUpperCase();
  if (!s) throw new PurchaseError('supplier_required');
  if (s.startsWith('CASASSA')) return 'CASASSA_Y_LORENZO';
  if (s.startsWith('CELESA')) return 'CELESA';
  if (s.startsWith('ARNOIA')) return 'ARNOIA';
  if (s.startsWith('AMAZONES')) return 'AMAZON_ES';
  if (s.startsWith('AMAZON')) return 'AMAZON_COM';
  if (s.startsWith('SBS')) return 'SBS';
  return s;
}
const KNOWN_SUPPLIERS = new Set([...REQUIRED_SUPPLIERS, 'AMAZON_ES', 'SBS']);

// ISBN del documento: ISBN-13 válido, ISBN-10 válido convertido, o nada.
export function documentIsbn(raw) {
  const digits = String(raw ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (!digits) return null;
  const isbn = bookIsbn(digits);
  if (!isbn) return null;
  return { isbn, method: digits.length === 10 ? 'isbn10' : 'isbn13', confidence: digits.length === 10 ? 98 : 100 };
}

// Números con formato local: "25.900" → 25900, "1.234,56" → 1234.56, "12,5" → 12.5.
export function parseNumber(value) {
  if (typeof value === 'number') return value;
  let s = String(value).replace(/[^\d.,\-]/g, '');
  if (!s || !/\d/.test(s)) return NaN;
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',', thou = dec === '.' ? ',' : '.';
    s = s.split(thou).join('').replace(dec, '.');
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    s = new RegExp(`^-?\\d{1,3}(\\${sep}\\d{3})+$`).test(s) ? s.split(sep).join('') : s.replace(sep, '.');
  }
  return Number(s);
}

function number(value, field, { integer = false, min = -Infinity } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const n = parseNumber(value);
  if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) throw new PurchaseError(`invalid_${field}`);
  return n;
}

function parseDate(value, field = 'document_date') {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  const ms = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  if (!Number.isFinite(ms) || new Date(ms).getUTCDate() !== +m[3]) throw new PurchaseError(`invalid_${field}`);
  return { date: `${m[1]}-${m[2]}-${m[3]}`, ms, year: m[1] };
}

const text = (v, max = 500) => (typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim().slice(0, max) : null;
const ref = v => text(v, 120)?.toUpperCase().replace(/\s+/g, '') ?? null;

// Valida y normaliza un documento. No consulta D1.
export function normalizeDocument(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new PurchaseError('invalid_document');
  const supplier = supplierKey(doc.supplier);
  const documentNumber = ref(doc.document_number), orderId = ref(doc.supplier_order_id);
  let documentType = text(doc.document_type, 20)?.toLowerCase() ?? null, inferredType = false;
  if (!documentType) { documentType = documentNumber ? 'invoice' : 'order'; inferredType = true; }
  if (!DOCUMENT_TYPES.includes(documentType)) throw new PurchaseError('invalid_document_type');
  const number_ = documentType === 'order' ? orderId : documentNumber;
  if (!number_) throw new PurchaseError(documentType === 'order' ? 'supplier_order_id_required' : 'document_number_required');
  const { date, ms, year } = parseDate(doc.document_date ?? doc.purchase_date);
  const received = doc.received_date ? parseDate(doc.received_date, 'received_date').date : null;
  const purpose = text(doc.purpose, 30) ?? 'stock';
  if (!['stock', 'encargo_cliente'].includes(purpose)) throw new PurchaseError('invalid_purpose');
  const currency = text(doc.currency, 3)?.toUpperCase() ?? null;
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new PurchaseError('invalid_currency');
  if (!Array.isArray(doc.items) || doc.items.length < 1 || doc.items.length > MAX_ITEMS) throw new PurchaseError('items_1_to_500');
  // El purchase_id lo arma el servidor; sólo se acepta uno explícito con prefijo manual:.
  const manual = text(doc.purchase_id, 200);
  const purchaseId = manual?.startsWith('manual:') ? manual : `${supplier}:${documentType}:${year}:${number_}`;
  const related = Array.isArray(doc.related_order_ids) ? doc.related_order_ids.map(ref).filter(Boolean) : [];
  const orderRefs = [...new Set([orderId, ...related].filter(Boolean))];
  const seen = new Map();
  let anyPrice = doc.total_amount != null && doc.total_amount !== '';
  const items = doc.items.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new PurchaseError(`invalid_item_${i}`);
    const isbnRaw = text(raw.isbn ?? raw.isbn_raw ?? raw.ean, 40);
    const title = text(raw.title, 400);
    const identity = documentIsbn(isbnRaw);
    if (!identity && !title) throw new PurchaseError(`item_${i}_needs_isbn_or_title`);
    const quantity = number(raw.quantity, 'quantity', { integer: true, min: 0 });
    if (quantity === null) throw new PurchaseError(`item_${i}_quantity_required`);
    const unit = number(raw.unit_price, 'unit_price', { min: 0 }), disc = number(raw.discount_pct, 'discount_pct', { min: 0 }), total = number(raw.line_total, 'line_total');
    if (unit != null || total != null) anyPrice = true;
    const flags = [];
    if (unit != null && total != null && quantity > 0) {
      const expected = quantity * unit * (1 - (disc ?? 0) / 100);
      if (Math.abs(expected - total) > Math.max(1, Math.abs(total) * 0.02)) flags.push('line_total_mismatch');
    }
    // line_key estable: el que mande el extractor, o ISBN / título; repetidos se numeran.
    const base = text(raw.line_key, 120) ?? (identity ? identity.isbn : `t:${titleKey(title) || i}`);
    const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
    return { line_key: n > 1 ? `${base}#${n}` : base, isbn_raw: isbnRaw, identity, title, title_key: titleKey(title) || null,
      author: text(raw.author, 200), publisher: text(raw.publisher, 200), quantity, quantity_ordered: number(raw.quantity_ordered, 'quantity_ordered', { integer: true, min: 0 }),
      unit_price: unit, discount_pct: disc, line_total: total, review_flags: flags };
  });
  if (anyPrice && !currency) throw new PurchaseError('currency_required_with_prices');
  return { purchase_id: purchaseId, supplier, supplier_known: KNOWN_SUPPLIERS.has(supplier), document_type: documentType, inferred_type: inferredType,
    supplier_order_id: orderId, document_number: documentNumber, order_refs: orderRefs, purchase_date: date, purchase_date_ms: ms, received_date: received, purpose,
    currency, total_amount: number(doc.total_amount, 'total_amount'), source_type: text(doc.source_type, 40), source_reference: text(doc.source_reference, 500), items };
}

// ISBN conocidos (ventas ML y compras con ISBN) con título y autor/editorial, cargados una vez por import.
async function loadTitleIndex(db) {
  const out = [];
  const queries = [
    `SELECT DISTINCT s.isbn,s.title,d.author,d.publisher FROM ml_sales_items s LEFT JOIN ml_sales_item_identity d ON d.item_id=s.item_id WHERE s.isbn IS NOT NULL`,
    `SELECT DISTINCT isbn,title,author,publisher FROM purchase_items WHERE isbn IS NOT NULL AND match_method IN ('isbn13','isbn10')`,
  ];
  for (const sql of queries) {
    try { out.push(...(await db.prepare(sql).all()).results); } catch { /* tabla aún no creada */ }
  }
  return out.map(r => ({ ...r, key: titleKey(r.title), hay: titleKey(`${r.title ?? ''} ${r.author ?? ''} ${r.publisher ?? ''}`) })).filter(r => r.key);
}

// Resuelve la identidad de una línea sin ISBN válido. Nunca elige entre ediciones dudosas.
export function matchByTitle(index, item) {
  const key = item.title_key;
  if (!key || key.length < MIN_TITLE_KEY) return { isbn: null, method: 'unresolved', confidence: 0, candidates: null };
  const cands = index.filter(r => r.key.includes(key) || (r.key.length >= 8 && key.includes(r.key)));
  const isbnsOf = rows => [...new Set(rows.map(r => r.isbn))];
  const authorTokens = tokens(item.author);
  if (authorTokens.length) {
    const isbns = isbnsOf(cands.filter(r => authorTokens.every(t => r.hay.includes(t))));
    if (isbns.length === 1) return { isbn: isbns[0], method: 'title_author', confidence: 85, candidates: null };
    if (isbns.length > 1) return { isbn: null, method: 'title_only', confidence: 30, candidates: isbns.slice(0, 10) };
  }
  const publisherTokens = tokens(item.publisher);
  if (publisherTokens.length) {
    const isbns = isbnsOf(cands.filter(r => r.key === key && publisherTokens.every(t => r.hay.includes(t))));
    if (isbns.length === 1) return { isbn: isbns[0], method: 'title_publisher', confidence: 70, candidates: null };
  }
  const isbns = isbnsOf(cands);
  if (isbns.length) return { isbn: null, method: 'title_only', confidence: isbns.length === 1 ? 50 : 30, candidates: isbns.slice(0, 10) };
  return { isbn: null, method: 'unresolved', confidence: 0, candidates: null };
}

const ready = new WeakSet();
export async function ensurePurchases(db) {
  if (ready.has(db)) return;
  await db.batch(PURCHASE_SCHEMA.map(sql => db.prepare(sql)));
  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
    const have = new Set((await db.prepare(`PRAGMA table_info(${table})`).all()).results.map(c => c.name));
    for (const [col, type] of Object.entries(cols)) if (!have.has(col)) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run();
  }
  ready.add(db);
}

const RANK_SQL = alias => `CASE ${alias}.document_type WHEN 'invoice' THEN 3 WHEN 'receipt' THEN 2 WHEN 'order' THEN 1 ELSE 3 END`;
// Recalcula qué pedidos/remitos quedan reemplazados por un documento de mayor rango.
const supersedeSql = `UPDATE purchase_orders SET superseded_by=(
  SELECT d.purchase_id FROM purchase_orders d WHERE d.supplier=purchase_orders.supplier AND d.purchase_id<>purchase_orders.purchase_id
    AND d.document_type IN ('invoice','receipt') AND ${RANK_SQL('d')}>${RANK_SQL('purchase_orders')}
    AND EXISTS(SELECT 1 FROM json_each(COALESCE(d.order_refs,'[]')) a JOIN json_each(COALESCE(purchase_orders.order_refs,'[]')) b ON a.value=b.value)
  ORDER BY ${RANK_SQL('d')} DESC,d.purchase_id LIMIT 1)
WHERE supplier=? AND document_type IN ('order','receipt')`;

function documentsOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.documents)) return payload.documents;
  if (payload && typeof payload === 'object' && payload.items) return [payload];
  return [];
}

async function upsertCoverage(db, rows, now) {
  const out = [];
  for (const [i, raw] of rows.entries()) {
    try {
      const supplier = supplierKey(raw?.supplier);
      const from = parseDate(raw?.covered_from, 'covered_from').date, to = parseDate(raw?.covered_to, 'covered_to').date;
      if (from > to) throw new PurchaseError('covered_from_after_to');
      await db.prepare(`INSERT INTO purchase_coverage(supplier,covered_from,covered_to,note,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(supplier) DO UPDATE SET covered_from=excluded.covered_from,covered_to=excluded.covered_to,note=excluded.note,updated_at=excluded.updated_at`)
        .bind(supplier, from, to, text(raw?.note, 300), now).run();
      out.push({ index: i, supplier, status: 'saved', covered_from: from, covered_to: to });
    } catch (error) { out.push({ index: i, status: 'error', error: error instanceof PurchaseError ? error.code : 'internal_error' }); }
  }
  return out;
}

// Importa documentos y/o cobertura. Todo se valida antes de escribir; un
// documento inválido no impide importar los demás.
export async function importPurchases(db, payload, now = Date.now()) {
  const docs = documentsOf(payload), coverage = Array.isArray(payload?.coverage) ? payload.coverage : [];
  if ((!docs.length && !coverage.length) || docs.length > MAX_DOCUMENTS) throw new PurchaseError('documents_1_to_50');
  if (docs.reduce((n, d) => n + (Array.isArray(d?.items) ? d.items.length : 0), 0) > MAX_TOTAL_ITEMS) throw new PurchaseError('split_batch', 413);
  await ensurePurchases(db);
  const normalized = docs.map((raw, index) => { try { return { index, doc: normalizeDocument(raw) }; } catch (error) { return { index, error: error instanceof PurchaseError ? error.code : 'internal_error' }; } });
  const index = normalized.some(n => n.doc?.items.some(i => !i.identity)) ? await loadTitleIndex(db) : [];
  const results = [], suppliers = new Set();
  for (const n of normalized) {
    if (n.error) { results.push({ index: n.index, status: 'error', error: n.error }); continue; }
    const doc = n.doc;
    try {
      for (const item of doc.items) {
        item.match = item.identity ? { isbn: item.identity.isbn, method: item.identity.method, confidence: item.identity.confidence, candidates: null } : matchByTitle(index, item);
      }
      const keys = doc.items.map(i => i.line_key);
      await db.batch([
        db.prepare(`INSERT INTO purchase_orders(purchase_id,supplier,supplier_order_id,document_number,purchase_date,purchase_date_ms,currency,total_amount,source_type,source_reference,created_at,updated_at,document_type,order_refs,purpose,received_date) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(purchase_id) DO UPDATE SET supplier=excluded.supplier,supplier_order_id=excluded.supplier_order_id,document_number=excluded.document_number,purchase_date=excluded.purchase_date,purchase_date_ms=excluded.purchase_date_ms,currency=excluded.currency,total_amount=excluded.total_amount,source_type=excluded.source_type,source_reference=excluded.source_reference,updated_at=excluded.updated_at,document_type=excluded.document_type,order_refs=excluded.order_refs,purpose=excluded.purpose,received_date=excluded.received_date`)
          .bind(doc.purchase_id, doc.supplier, doc.supplier_order_id, doc.document_number, doc.purchase_date, doc.purchase_date_ms, doc.currency, doc.total_amount, doc.source_type, doc.source_reference, now, now, doc.document_type, JSON.stringify(doc.order_refs), doc.purpose, doc.received_date),
        // json_each evita el límite de 100 parámetros por sentencia de D1.
        db.prepare('DELETE FROM purchase_items WHERE purchase_id=? AND line_key NOT IN (SELECT value FROM json_each(?))').bind(doc.purchase_id, JSON.stringify(keys)),
        ...doc.items.map(i => db.prepare(`INSERT INTO purchase_items(purchase_id,line_key,isbn,isbn_raw,title,title_key,author,publisher,quantity,unit_price,discount_pct,line_total,match_method,match_confidence,match_candidates,created_at,updated_at,quantity_ordered,review_flags) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(purchase_id,line_key) DO UPDATE SET isbn=excluded.isbn,isbn_raw=excluded.isbn_raw,title=excluded.title,title_key=excluded.title_key,author=excluded.author,publisher=excluded.publisher,quantity=excluded.quantity,unit_price=excluded.unit_price,discount_pct=excluded.discount_pct,line_total=excluded.line_total,match_method=excluded.match_method,match_confidence=excluded.match_confidence,match_candidates=excluded.match_candidates,updated_at=excluded.updated_at,quantity_ordered=excluded.quantity_ordered,review_flags=excluded.review_flags`)
          .bind(doc.purchase_id, i.line_key, i.match.isbn, i.isbn_raw, i.title, i.title_key, i.author, i.publisher, i.quantity, i.unit_price, i.discount_pct, i.line_total, i.match.method, i.match.confidence, i.match.candidates ? JSON.stringify(i.match.candidates) : null, now, now, i.quantity_ordered, i.review_flags.length ? JSON.stringify(i.review_flags) : null)),
      ]);
      suppliers.add(doc.supplier);
      const methods = {};
      for (const i of doc.items) methods[i.match.method] = (methods[i.match.method] ?? 0) + 1;
      const review = doc.items.filter(i => !i.match.isbn || i.review_flags.length).map(i => ({ line_key: i.line_key, title: i.title, method: i.match.method, candidates: i.match.candidates ?? [], flags: i.review_flags }));
      results.push({ index: n.index, purchase_id: doc.purchase_id, status: 'imported', document_type: doc.document_type, lines: doc.items.length, match_methods: methods, review,
        ...(doc.inferred_type ? { inferred_type: true } : {}), ...(doc.supplier_known ? {} : { supplier_unknown: true }) });
    } catch (error) {
      results.push({ index: n.index, status: 'error', error: error instanceof PurchaseError ? error.code : 'internal_error' });
    }
  }
  for (const s of suppliers) await db.prepare(supersedeSql).bind(s).run();
  const coverageResults = coverage.length ? await upsertCoverage(db, coverage, now) : [];
  return { imported: results.filter(r => r.status === 'imported').length, errors: results.filter(r => r.status === 'error').length, results, ...(coverage.length ? { coverage: coverageResults } : {}) };
}

// Sólo documentos vigentes (no reemplazados); las notas de crédito restan.
const ROWS = `SELECT i.purchase_id,i.line_key,i.isbn,i.title,i.title_key,
  CASE WHEN o.document_type='credit_note' THEN -i.quantity ELSE i.quantity END AS quantity,
  i.unit_price,i.discount_pct,i.line_total,i.match_method,i.match_confidence,i.match_candidates,
  o.supplier,o.supplier_order_id,o.document_number,o.document_type,o.purpose,o.purchase_date,o.purchase_date_ms,o.currency,o.received_date
  FROM purchase_items i JOIN purchase_orders o ON o.purchase_id=i.purchase_id WHERE o.superseded_by IS NULL`;

function describe(rows, limit = 10) {
  const sorted = [...rows].sort((a, b) => b.purchase_date_ms - a.purchase_date_ms || String(a.purchase_id).localeCompare(String(b.purchase_id)));
  return {
    compras_totales: new Set(rows.map(r => r.purchase_id)).size,
    unidades_compradas: rows.reduce((n, r) => n + (Number(r.quantity) || 0), 0),
    primera_compra: sorted.at(-1)?.purchase_date ?? null,
    ultima_compra: sorted[0]?.purchase_date ?? null,
    proveedores: [...new Set(rows.map(r => r.supplier))].sort(),
    ultimas_compras: sorted.slice(0, limit).map(r => ({ fecha: r.purchase_date, proveedor: r.supplier, tipo: r.document_type, destino: r.purpose, cantidad: r.quantity,
      precio_unitario: r.unit_price, descuento_pct: r.discount_pct, total_linea: r.line_total, moneda: r.currency, documento: r.document_number, pedido: r.supplier_order_id,
      titulo: r.title, match_method: r.match_method, match_confidence: r.match_confidence })),
  };
}

function parseIsbns(isbns) {
  if (!Array.isArray(isbns) || isbns.length < 1 || isbns.length > 50) throw new PurchaseError('isbns_1_to_50');
  return isbns.map(input => ({ input: String(input), isbn: bookIsbn(input) }));
}
async function rowsForIsbns(db, valid) {
  return valid.length ? (await db.prepare(`${ROWS} AND i.isbn IN (${valid.map(() => '?').join(',')})`).bind(...valid).all()).results : [];
}
// Líneas sin ISBN que tienen ese ISBN entre sus candidatos por título.
async function pendingForIsbns(db, valid) {
  if (!valid.length) return [];
  return (await db.prepare(`${ROWS} AND i.isbn IS NULL AND (${valid.map(() => 'i.match_candidates LIKE ?').join(' OR ')})`).bind(...valid.map(v => `%"${v}"%`)).all()).results;
}

export async function purchasesByIsbn(db, isbns) {
  await ensurePurchases(db);
  const wanted = parseIsbns(isbns), valid = [...new Set(wanted.map(w => w.isbn).filter(Boolean))];
  const rows = await rowsForIsbns(db, valid), pending = await pendingForIsbns(db, valid);
  return wanted.map(w => w.isbn ? { isbn: w.isbn, ...describe(rows.filter(r => r.isbn === w.isbn)),
    posibles_sin_isbn: pending.filter(r => JSON.parse(r.match_candidates || '[]').includes(w.isbn)).map(r => ({ fecha: r.purchase_date, proveedor: r.supplier, titulo: r.title, cantidad: r.quantity, documento: r.document_number })) }
    : { input: w.input, error: 'invalid_isbn' });
}

export async function readCoverage(db) {
  await ensurePurchases(db);
  return (await db.prepare('SELECT supplier,covered_from,covered_to,note,updated_at FROM purchase_coverage ORDER BY supplier').all()).results;
}

// Proveedores obligatorios sin historia cargada para los últimos 365 días (hasta hace 30).
export function missingCoverage(coverage, nowMs = Date.now()) {
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  const needFrom = day(nowMs - 365 * DAY_MS), needTo = day(nowMs - 30 * DAY_MS);
  const bySupplier = new Map(coverage.map(c => [c.supplier, c]));
  return REQUIRED_SUPPLIERS.filter(s => { const c = bySupplier.get(s); return !c || c.covered_from > needFrom || c.covered_to < needTo; });
}

// La misma compra cargada dos veces no suma dos veces:
// - un pedido ("order") del proveedor se descarta si después llegó, del mismo
//   proveedor y con ese ISBN, la confirmación de envío o la factura (hasta 45
//   días después): es la misma mercadería;
// - dos documentos del mismo proveedor con el mismo ISBN y la misma cantidad,
//   con fechas a 3 días o menos, se cuentan una vez.
const ORDER_FULFILLED_DAYS = 45, DUPLICATE_DAYS = 3;
export function dedupePurchaseRows(rows) {
  const kept = [];
  const sorted = [...rows].sort((a, b) => a.purchase_date_ms - b.purchase_date_ms);
  for (const r of sorted) {
    if (r.document_type === 'order' && sorted.some(x => x !== r && x.document_type !== 'order' && x.document_type !== 'credit_note' && x.supplier === r.supplier
      && x.purchase_date_ms >= r.purchase_date_ms && x.purchase_date_ms - r.purchase_date_ms <= ORDER_FULFILLED_DAYS * DAY_MS)) continue;
    if (r.document_type !== 'credit_note' && kept.some(x => x.purchase_id !== r.purchase_id && x.document_type !== 'credit_note' && x.supplier === r.supplier
      && Number(x.quantity) === Number(r.quantity) && Math.abs(x.purchase_date_ms - r.purchase_date_ms) <= DUPLICATE_DAYS * DAY_MS)) continue;
    kept.push(r);
  }
  return kept;
}

// Resumen para el motor de reposición (sin decidir cuánto comprar). Excluye
// compras por encargo de cliente: no entraron al stock.
export async function purchaseSummary(db, isbns, nowMs = Date.now()) {
  await ensurePurchases(db);
  const wanted = parseIsbns(isbns), valid = [...new Set(wanted.map(w => w.isbn).filter(Boolean))];
  const rows = (await rowsForIsbns(db, valid)).filter(r => r.purpose !== 'encargo_cliente'), pending = await pendingForIsbns(db, valid);
  const lead = SUPPLIER_LEAD_DAYS.default * DAY_MS;
  return wanted.map(w => {
    if (!w.isbn) return { input: w.input, error: 'invalid_isbn' };
    const mine = dedupePurchaseRows(rows.filter(r => r.isbn === w.isbn)).sort((a, b) => b.purchase_date_ms - a.purchase_date_ms);
    const out = { isbn: w.isbn };
    for (const d of PURCHASE_WINDOWS) out[`unidades_${d}d`] = mine.filter(r => nowMs - r.purchase_date_ms <= d * DAY_MS).reduce((n, r) => n + (Number(r.quantity) || 0), 0);
    const lastDate = mine.find(r => r.document_type !== 'credit_note')?.purchase_date_ms;
    const last = mine.filter(r => r.purchase_date_ms === lastDate && r.document_type !== 'credit_note');
    out.ultima_compra_fecha = last[0]?.purchase_date ?? null;
    out.ultima_compra_cantidad = last.length ? last.reduce((n, r) => n + (Number(r.quantity) || 0), 0) : null;
    out.ultima_compra_proveedor = last.length ? [...new Set(last.map(r => r.supplier))].join(',') : null;
    out.documentos = new Set(mine.map(r => r.purchase_id)).size;
    // En tránsito estimado: comprado dentro del plazo de entrega (15 días) y
    // sin fecha de recepción cargada.
    out.en_transito_estimado = mine.filter(r => r.document_type !== 'credit_note' && !r.received_date && nowMs - r.purchase_date_ms < lead).reduce((n, r) => n + (Number(r.quantity) || 0), 0);
    out.compras_sin_isbn_posibles = pending.filter(r => JSON.parse(r.match_candidates || '[]').includes(w.isbn)).length;
    return out;
  });
}

export async function purchasesByTitle(db, title) {
  await ensurePurchases(db);
  const key = titleKey(title);
  if (key.length < 4) throw new PurchaseError('title_too_short');
  const { results } = await db.prepare(`${ROWS} AND i.title_key LIKE ? LIMIT 1000`).bind(`%${key}%`).all();
  const groups = new Map();
  for (const r of results) {
    const g = r.isbn ? `isbn:${r.isbn}` : `titulo:${r.title_key}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  return [...groups.values()].map(rows => ({ isbn: rows[0].isbn ?? null, identificado_por: rows[0].isbn ? rows[0].match_method : 'titulo',
    candidatos: rows[0].isbn ? [] : JSON.parse(rows[0].match_candidates || '[]'), ...describe(rows) })).slice(0, 50);
}

// Líneas de compra sin ISBN, para la cola de revisión de identidad.
export async function purchasesWithoutIsbn(db, limit = 20) {
  await ensurePurchases(db);
  return (await db.prepare(`${ROWS} AND i.isbn IS NULL ORDER BY o.purchase_date_ms DESC LIMIT ?`).bind(Math.min(100, limit)).all()).results
    .map(r => ({ fecha: r.purchase_date, proveedor: r.supplier, documento: r.document_number ?? r.supplier_order_id, titulo: r.title, cantidad: r.quantity, metodo: r.match_method, candidatos: JSON.parse(r.match_candidates || '[]') }));
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
    if (url.pathname === '/purchases/coverage') {
      await ensurePurchases(db);
      return reply({ coverage: await upsertCoverage(db, Array.isArray(body?.coverage) ? body.coverage : [body], Date.now()) });
    }
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
