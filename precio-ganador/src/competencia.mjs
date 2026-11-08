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
import { readShipping, SHIPPING_CITY } from '../../worker-sync/ml-competition.js';

// Plazo de entrega de una publicación ajena por /items/{id}/shipping_options
// (misma lectura que worker-sync/ml-competition.js, PR #547):
//   'inmediato' = sin preparación (schedule null y despacho de 24 h o menos)
//   'demanda'   = horas de preparación declaradas
//   'sin_dato'  = no se pudo leer (403, sin opciones, plazo ilegible)
export async function entregaDe(ml, itemId, cache) {
  if (!itemId) return 'sin_dato';
  if (cache?.has(itemId)) return cache.get(itemId);
  let r = 'sin_dato';
  try {
    const env = readShipping(await ml.get(`/items/${itemId}/shipping_options?city_to=${SHIPPING_CITY}`));
    if (env && !env.sin_envio && env.plazo_dias !== null) r = env.plazo_dias > 0 ? 'demanda' : 'inmediato';
  } catch (e) { if (e?.status === 429) throw e; }
  cache?.set(itemId, r);
  return r;
}
const entero = n => Math.floor(Number(n) + 1e-9);

export const MUESTRAS = { price_to_win: [], suggestions: [], products_items: [], seller_promotions: [], sale_price: [] };
const muestra = (k, v) => { if (MUESTRAS[k].length < 3) MUESTRAS[k].push(v); };

export async function competencia(ml, item, opciones) {
  const { necesitaTecho = false, sellerId } = opciones;
  if (item.catalog_listing) return catalogo(ml, item, opciones);
  // Publicaciones tradicionales que también compiten por ser la destacada de un
  // producto (el panel las cuenta en "Para ganar la competencia"): price_to_win
  // responde para ellas igual que para las de catálogo. Si no compiten, 404.
  const c = await catalogo(ml, item, opciones);
  if (!c.error) return { ...c, tipo: 'tradicional' };
  if (c.error !== 'http_404' && c.error !== 'http_400') return c;
  return referencia(ml, item);
}

async function catalogo(ml, item, { necesitaTecho, sellerId, soloContraDemanda = false, descuento = 0, cache }) {
  let p;
  try { p = await ml.get(`/items/${item.id}/price_to_win?version=v2`); }
  catch (e) { return { tipo: 'catalogo', error: codigo(e) }; }
  muestra('price_to_win', p);
  const estado = String(p?.status ?? '');
  const ganador = num(p?.price_to_win);
  const compite = estado === 'competing' && ganador !== null && ganador < Number(item.price);
  const r = { tipo: 'catalogo', estado, ganador, compite, marcada: compite, ganadorItem: p?.winner?.item_id ?? null, motivos: Array.isArray(p?.reason) ? p.reason : [],
    oportunidades: (Array.isArray(p?.boosts) ? p.boosts : []).filter(b => b?.status === 'opportunity').map(b => String(b.id)),
    boosts: Object.fromEntries((Array.isArray(p?.boosts) ? p.boosts : []).filter(b => b?.id).map(b => [String(b.id), String(b.status ?? '')])) };
  // Sólo contra ganadores a demanda: si el que gana entrega de inmediato, bajar el
  // precio no sirve (ML lo prefiere igual) y se regalaría margen. Sin dato, no se toca.
  if (soloContraDemanda && compite) {
    const entrega = await entregaDe(ml, r.ganadorItem, cache);
    r.entrega_ganador = entrega;
    if (entrega === 'inmediato') { r.bloqueo = 'ganador_inmediato'; r.marcada = false; r.motivo_bloqueo = 'el ganador entrega de inmediato'; }
    else if (entrega === 'sin_dato') { r.bloqueo = 'ganador_sin_dato'; r.marcada = false; r.motivo_bloqueo = 'sin dato del plazo del ganador'; }
  }
  // Techo para subir una publicación que el sistema bajó: un peso abajo del
  // competidor más barato (Libros) o el 99 % del competidor a demanda más barato
  // (Vintage), ignorando a los de entrega inmediata.
  if (!r.marcada && necesitaTecho && item.catalog_product_id) {
    try {
      const otros = (await ofertasCatalogo(ml, item.catalog_product_id))
        .filter(o => String(o.seller_id) !== String(sellerId) && o.item_id !== item.id && num(o.price) !== null)
        .map(o => ({ item_id: o.item_id, price: Number(o.price) })).sort((a, b) => a.price - b.price);
      let base = null;
      if (!soloContraDemanda) base = otros[0]?.price ?? null;
      else for (const o of otros.slice(0, 8)) { if ((await entregaDe(ml, o.item_id, cache)) === 'inmediato') continue; base = o.price; break; }
      r.techo_de = base;
      r.techo = base === null ? null : (descuento ? entero(base * (1 - descuento)) : base - 1);
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

// Por qué pierde una publicación (sólo lectura, para el informe; no cambia ninguna decisión).
// Seba, 08/11/2026: a veces no perdemos por precio sino por el envío gratis o por la
// reputación y el plazo del ganador; bajar el precio ahí regala margen.
//   causa 'precio'        hay otro vendedor más barato que nosotros en la ficha
//   causa 'envio_gratis'  nadie es más barato y ML marca el envío gratis como oportunidad
//   causa 'reputacion_entrega'  nadie es más barato y el ganador es MercadoLíder o ML
//                         marca Full / envío en el día como oportunidad
//   causa 'otro'          nadie es más barato y no hay una oportunidad marcada
export async function porQuePierde(ml, item, comp, { sellerId, cacheVendedores = new Map() } = {}) {
  if (!item?.catalog_product_id) return { causa: 'sin_ficha' };
  let ofertas;
  try { ofertas = await ofertasCatalogo(ml, item.catalog_product_id); }
  catch (e) { if (e?.status === 429) throw e; return { causa: 'error', error: codigo(e) }; }
  const otros = ofertas.filter(o => String(o.seller_id) !== String(sellerId) && o.item_id !== item.id && num(o.price) !== null)
    .map(o => ({ item_id: o.item_id, price: Number(o.price), seller_id: String(o.seller_id) })).sort((a, b) => a.price - b.price);
  const masBarato = otros[0] ?? null;
  const ganador = otros.find(o => o.item_id === comp?.ganadorItem) ?? null;
  let nivelGanador = null;
  if (ganador) {
    if (!cacheVendedores.has(ganador.seller_id)) {
      let nivel = null;
      try { const u = await ml.get(`/users/${ganador.seller_id}`); nivel = u?.seller_reputation?.power_seller_status ?? 'ninguno'; } catch (e) { if (e?.status === 429) throw e; }
      cacheVendedores.set(ganador.seller_id, nivel);
    }
    nivelGanador = cacheVendedores.get(ganador.seller_id);
  }
  const boosts = comp?.boosts ?? {};
  // Nuestro nivel de MercadoLíder (una lectura por corrida).
  if (!cacheVendedores.has('yo')) {
    let nivel = null;
    try { const u = await ml.get(`/users/${sellerId}`); nivel = u?.seller_reputation?.power_seller_status ?? 'ninguno'; } catch (e) { if (e?.status === 429) throw e; }
    cacheVendedores.set('yo', nivel);
  }
  const falta = Object.entries(boosts).filter(([, st]) => st === 'opportunity').map(([id]) => id);
  const precio = Number(item.price);
  const causa = masBarato && masBarato.price < precio ? 'precio'
    : boosts.free_shipping === 'opportunity' ? 'envio_gratis'
    : (nivelGanador && nivelGanador !== 'ninguno') || falta.some(b => b === 'fulfillment' || b === 'same_day_shipping') ? 'reputacion_entrega'
    : 'otro';
  // Envío gratis: lo que nos costaría por venta (sólo lectura). Si ML no lo informa, null.
  let costoEnvioGratis = null, palanca = null;
  if (causa === 'envio_gratis') {
    try {
      const o = await ml.get(`/users/${sellerId}/shipping_options/free?item_id=${item.id}`);
      const c = num(o?.coverage?.all_country?.list_cost ?? o?.coverage?.all_country?.cost);
      costoEnvioGratis = c;
    } catch (e) { if (e?.status === 429) throw e; }
    // Criterio de Seba (08/11/2026): "siempre que sirva, activarlo". Si perdemos por el
    // envío gratis, la palanca es el envío gratis, cueste lo que cueste; el costo se informa.
    palanca = 'envio_gratis';
  } else if (causa === 'precio' || causa === 'reputacion_entrega') palanca = 'bajar';
  return {
    causa, palanca, costo_envio_gratis: costoEnvioGratis, nuestro_nivel: cacheVendedores.get('yo') ?? null, competidores: otros.length,
    mas_barato: masBarato?.price ?? null, mas_barato_item: masBarato?.item_id ?? null,
    ganador_precio: ganador?.price ?? null, ganador_nivel: nivelGanador,
    envio_gratis_propio: boosts.free_shipping === 'boosted' ? true : boosts.free_shipping === 'opportunity' ? false : null,
    le_falta: falta,
  };
}
