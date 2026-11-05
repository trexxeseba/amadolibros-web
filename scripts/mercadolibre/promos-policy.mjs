// Reglas de las promociones de Amado Libros (puras, sin red): qué se quita, qué se
// conserva y qué se suma. Las usa scripts/mercadolibre/promos.mjs; el Worker
// (worker-sync/seller-promotions.js) vuelve a frenar lo que no se puede escribir.
//
// Reglas de Seba que no se rompen:
//   - Tope de descuento 16 %.
//   - Excepción del 29 al 31/10/2026: hasta 20 % si descuento de promo + cupón es
//     de $750 o menos y el stock es 3 o más. Si no se puede comprobar, no se quita:
//     queda en "revisar".
//   - Nunca subir precios. Solo "salir de la promo": nada de pausar ni borrar.
//   - No usar Amado Liquidacion 40/30/20 (ni sumar ni sacar: se reporta).
//   - No tocar cupones ni publicidad.

export const DEFAULT_MAX_PCT = 16;
export const EXCEPTION = Object.freeze({ from: '2026-10-29', to: '2026-10-31', maxPct: 20, maxCombinedUyu: 750, minStock: 3 });
const ACTIVE = new Set(['started', 'pending']);
const COUPON_RE = /COUPON|CUPON/i;
const BLOCKED_TYPE_RE = /COUPON|CUPON|ADVERT|(^|_)ADS($|_)|PUBLICIDAD/i;
const LIQUIDACION_RE = /liquidaci[oó]n/i;

const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) ? Number(v) : null;
const round2 = v => Math.round(v * 100) / 100;

export function discountPct(entry) {
  const price = num(entry?.price), original = num(entry?.original_price);
  if (price !== null && original !== null && original > 0 && price <= original) return round2((1 - price / original) * 100);
  const meli = num(entry?.meli_percentage), seller = num(entry?.seller_percentage);
  if (meli !== null || seller !== null) return round2((meli ?? 0) + (seller ?? 0));
  return null;
}

export const uyDate = (date = new Date()) => new Date(date.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
export const inExceptionWindow = date => date >= EXCEPTION.from && date <= EXCEPTION.to;
export const isActiveStatus = status => ACTIVE.has(status);
export const isBlockedType = type => BLOCKED_TYPE_RE.test(String(type ?? ''));
export const isLiquidacion = name => LIQUIDACION_RE.test(String(name ?? ''));

// Monto en $ del cupón vigente o programado de una publicación. 0 si no tiene cupón;
// null si tiene cupón pero Mercado Libre no dio un monto que se pueda leer.
export function couponAmountUyu(promotions, price) {
  const coupons = (promotions ?? []).filter(p => COUPON_RE.test(String(p?.type ?? '')) && ACTIVE.has(p?.status));
  if (!coupons.length) return 0;
  let total = 0;
  for (const c of coupons) {
    const fixed = num(c.fixed_amount) ?? num(c.discount_amount) ?? num(c.amount);
    if (fixed !== null) { total += fixed; continue; }
    const pct = num(c.discount_percentage) ?? num(c.percentage), base = num(price);
    if (pct !== null && base !== null) { total += base * pct / 100; continue; }
    return null;
  }
  return round2(total);
}

// decision: dentro_del_tope | quitar | conservar_excepcion | revisar
export function classifyEntry(entry, { date, maxPct = DEFAULT_MAX_PCT, coupon_uyu, available_quantity } = {}) {
  const pct = discountPct(entry);
  if (pct === null) return { decision: 'revisar', reason: 'descuento_no_medible', pct };
  if (pct <= maxPct) return { decision: 'dentro_del_tope', pct };
  if (!inExceptionWindow(date)) return { decision: 'quitar', pct };
  if (pct > EXCEPTION.maxPct) return { decision: 'quitar', pct };
  const stock = num(available_quantity);
  if (stock !== null && stock < EXCEPTION.minStock) return { decision: 'quitar', pct };
  const coupon = coupon_uyu === undefined ? null : num(coupon_uyu);
  const original = num(entry?.original_price), price = num(entry?.price);
  if (stock === null || coupon === null || original === null || price === null) return { decision: 'revisar', reason: 'excepcion_no_verificable', pct };
  return (original - price) + coupon <= EXCEPTION.maxCombinedUyu
    ? { decision: 'conservar_excepcion', pct }
    : { decision: 'quitar', pct };
}

export function planRemovals(entries, { date, itemInfo = {}, maxPct = DEFAULT_MAX_PCT } = {}) {
  const plan = { removals: [], skipped: [], kept_by_exception: [], to_review: [] };
  for (const entry of entries) {
    if (!ACTIVE.has(entry.status)) continue;
    const info = itemInfo[entry.item_id] ?? {};
    const verdict = classifyEntry(entry, { date, maxPct, coupon_uyu: info.coupon_uyu, available_quantity: info.available_quantity });
    const ref = { item_id: entry.item_id, promotion_id: entry.promotion_id, discount_pct: verdict.pct };
    if (verdict.decision === 'dentro_del_tope') continue;
    if (isBlockedType(entry.promotion_type)) { plan.skipped.push({ ...ref, reason: 'cupon_o_publicidad_no_se_toca' }); continue; }
    if (isLiquidacion(entry.promotion_name)) { plan.skipped.push({ ...ref, reason: 'liquidacion_no_se_toca' }); continue; }
    if (verdict.decision === 'conservar_excepcion') plan.kept_by_exception.push(ref);
    else if (verdict.decision === 'revisar') plan.to_review.push({ ...ref, reason: verdict.reason });
    else plan.removals.push({ item_id: entry.item_id, promotion_id: entry.promotion_id, promotion_type: entry.promotion_type, discount_pct: verdict.pct });
  }
  return plan;
}

// promotions: { MLUxxx: [promociones de la publicación] }, itemInfo: { MLUxxx: { price, available_quantity } }
export function planLightning(ids, { promotions = {}, itemInfo = {}, maxPct = DEFAULT_MAX_PCT } = {}) {
  const plan = { joins: [], skipped: [] };
  const skip = (item_id, reason, extra = {}) => plan.skipped.push({ item_id, reason, ...extra });
  for (const id of ids) {
    const info = itemInfo[id], list = promotions[id];
    if (!info || !Array.isArray(list)) { skip(id, 'sin_datos'); continue; }
    const lightning = list.filter(p => p?.type === 'LIGHTNING' || p?.promotion_type === 'LIGHTNING');
    const candidate = lightning.find(p => p.status === 'candidate');
    if (!candidate) { skip(id, lightning.some(p => ACTIVE.has(p.status)) ? 'ya_esta_en_la_oferta' : 'sin_oferta_relampago_disponible'); continue; }
    if (isLiquidacion(candidate.promotion_name ?? candidate.name)) { skip(id, 'liquidacion_no_se_toca'); continue; }
    const original = num(candidate.original_price), highest = num(candidate.max_discounted_price), lowest = num(candidate.min_discounted_price);
    const requiredMin = (original && highest !== null) ? round2((1 - highest / original) * 100) : num(candidate.min_discount_percentage);
    if (requiredMin === null || !original || highest === null) { skip(id, 'ml_no_informa_el_minimo'); continue; }
    if (requiredMin > maxPct) { skip(id, 'ml_exige_mas_descuento_que_el_maximo', { required_min_pct: requiredMin }); continue; }
    // El precio más alto que ML acepta es el que menos descuento da; se baja a entero.
    const dealPrice = Math.floor(highest);
    const discount = round2((1 - dealPrice / original) * 100);
    const current = num(info.price), available = num(info.available_quantity);
    if (current === null || dealPrice > current) { skip(id, 'subiria_el_precio', { deal_price: dealPrice, current_price: current }); continue; }
    if (lowest !== null && dealPrice < lowest) { skip(id, 'precio_fuera_del_rango_de_ml'); continue; }
    if (discount > maxPct) { skip(id, 'supera_el_maximo_por_redondeo', { discount_pct: discount }); continue; }
    const stock = Math.max(1, Math.ceil(num(candidate.min_stock) ?? 1));
    if (available === null || stock > available || (num(candidate.max_stock) !== null && stock > num(candidate.max_stock))) { skip(id, 'stock_insuficiente', { stock_requerido: stock, available_quantity: available }); continue; }
    plan.joins.push({ item_id: id, promotion_id: candidate.promotion_id ?? candidate.id, promotion_type: 'LIGHTNING', deal_price: dealPrice, current_price: current, stock, available_quantity: available, discount_pct: discount, required_min_pct: requiredMin });
  }
  return plan;
}
