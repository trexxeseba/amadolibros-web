/**
 * Cruce del informe diario: los libros que miraron en la web en los últimos
 * 7 días, contra lo que pasó con ese mismo libro en los otros canales.
 *
 * - Web: vistas y carrito (GA4) y pedidos de la web (D1).
 * - Mercado Libre: ventas de Amado Libros (D1, ml_sales_*).
 * - WhatsApp e Instagram: consultas y compras cargadas en Airtable (PEDIDOS).
 *
 * El cruce es por libro, no por persona: primero por ID de publicación (MLU),
 * después por ISBN y, si no hay ninguno, por las palabras del título. Que el
 * mismo libro aparezca en dos canales no prueba que sea la misma persona.
 * No se lee ningún dato personal: ni nombre, ni teléfono, ni correo.
 */

const AIRTABLE_BASE = 'appA7zwO1Yo0FGTvz';
const AIRTABLE_TABLE = 'PEDIDOS';
const AIRTABLE_FIELDS = ['Título', 'ISBN', 'Estado', 'Canal', 'Fecha consulta'];

// Estados de PEDIDOS que son compra (mismo criterio que el campo «Es compra»).
const BOUGHT = new Set(['señado', 'comprado', 'en camino', 'en_camino', 'para entregar', 'para_entregar', 'pago total', 'pago_total', 'entregado']);

const STOPWORDS = new Set([
  'libro', 'libros', 'tapa', 'dura', 'blanda', 'edicion', 'edición', 'para', 'con', 'del', 'las', 'los', 'una', 'uno',
  'unos', 'unas', 'por', 'que', 'sus', 'the', 'and', 'nuevo', 'nueva', 'original', 'espanol', 'español', 'editorial',
  'vol', 'tomo', 'ultima', 'última', 'version', 'letra', 'grande', 'pack', 'combo', 'envio', 'gratis', 'stock',
]);

/** Minúsculas, sin tildes ni signos. */
export function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim();
}

/** Palabras que identifican el libro (4 letras o más, sin palabras de relleno). */
export function titleTokens(value) {
  return [...new Set(normalizeTitle(value).split(' ').filter(word => word.length >= 4 && !STOPWORDS.has(word) && !/^\d+$/.test(word)))];
}

/**
 * Mismo libro por título: comparten al menos 2 palabras que identifican, y
 * esas palabras son al menos el 70% del título más corto.
 */
export function sameTitle(a, b) {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (!ta.length || !tb.length) return false;
  const [short, long] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
  const shared = short.filter(word => long.has(word)).length;
  return shared >= 2 && shared / short.length >= 0.7;
}

function cleanIsbn(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length === 10 || digits.length === 13 ? digits : '';
}

function matches(book, other) {
  if (book.itemId && other.itemId && book.itemId === other.itemId) return true;
  if (book.isbn && other.isbn && book.isbn === other.isbn) return true;
  return sameTitle(book.title, other.title);
}

function ddmm(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}` : '';
}

/** Filas de Airtable → { title, isbn, estado, canal, fecha } sin datos personales. */
export function airtableRows(records = []) {
  return records.map(record => {
    const f = record.fields || {};
    return {
      title: String(f['Título'] || '').trim(),
      isbn: cleanIsbn(f.ISBN),
      estado: String(f.Estado?.name ?? f.Estado ?? '').trim(),
      canal: String(f.Canal?.name ?? f.Canal ?? '').trim(),
      fecha: String(f['Fecha consulta'] || ''),
    };
  }).filter(row => row.title);
}

/** Lee de Airtable las consultas de WhatsApp e Instagram desde `sinceDate` (YYYY-MM-DD). */
export async function fetchAirtablePedidos({ token, sinceDate, fetchImpl = fetch }) {
  if (!token) return { error: 'falta AIRTABLE_TOKEN' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceDate)) return { error: `fecha inválida: ${sinceDate}` };
  const records = [];
  let offset = '';
  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams();
    for (const field of AIRTABLE_FIELDS) params.append('fields[]', field);
    params.set('filterByFormula', `IS_AFTER({Fecha consulta}, '${sinceDate}')`);
    params.set('pageSize', '100');
    if (offset) params.set('offset', offset);
    const response = await fetchImpl(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}?${params}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const text = (await response.text()).replace(/\s+/g, ' ').slice(0, 160);
      return { error: `Airtable HTTP ${response.status}: ${text}` };
    }
    const body = await response.json();
    records.push(...(body.records || []));
    if (!body.offset) break;
    offset = body.offset;
  }
  return airtableRows(records);
}

/**
 * Arma el cruce. Todas las entradas son listas ya leídas (o { error }).
 * webItems: [{ itemId, itemName, itemsViewed, itemsAddedToCart }] (GA4, 7 días)
 * mlSales: [{ item_id, title, isbn, quantity, last_date }] (D1)
 * webOrders: [{ product_id, title, quantity, paid }] (D1)
 * airtable: [{ title, isbn, estado, canal, fecha }]
 */
export function buildCross({ webItems, mlSales, webOrders, airtable, limit = 15 }) {
  const list = value => (Array.isArray(value) ? value : []);
  const books = new Map();
  for (const row of list(webItems)) {
    const itemId = /^MLU\d+$/i.test(String(row.itemId || '')) ? String(row.itemId).toUpperCase() : '';
    const title = String(row.itemName || '').trim();
    if (!title || title === '(not set)') continue;
    const key = itemId || normalizeTitle(title);
    const book = books.get(key) || { itemId, title, isbn: '', views: 0, cart: 0 };
    book.views += Number(row.itemsViewed || 0);
    book.cart += Number(row.itemsAddedToCart || 0);
    books.set(key, book);
  }
  const ml = list(mlSales).map(r => ({ itemId: String(r.item_id || '').toUpperCase(), title: r.title, isbn: cleanIsbn(r.isbn), quantity: Number(r.quantity || 0), last: r.last_date }));
  const web = list(webOrders).map(r => ({ itemId: String(r.product_id || '').toUpperCase(), title: r.title, isbn: '', quantity: Number(r.quantity || 0), paid: Number(r.paid || 0) }));
  const wa = list(airtable);

  const rows = [...books.values()]
    .filter(book => book.views > 0)
    .sort((a, b) => b.views - a.views)
    .map(book => {
      // El ISBN de la venta en ML sirve para encontrar la consulta en Airtable.
      const mlHits = ml.filter(sale => matches(book, sale));
      const isbn = mlHits.find(sale => sale.isbn)?.isbn || '';
      const withIsbn = { ...book, isbn };
      const waHits = wa.filter(row => matches(withIsbn, row));
      const webHits = web.filter(order => matches(book, order));
      return { book, mlHits, waHits, webHits };
    });

  const shown = rows.slice(0, limit);
  const any = rows.filter(r => r.mlHits.length || r.waHits.length || r.webHits.length);
  // Si un libro con cruce quedó fuera del top por vistas, igual se muestra.
  for (const row of any) if (!shown.includes(row)) shown.push(row);

  return {
    total: rows.length,
    soldMl: rows.filter(r => r.mlHits.length).length,
    askedWa: rows.filter(r => r.waHits.length).length,
    boughtWa: rows.filter(r => r.waHits.some(h => BOUGHT.has(h.estado.toLowerCase()))).length,
    orderedWeb: rows.filter(r => r.webHits.length).length,
    rows: shown.map(({ book, mlHits, waHits, webHits }) => ({
      title: book.title,
      views: book.views,
      cart: book.cart,
      web: webHits.length
        ? `${webHits.reduce((s, h) => s + h.quantity, 0)} pedido${webHits.some(h => h.paid) ? ' (pagado)' : ' (sin pagar)'}`
        : '—',
      ml: mlHits.length
        ? `${mlHits.reduce((s, h) => s + h.quantity, 0)} vendido${mlHits.reduce((s, h) => s + h.quantity, 0) > 1 ? 's' : ''}${(() => { const last = mlHits.map(h => h.last).filter(Boolean).sort().pop(); return last ? ` (último ${ddmm(last)})` : ''; })()}`
        : '—',
      wa: waHits.length
        ? waHits.slice(0, 3).map(h => `${BOUGHT.has(h.estado.toLowerCase()) ? 'compró' : (h.estado || 'consulta')}${h.canal ? ` por ${h.canal}` : ''}${ddmm(h.fecha) ? ` ${ddmm(h.fecha)}` : ''}`).join('; ')
        : '—',
    })),
  };
}
