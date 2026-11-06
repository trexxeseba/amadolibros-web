// Publicaciones activas de Amado Libros: ids por /users/{id}/items/search con
// scan (scroll), detalle por /items/bulk de a 20. Devuelve una lista normalizada
// con lo que el análisis necesita y señala posibles errores de configuración.
import { SELLER_ID } from './config.mjs';
import { itemIsbn } from './isbn.mjs';

const BULK_FIELDS = ['id', 'title', 'price', 'currency_id', 'status', 'available_quantity', 'permalink', 'condition', 'listing_type_id', 'catalog_listing', 'catalog_product_id', 'sale_terms', 'shipping', 'attributes', 'item_relations', 'domain_id', 'date_created', 'last_updated', 'sold_quantity', 'health'];

export async function listActiveIds(ml, { limit = Infinity } = {}) {
  const ids = []; let scroll = null; let total = null;
  while (ids.length < limit) {
    const q = new URLSearchParams({ status: 'active', search_type: 'scan', limit: '100' });
    if (scroll) q.set('scroll_id', scroll);
    const page = await ml.get(`/users/${SELLER_ID}/items/search?${q}`);
    total ??= Number(page?.paging?.total ?? 0);
    const got = Array.isArray(page?.results) ? page.results : [];
    if (!got.length) break;
    ids.push(...got);
    scroll = page.scroll_id ?? scroll;
    if (!page.scroll_id) break;
  }
  return { ids: ids.slice(0, limit), total };
}

// Días de preparación declarados (sale_terms MANUFACTURING_TIME). 0 = no declara
// plazo; null = no se pudo leer sale_terms. Ausencia de plazo NO prueba entrega
// inmediata: sólo que el vendedor no declaró uno.
export function manufacturingDays(item) {
  if (!Array.isArray(item?.sale_terms)) return null;
  const t = item.sale_terms.find(x => x?.id === 'MANUFACTURING_TIME');
  if (!t) return 0;
  const struct = t.value_struct ?? t.values?.[0]?.struct ?? null;
  const n = Number(struct?.number), unit = String(struct?.unit ?? '').toLowerCase();
  if (Number.isFinite(n) && n >= 0) {
    if (unit.startsWith('h')) return Math.ceil(n / 24);
    if (unit.startsWith('s') || unit.startsWith('w')) return Math.round(n * 7);
    if (unit.startsWith('m')) return Math.round(n * 30);
    return Math.round(n);
  }
  const text = String(t.value_name ?? '').toLowerCase(), m = text.match(/(\d+)/);
  if (!m) return null;
  const k = Number(m[1]);
  if (text.includes('hora')) return Math.ceil(k / 24);
  if (text.includes('semana')) return k * 7;
  if (text.includes('mes')) return k * 30;
  return k;
}

const attr = (item, id) => (item?.attributes ?? []).find(a => a?.id === id)?.value_name ?? null;

export function normalizeItem(raw) {
  const plazo = manufacturingDays(raw);
  return {
    id: raw.id, titulo: raw.title ?? '', enlace: raw.permalink ?? `https://articulo.mercadolibre.com.uy/${String(raw.id).replace(/^MLU/, 'MLU-')}`,
    isbn: itemIsbn(raw), precio: Number(raw.price), moneda: raw.currency_id ?? null,
    estado: raw.status, disponible: Number(raw.available_quantity ?? 0), condicion: raw.condition ?? null,
    catalogo: raw.catalog_listing === true, producto_catalogo: raw.catalog_product_id ?? null,
    plazo_dias: plazo, envio_gratis: raw.shipping?.free_shipping === true, logistica: raw.shipping?.logistic_type ?? null,
    relaciones: Array.isArray(raw.item_relations) ? raw.item_relations.map(r => r?.id).filter(Boolean) : [],
    idioma: attr(raw, 'LANGUAGE'), formato: attr(raw, 'BOOK_COVER') ?? attr(raw, 'FORMAT'), edicion: attr(raw, 'BOOK_EDITION'),
    dominio: raw.domain_id ?? null, vendidos: Number(raw.sold_quantity ?? 0),
  };
}

export async function fetchItems(ml, ids) {
  const items = [], fallidos = [];
  const chunks = []; for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));
  await Promise.all(chunks.map(async chunk => {
    const attrs = 'status_code,' + BULK_FIELDS.map(f => 'body.' + f).join(',');
    let rows;
    try { rows = await ml.get(`/items/bulk?ids=${chunk.join(',')}&attributes=${attrs}`); }
    catch (e) { fallidos.push(...chunk.map(id => ({ id, motivo: e.code }))); return; }
    // Lo que no vuelve como 200 con body (o directamente no vuelve) es fallido, con su id.
    const recibidos = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      const code = row?.status_code ?? row?.code;
      if (code === 200 && row.body?.id) { items.push(normalizeItem(row.body)); recibidos.add(row.body.id); }
    }
    for (const id of chunk) if (!recibidos.has(id)) fallidos.push({ id, motivo: 'no_leida' });
  }));
  items.sort((a, b) => a.id.localeCompare(b.id));
  return { items, fallidos };
}

// Errores de configuración propios: Amado entrega de inmediato, así que un plazo
// de preparación declarado es sospechoso. Una activa sin stock no es oportunidad.
export function configIssues(items) {
  const out = [];
  for (const it of items) {
    if (it.plazo_dias > 0) out.push({ item: it, tipo: 'plazo_configurado', texto: `Declara ${it.plazo_dias} días de preparación. Amado entrega de inmediato: revisar si es un error de carga.` });
    if (it.disponible <= 0) out.push({ item: it, tipo: 'sin_stock', texto: 'Activa sin disponibilidad publicada: no entra en las oportunidades.' });
    if (!it.isbn) out.push({ item: it, tipo: 'sin_isbn', texto: 'Sin ISBN en la publicación: no se puede buscar competencia por ISBN.' });
    if (it.moneda && it.moneda !== 'UYU') out.push({ item: it, tipo: 'moneda', texto: `Precio en ${it.moneda}.` });
  }
  return out;
}
