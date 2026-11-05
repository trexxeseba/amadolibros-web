// Publicaciones activas de la cuenta: scan completo + /items/bulk en lotes de 20
// (/items?ids= quedó dado de baja: responde 403 ResourceDeprecated).
import { bulkItemsPath, bulkEntryItem } from '../../worker-sync/meli-bulk.js';
const ATRIBUTOS = 'id,title,seller_custom_field,price,currency_id,catalog_listing,catalog_product_id,available_quantity,sale_terms,variations,status,original_price,deal_ids,permalink';

export async function idsActivos(ml, sellerId, { limite = Infinity } = {}) {
  const ids = []; let scroll = null;
  for (let pagina = 0; pagina < 500 && ids.length < limite; pagina++) {
    const q = `/users/${sellerId}/items/search?status=active&search_type=scan&limit=100${scroll ? `&scroll_id=${encodeURIComponent(scroll)}` : ''}`;
    const d = await ml.get(q);
    const res = Array.isArray(d?.results) ? d.results : [];
    if (!res.length) break;
    ids.push(...res); scroll = d?.scroll_id ?? null;
    if (!scroll) break;
  }
  return [...new Set(ids)].slice(0, limite);
}

export async function detalle(ml, ids) {
  const out = new Map();
  const lotes = []; for (let i = 0; i < ids.length; i += 20) lotes.push(ids.slice(i, i + 20));
  await Promise.all(lotes.map(async lote => {
    const d = await ml.get(bulkItemsPath(lote, ATRIBUTOS));
    for (const e of Array.isArray(d) ? d : []) { const b = bulkEntryItem(e); if (b?.id) out.set(b.id, normalizar(b)); }
  }));
  return out;
}

// "A demanda" = tiene días de disponibilidad (sale_term MANUFACTURING_TIME).
export function diasDemanda(item) {
  const t = (item.sale_terms ?? []).find(s => s?.id === 'MANUFACTURING_TIME');
  if (!t) return null;
  const n = Number(t.value_struct?.number ?? String(t.value_name ?? '').match(/\d+/)?.[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function normalizar(b) {
  const dias = diasDemanda(b);
  return {
    id: b.id, title: b.title ?? '', seller_custom_field: b.seller_custom_field ?? null, price: Number(b.price), currency_id: b.currency_id, status: b.status,
    catalog_listing: b.catalog_listing === true, catalog_product_id: b.catalog_product_id ?? null,
    available_quantity: Number(b.available_quantity), variaciones: Array.isArray(b.variations) && b.variations.length > 0,
    demanda: dias !== null, dias_demanda: dias, original_price: b.original_price ?? null,
    deal_ids: Array.isArray(b.deal_ids) ? b.deal_ids : [], permalink: b.permalink ?? null,
    sale_terms_ids: Array.isArray(b.sale_terms) ? b.sale_terms.map(t => t?.id) : null,
  };
}
