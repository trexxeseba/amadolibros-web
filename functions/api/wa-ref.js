// Registro de los códigos de consulta de WhatsApp (astro-front/public/wa-ref.js).
// Guarda en D1 el código, la página y, si la visita vino de un anuncio, el
// identificador del clic (gclid/gbraid/wbraid) para atribuir después la venta
// a su campaña. No recibe ni guarda datos personales.

const REF = /^AL-[A-Z2-9]{4}$/;
const CLICK_ID = /^[A-Za-z0-9_-]{8,200}$/;
const CLICK_TYPES = new Set(['gclid', 'gbraid', 'wbraid']);
const PRODUCT = /^MLU\d{1,20}$/;

export const WA_REFS_SCHEMA = `CREATE TABLE IF NOT EXISTS wa_refs(
  ref TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  page TEXT,
  product_id TEXT,
  click_id TEXT,
  click_id_type TEXT,
  utm_source TEXT,
  utm_campaign TEXT
)`;

const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

export function parseWaRef(body) {
  if (!body || typeof body !== 'object') return null;
  const ref = clean(body.ref, 10);
  if (!REF.test(ref)) return null;
  const page = clean(body.page, 300);
  const clickId = clean(body.click_id, 200);
  const clickType = clean(body.click_id_type, 10);
  const validClick = CLICK_ID.test(clickId) && CLICK_TYPES.has(clickType);
  const product = clean(body.product_id, 24).toUpperCase();
  return {
    ref,
    page: page.startsWith('/') ? page : '',
    product_id: PRODUCT.test(product) ? product : '',
    click_id: validClick ? clickId : '',
    click_id_type: validClick ? clickType : '',
    utm_source: clean(body.utm_source, 40).replace(/[^\w.\-]/g, ''),
    utm_campaign: clean(body.utm_campaign, 80),
  };
}

export async function onRequestPost(ctx) {
  const headers = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };
  let body = null;
  try {
    const text = await ctx.request.text();
    if (text.length > 2000) return new Response(null, { status: 413, headers });
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400, headers });
  }
  const row = parseWaRef(body);
  if (!row) return new Response(null, { status: 400, headers });
  const db = ctx?.env?.ORDERS_DB;
  if (!db) return new Response(null, { status: 204, headers });
  try {
    await db.prepare(WA_REFS_SCHEMA).run();
    await db
      .prepare('INSERT OR IGNORE INTO wa_refs(ref,created_at,page,product_id,click_id,click_id_type,utm_source,utm_campaign) VALUES (?,?,?,?,?,?,?,?)')
      .bind(row.ref, Date.now(), row.page, row.product_id, row.click_id, row.click_id_type, row.utm_source, row.utm_campaign)
      .run();
  } catch {
    // El código ya viaja en el mensaje: si D1 falla, no se rompe el clic.
  }
  return new Response(null, { status: 204, headers });
}

export function onRequest() {
  return new Response(null, { status: 405, headers: { allow: 'POST' } });
}
