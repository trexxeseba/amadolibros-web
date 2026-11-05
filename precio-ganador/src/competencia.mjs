// Estado de competencia de cada publicación. Sólo GET.
//
//  - Publicación de catálogo: GET /items/{id}/price_to_win?version=v2.
//    Marcada ("Precio para ganar") = status competing con price_to_win menor
//    al precio actual. winning y sharing_first_place no se tocan.
//  - Publicación sin catálogo: GET /suggestions/items/{id}/details (precios de
//    referencia). Marcada ("Precio alto") = status con "high" y precio sugerido
//    menor al actual.
//
// techo: hasta dónde se puede subir una publicación que el sistema bajó sin
// volver a perder (un peso abajo del competidor más barato). null = sin
// competencia a la vista, se puede volver al original.
import { MlError } from './ml.mjs';

export const MUESTRAS = { price_to_win: [], suggestions: [], products_items: [], seller_promotions: [], sale_price: [] };
const muestra = (k, v) => { if (MUESTRAS[k].length < 3) MUESTRAS[k].push(v); };

export async function competencia(ml, item, { necesitaTecho = false, sellerId }) {
  if (item.catalog_listing) return catalogo(ml, item, { necesitaTecho, sellerId });
  // Publicaciones tradicionales que también compiten por ser la destacada de un
  // producto (el panel las cuenta en "Para ganar la competencia"): price_to_win
  // responde para ellas igual que para las de catálogo. Si no compiten, 404.
  const c = await catalogo(ml, item, { necesitaTecho, sellerId });
  if (!c.error) return { ...c, tipo: 'tradicional' };
  if (c.error !== 'http_404' && c.error !== 'http_400') return c;
  return referencia(ml, item);
}

async function catalogo(ml, item, { necesitaTecho, sellerId }) {
  let p;
  try { p = await ml.get(`/items/${item.id}/price_to_win?version=v2`); }
  catch (e) { return { tipo: 'catalogo', error: codigo(e) }; }
  muestra('price_to_win', p);
  const estado = String(p?.status ?? '');
  const ganador = num(p?.price_to_win);
  const marcada = estado === 'competing' && ganador !== null && ganador < Number(item.price);
  const r = { tipo: 'catalogo', estado, ganador, marcada, ganadorItem: p?.winner?.item_id ?? null, motivos: Array.isArray(p?.reason) ? p.reason : [],
    oportunidades: (Array.isArray(p?.boosts) ? p.boosts : []).filter(b => b?.status === 'opportunity').map(b => String(b.id)) };
  if (!marcada && necesitaTecho && item.catalog_product_id) {
    try {
      const otros = await ofertasCatalogo(ml, item.catalog_product_id);
      const precios = otros.filter(o => String(o.seller_id) !== String(sellerId) && o.item_id !== item.id).map(o => num(o.price)).filter(v => v !== null);
      r.techo = precios.length ? Math.min(...precios) - 1 : null;
    } catch (e) { return { ...r, error: 'techo_' + codigo(e) }; }
  }
  return r;
}

async function ofertasCatalogo(ml, productId) {
  const todos = [];
  for (let offset = 0; offset < 500; offset += 50) {
    let d;
    try { d = await ml.get(`/products/${productId}/items?limit=50&offset=${offset}`); }
    catch (e) { if (e.status === 404) return todos; throw e; }
    muestra('products_items', { paging: d?.paging, primero: d?.results?.[0] ? { item_id: d.results[0].item_id, price: d.results[0].price, seller_id: d.results[0].seller_id } : null });
    const res = Array.isArray(d?.results) ? d.results : [];
    todos.push(...res);
    if (res.length < 50 || todos.length >= Number(d?.paging?.total ?? 0)) break;
  }
  return todos;
}

async function referencia(ml, item) {
  let d;
  try { d = await ml.get(`/suggestions/items/${item.id}/details`); }
  catch (e) {
    if (e.status === 404) return { tipo: 'referencia', estado: 'sin_referencia', ganador: null, marcada: false, techo: null };
    return { tipo: 'referencia', error: codigo(e) };
  }
  muestra('suggestions', d);
  const estado = String(d?.status ?? '');
  const sugerido = num(d?.suggested_price?.amount ?? d?.suggested_price);
  const marcada = /high/i.test(estado) && sugerido !== null && sugerido < Number(item.price);
  return { tipo: 'referencia', estado, ganador: sugerido, marcada, techo: marcada ? null : (sugerido !== null && sugerido >= Number(item.price) ? sugerido : null) };
}

// Promoción activa: GET /seller-promotions/items/{id}?app_version=v2 (status
// started). Si ese endpoint no responde, GET /items/{id}/sale_price: un
// regular_amount mayor al precio de venta es un descuento vigente.
// null = no se pudo saber (la publicación se saltea).
export async function promocionActiva(ml, itemId) {
  try {
    const d = await ml.get(`/seller-promotions/items/${itemId}?app_version=v2`);
    muestra('seller_promotions', d);
    const lista = Array.isArray(d) ? d : Array.isArray(d?.results) ? d.results : [];
    return lista.some(p => String(p?.status ?? '').toLowerCase() === 'started');
  } catch (e) {
    if (e.status === 404) return false;
    try {
      const s = await ml.get(`/items/${itemId}/sale_price?context=channel_marketplace`);
      muestra('sale_price', s);
      const reg = num(s?.regular_amount), monto = num(s?.amount);
      return reg !== null && monto !== null && monto < reg;
    } catch { return null; }
  }
}

const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const codigo = e => (e instanceof MlError ? e.code : (e?.code ?? 'error'));
