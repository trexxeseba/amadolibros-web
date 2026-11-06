// Lecturas de Mercado Libre (sólo GET). Cada función devuelve datos normalizados;
// ante un error devuelve null o { estado: 'error' }: nunca "no hay competencia".
import { bulkItemsPath, bulkEntryItem } from '../../worker-sync/meli-bulk.js';
import { MlError } from './ml.mjs';
import { SELLER_ID } from '../config.mjs';

const ATRIBUTOS = 'id,title,seller_id,site_id,price,currency_id,status,catalog_listing,catalog_product_id,condition,variations,tags,attributes,original_price,deal_ids';
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const codigo = e => (e instanceof MlError ? e.code : (e?.code ?? 'error'));
const esFatal = e => e?.fatal === true;

export async function idsActivos(ml, sellerId = SELLER_ID, { limite = Infinity } = {}) {
  const ids = []; let scroll = null;
  for (let pagina = 0; pagina < 500 && ids.length < limite; pagina++) {
    const d = await ml.get(`/users/${sellerId}/items/search?status=active&search_type=scan&limit=100${scroll ? `&scroll_id=${encodeURIComponent(scroll)}` : ''}`);
    const res = Array.isArray(d?.results) ? d.results : [];
    if (!res.length) break;
    ids.push(...res); scroll = d?.scroll_id ?? null;
    if (!scroll) break;
  }
  return [...new Set(ids)].slice(0, limite);
}

export const gtinDe = attrs => {
  const a = (attrs ?? []).find(x => x?.id === 'GTIN' || x?.id === 'ISBN');
  const v = String(a?.value_name ?? '').replace(/[^0-9Xx]/g, '');
  return v ? v.toUpperCase() : null;
};

export function normalizarItem(b) {
  return {
    id: b.id, title: b.title ?? '', seller_id: String(b.seller_id ?? ''), site_id: b.site_id ?? null,
    price: num(b.price), currency_id: b.currency_id, status: b.status,
    catalog_listing: b.catalog_listing === true, catalog_product_id: b.catalog_product_id ?? null,
    condition: b.condition ?? null, variaciones: Array.isArray(b.variations) && b.variations.length > 0,
    precio_administrado: Array.isArray(b.tags) && b.tags.includes('dynamic_standard_price'),
    gtin: gtinDe(b.attributes), original_price: num(b.original_price), deal_ids: Array.isArray(b.deal_ids) ? b.deal_ids : [],
  };
}

export async function detalleItems(ml, ids) {
  const out = new Map(), lotes = [];
  for (let i = 0; i < ids.length; i += 20) lotes.push(ids.slice(i, i + 20));
  await Promise.all(lotes.map(async lote => {
    const d = await ml.get(bulkItemsPath(lote, ATRIBUTOS));
    for (const e of Array.isArray(d) ? d : []) { const b = bulkEntryItem(e); if (b?.id) out.set(b.id, normalizarItem(b)); }
  }));
  return out;
}

export async function itemFresco(ml, id) {
  try { return normalizarItem(await ml.get(`/items/${id}?attributes=${ATRIBUTOS}`)); }
  catch (e) { if (esFatal(e)) throw e; return null; }
}

// Precio efectivo (lo que paga el comprador en el canal marketplace).
export async function precioEfectivo(ml, id) {
  try {
    const s = await ml.get(`/items/${id}/sale_price?context=channel_marketplace`);
    const amount = num(s?.amount), regular = num(s?.regular_amount);
    return { precio: amount, regular, descuentoVigente: amount !== null && regular !== null && amount < regular, promocionId: s?.metadata?.promotion_id ?? null };
  } catch (e) { if (esFatal(e)) throw e; return null; }
}

// Promociones: /seller-promotions (started = activa, pending = programada), más
// /items/{id}/prices (precios de tipo promotion vigentes o con inicio futuro) y el
// sale_price. null = no se pudo saber.
export async function promocion(ml, id, sale = null) {
  let sp = null, pr = null;
  try {
    const d = await ml.get(`/seller-promotions/items/${id}?app_version=v2`);
    sp = Array.isArray(d) ? d : Array.isArray(d?.results) ? d.results : [];
  } catch (e) { if (esFatal(e)) throw e; sp = e?.status === 404 ? [] : null; }
  try { pr = await ml.get(`/items/${id}/prices`); } catch (e) { if (esFatal(e)) throw e; pr = e?.status === 404 ? { prices: [] } : null; }
  const estados = (sp ?? []).map(p => String(p?.status ?? '').toLowerCase());
  const ahora = Date.now();
  const promosPrecio = (Array.isArray(pr?.prices) ? pr.prices : []).filter(p => p?.type === 'promotion');
  const futura = promosPrecio.some(p => Date.parse(p?.conditions?.start_time ?? '') > ahora);
  const vigente = promosPrecio.some(p => !(Date.parse(p?.conditions?.start_time ?? '') > ahora) && !(Date.parse(p?.conditions?.end_time ?? '') < ahora));
  if (estados.includes('started') || vigente || sale?.descuentoVigente) return 'activa';
  if (estados.includes('pending') || futura) return 'programada';
  if (sp === null || pr === null || sale === null) return null;
  return 'ninguna';
}

// Automatización nativa: GET /pricing-automation/items/{id}/automation.
// 404 = no tiene. Cualquier status distinto de PAUSED/DELETED cuenta como activa.
export async function automatizacion(ml, id) {
  try {
    const a = await ml.get(`/pricing-automation/items/${id}/automation`);
    const st = String(a?.status ?? a?.item_rule?.status ?? '').toUpperCase();
    return st === 'PAUSED' || st === 'DELETED' || st === 'INACTIVE' ? 'ninguna' : 'activa';
  } catch (e) { if (esFatal(e)) throw e; return e?.status === 404 ? 'ninguna' : null; }
}

export async function priceToWin(ml, id) {
  try {
    const p = await ml.get(`/items/${id}/price_to_win?version=v2`);
    return { ok: true, status: String(p?.status ?? ''), priceToWin: num(p?.price_to_win), winnerItem: p?.winner?.item_id ?? null, winnerPrice: num(p?.winner?.price), catalogProductId: p?.catalog_product_id ?? null, reason: Array.isArray(p?.reason) ? p.reason : [] };
  } catch (e) { if (esFatal(e)) throw e; return { ok: false, status: e?.status ?? 0, error: codigo(e) }; }
}

async function ofertasCatalogo(ml, productId) {
  const todos = [];
  for (let offset = 0; offset < 500; offset += 50) {
    const d = await ml.get(`/products/${productId}/items?limit=50&offset=${offset}`);
    const res = Array.isArray(d?.results) ? d.results : [];
    todos.push(...res);
    if (res.length < 50 || todos.length >= Number(d?.paging?.total ?? 0)) break;
  }
  return todos;
}

async function gtinProducto(ml, productId) {
  try { return gtinDe((await ml.get(`/products/${productId}`))?.attributes); }
  catch (e) { if (esFatal(e)) throw e; return null; }
}

// Competidor externo válido. Sólo catálogo: misma ficha (mismo ISBN y edición por
// definición del producto), mismo estado (nuevo/usado), moneda UYU, otro vendedor.
export async function competencia(ml, item, ptw, { referencia = 'mas_barata' } = {}) {
  const productId = item.catalog_product_id ?? ptw?.catalogProductId ?? null;
  if (!ptw?.ok || ptw.status === 'not_listed' || !productId) return { estado: 'ok', tipo: 'sin_catalogo', ptwStatus: ptw?.status ?? null, motivo: ptw?.error ?? ptw?.status ?? 'sin ficha' };
  let ofertas;
  try { ofertas = await ofertasCatalogo(ml, productId); }
  catch (e) { if (esFatal(e)) throw e; return { estado: 'error', error: 'ofertas_' + codigo(e) }; }
  const externas = ofertas.filter(o => String(o?.seller_id) !== String(item.seller_id) && o?.item_id !== item.id && num(o?.price) !== null && (o?.currency_id ?? 'UYU') === 'UYU');
  const base = { estado: 'ok', tipo: 'catalogo', productId, ptwStatus: ptw.status, winnerItem: ptw.winnerItem, winnerPrice: ptw.winnerPrice, externas: externas.length };
  if (!externas.length) return { ...base, sinExternos: true, comparable: true, C: null };
  // Comparabilidad: el ISBN de nuestra publicación y el de la ficha, si los dos están, deben coincidir.
  const gtinFicha = item.gtin ? await gtinProducto(ml, productId) : null;
  if (item.gtin && gtinFicha && item.gtin !== gtinFicha) return { ...base, comparable: false, motivoComparable: 'el ISBN de la publicación no coincide con el de la ficha' };
  const mismas = externas.filter(o => !o?.condition || !item.condition || o.condition === item.condition).sort((a, b) => Number(a.price) - Number(b.price));
  if (!mismas.length) return { ...base, sinExternos: true, comparable: true, C: null, motivo: 'sólo competidores en otro estado' };
  let elegido = mismas[0], fuente = 'products_items:mas_barata';
  if (referencia === 'ganador') {
    const g = mismas.find(o => o.item_id === ptw.winnerItem);
    if (!g) return { ...base, sinExternos: false, comparable: true, C: null, fuente: 'ganador_propio_o_ausente' };
    elegido = g; fuente = 'price_to_win:winner';
  }
  const comparable = item.condition && elegido.condition ? true : null;
  return { ...base, sinExternos: false, comparable, motivoComparable: comparable ? null : (!item.condition ? 'condición propia no informada' : 'condición del competidor no informada'), C: Number(elegido.price), competidor: elegido.item_id, competidorSeller: String(elegido.seller_id), fuente };
}
