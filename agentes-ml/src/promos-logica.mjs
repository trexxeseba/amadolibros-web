// Lógica pura del job de promociones por título (sin red, sin reloj implícito).
// La parte con red está en promos.mjs; esto se prueba solo.
import { LIMITES, normalizar, esLibroMedico } from './guardas.mjs';

const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const lista = j => Array.isArray(j) ? j : Array.isArray(j?.results) ? j.results : [];
export const TIPOS_ESCRIBIBLES = new Set(['SELLER_CAMPAIGN', 'DEAL', 'SMART', 'SMART_LIGHTNING', 'PRICE_DISCOUNT', 'MARKETPLACE_CAMPAIGN']);
export const TIPOS_PROHIBIDOS = new Set(['SELLER_COUPON_CAMPAIGN', 'LIGHTNING']);

// Promoción por nombre entre las del vendedor: coincidencia exacta (sin tildes ni
// mayúsculas); si no hay, la única que contiene el texto. Dos candidatas = ambiguo.
export function buscarPromo(promos, nombre) {
  const n = normalizar(nombre);
  if (!n) return { error: 'nombre_vacio' };
  const todas = lista(promos).filter(p => p && p.id && p.type);
  const exactas = todas.filter(p => normalizar(p.name) === n);
  if (exactas.length === 1) return { promo: exactas[0] };
  if (exactas.length > 1) {
    const vivas = exactas.filter(p => ['started', 'pending'].includes(String(p.status).toLowerCase()));
    return vivas.length === 1 ? { promo: vivas[0] } : { error: 'ambiguo', candidatas: exactas.map(p => `${p.id} ${p.type} ${p.status}`) };
  }
  const parciales = todas.filter(p => normalizar(p.name).includes(n));
  if (parciales.length === 1) return { promo: parciales[0] };
  return parciales.length ? { error: 'ambiguo', candidatas: parciales.map(p => `${p.id} ${p.type} ${p.status} "${p.name}"`) } : { error: 'no_encontrada' };
}

// Entrada de la publicación en la promo (GET /seller-promotions/items/{MLU} devuelve un array).
export function entradaEnPromo(entradas, promo) {
  const arr = lista(entradas);
  return arr.find(e => e?.id === promo?.id) ?? arr.find(e => !e?.id && e?.type === promo?.type) ?? null;
}

// Precio final que se manda. Respeta lo que la promo acepta para ese ítem
// (min/max_discounted_price); si Seba no pidió uno, usa el máximo (menor descuento).
export function precioObjetivo({ entrada, precioPedido = null, precioActual = null }) {
  const min = num(entrada?.min_discounted_price), max = num(entrada?.max_discounted_price), sug = num(entrada?.suggested_discounted_price);
  // Las campañas del vendedor (SELLER_CAMPAIGN, DEAL) traen price: 0 en la entrada candidata:
  // un 0 no es un precio fijado. Sólo SMART / SMART_LIGHTNING fijan el precio final en `price`.
  const fijoLeido = num(entrada?.price);
  const fijo = fijoLeido !== null && fijoLeido > 0 ? fijoLeido : null;
  const pedido = num(precioPedido);
  if (pedido !== null) {
    if (pedido <= 0) return { error: 'precio_invalido' };
    if (min !== null && pedido < min) return { error: 'precio_bajo_el_minimo', min, max };
    if (max !== null && pedido > max) return { error: 'precio_sobre_el_maximo', min, max };
    if (fijo !== null && Math.abs(fijo - pedido) > 0.009 && min === null && max === null) return { error: 'precio_fijado_por_ml', fijo };
    return { precio: pedido, fuente: 'pedido' };
  }
  // Sin precio pedido va el MENOR descuento que acepta la promo (max_discounted_price). El
  // sugerido de Mercado Libre suele ser de 30 % a 55 % (lote del 11/11): sólo si no hay rango.
  if (max !== null && max > 0) return { precio: max, fuente: 'maximo' };
  if (sug !== null && sug > 0) return { precio: sug, fuente: 'sugerido' };
  if (fijo !== null) return { precio: fijo, fuente: 'fijado_por_ml' };
  if (num(precioActual) !== null) return { error: 'sin_rango_de_precio' };
  return { error: 'sin_precio' };
}

// Cuerpo del POST /seller-promotions/items/{MLU}?app_version=v2.
export function cuerpoPost(promo, precio, entrada = null) {
  const body = { promotion_id: promo.id, promotion_type: promo.type, deal_price: precio };
  if (['SMART', 'SMART_LIGHTNING'].includes(promo.type) && entrada?.offer_id) body.offer_id = entrada.offer_id;
  return body;
}

// Cupones vigentes (SELLER_COUPON_CAMPAIGN) con el monto leído de sus items.
export function cuponesVigentes(promos, montosPorPromo = {}) {
  return lista(promos).filter(p => p?.type === 'SELLER_COUPON_CAMPAIGN').map(p => ({
    id: p.id, status: p.status, name: p.name,
    fixed_amount: num(montosPorPromo[p.id]?.fixed_amount) ?? num(p.fixed_amount) ?? num(p.benefits?.fixed_amount),
  }));
}

// Unidades vendidas por publicación a partir de las órdenes (pagas, no canceladas).
export function unidadesPorItem(ordenes) {
  const m = new Map();
  for (const o of ordenes) {
    const estado = String(o?.status ?? '').toLowerCase();
    if (['cancelled', 'invalid'].includes(estado)) continue;
    for (const oi of o?.order_items ?? []) {
      const id = oi?.item?.id; if (!id) continue;
      m.set(id, (m.get(id) ?? 0) + (num(oi.quantity) ?? 0));
    }
  }
  return m;
}

// Selección de títulos para promocionar: venden y los miran. Puntaje = unidades x 100 +
// visitas (las ventas mandan, las visitas desempatan). Fuera: sin stock mínimo, libro
// médico, lista manual, no activos, ya en la promo destino.
export function armarSeleccion({ items, unidades, visitas, config = {}, enPromo = new Set(), limite = 50 }) {
  const fuera = {};
  const contar = k => { fuera[k] = (fuera[k] ?? 0) + 1; };
  const candidatos = [];
  for (const it of items) {
    if (!it?.id) continue;
    if (String(it.status) !== 'active') { contar('no_activo'); continue; }
    const stock = num(it.available_quantity);
    if (stock === null || stock < LIMITES.stockMinimoParaPromo) { contar('stock_bajo'); continue; }
    if (esLibroMedico(it.title, config)) { contar('libro_medico'); continue; }
    if ((config.items ?? []).map(String).includes(String(it.id))) { contar('lista_manual'); continue; }
    if (enPromo.has(it.id)) { contar('ya_en_promo'); continue; }
    const u = unidades.get(it.id) ?? 0, v = num(visitas.get(it.id)) ?? 0;
    if (u <= 0) { contar('sin_ventas'); continue; }
    candidatos.push({ id: it.id, title: it.title ?? null, price: num(it.price), available_quantity: stock, catalog_listing: it.catalog_listing ?? null, unidades: u, visitas: v, puntaje: u * 100 + v });
  }
  candidatos.sort((a, b) => b.puntaje - a.puntaje || String(a.id).localeCompare(String(b.id)));
  return { seleccion: candidatos.slice(0, limite), candidatos: candidatos.length, fuera };
}

// Gasto del mes de Product Ads: suma del costo de todas las campañas (metrics_summary
// si viene; si no, campaña por campaña). Devuelve null si no hay ningún dato.
export function gastoDelMes(respuesta) {
  const resumen = num(respuesta?.metrics_summary?.cost);
  if (resumen !== null) return resumen;
  const camps = lista(respuesta);
  const costos = camps.map(c => num(c?.metrics?.cost)).filter(v => v !== null);
  return costos.length ? Math.round(costos.reduce((a, b) => a + b, 0) * 100) / 100 : null;
}

// Primer día del mes calendario (Montevideo) de una fecha AAAA-MM-DD.
export const primerDiaDelMes = fecha => String(fecha).slice(0, 8) + '01';

// Bucket de un porcentaje para el log público (de 5 en 5).
export const bucketPct = pct => pct === null || pct === undefined ? null : `${Math.floor(pct / 5) * 5}-${Math.floor(pct / 5) * 5 + 5}%`;
