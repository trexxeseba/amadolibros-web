/**
 * Tope único de descuentos de la tienda y precio de liquidación.
 *
 * MAX_TOTAL_DISCOUNT es la única constante del tope: ninguna combinación de
 * promos (liquidación, promo web, transferencia) puede pasar el 25 % sobre el
 * precio habitual. El tope rige desde LIQUIDACION_PRECIO.startsAt; antes de
 * esa fecha todo se calcula exactamente como antes (Amado Week + 12 %).
 *
 * Lo usan: la lectura del catálogo (precio de liquidación, igual para ficha,
 * listados, feed, carrito y cobro), las tarjetas (línea de transferencia) y
 * el cobro por transferencia (_orders_logic.js).
 *
 * Corte inmediato sin deploy: LIQUIDACION_PRECIO_OFF=1 en Cloudflare Pages
 * apaga el precio de liquidación (el tope sigue rigiendo).
 */

export const MAX_TOTAL_DISCOUNT = 0.25;

/** Piso del sistema de precio ganador: un descuento que deja el libro debajo no se aplica. */
export const PRICE_FLOOR_UYU = 1200;

/** Descuento por transferencia sobre los libros (mismo valor que TRANSFER_FACTOR en _orders_logic.js). */
export const TRANSFER_DISCOUNT = 0.12;

export const LIQUIDACION_PRECIO = Object.freeze({
    name: 'Liquidación',
    // Descuento BASE (Seba, 5/11/2026: 10 %). La Rueda y el Acertijo lo suben después hasta
    // MAX_TOTAL_DISCOUNT; el tope de 25 % sigue siendo el techo de todo el sistema.
    discount: 0.10,
    // Martes 10/11/2026 00:00, hora de Montevideo (UTC-3, sin horario de verano).
    startsAt: '2026-11-10T00:00:00-03:00',
});

function ms(now) {
    return now instanceof Date ? now.getTime() : Number(now);
}

/** ¿Rige ya la regla nueva (tope + precio de liquidación)? */
export function discountRulesActive(now = new Date()) {
    const t = ms(now);
    const start = Date.parse(LIQUIDACION_PRECIO.startsAt);
    return Number.isFinite(t) && t >= start;
}

export function liquidationPricingActive(now = new Date(), env = {}) {
    if (String(env?.LIQUIDACION_PRECIO_OFF || '') === '1') return false;
    return discountRulesActive(now);
}

/** Precio mínimo que permite el tope para un precio habitual (redondeado hacia arriba). */
export function capFloorPrice(habitual) {
    return Math.ceil(Number(habitual) * (1 - MAX_TOTAL_DISCOUNT));
}

/**
 * Precio de liquidación de un libro. Devuelve { price, applied, reason }:
 * reason = 'ok' | 'bajo_piso' | 'precio_invalido'.
 * El descuento nunca supera el tope (25 % = MAX_TOTAL_DISCOUNT).
 */
export function liquidationPrice(habitual) {
    const h = Number(habitual);
    if (!Number.isFinite(h) || h <= 0) return { price: habitual, applied: false, reason: 'precio_invalido' };
    const pct = Math.min(LIQUIDACION_PRECIO.discount, MAX_TOTAL_DISCOUNT);
    const price = Math.max(capFloorPrice(h), Math.round(h * (1 - pct)));
    if (price < PRICE_FLOOR_UYU) return { price: h, applied: false, reason: 'bajo_piso' };
    return { price, applied: true, reason: 'ok' };
}

/**
 * Descuento por transferencia, en pesos por unidad, respetando el tope:
 * el 12 % se suma solo mientras el total sobre el habitual no pase el 25 %.
 * Antes de la fecha de la regla nueva devuelve el 12 % de siempre.
 */
export function transferUnitDiscount(price, habitual, now = new Date()) {
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) return 0;
    const full = p * TRANSFER_DISCOUNT;
    if (!discountRulesActive(now)) return full;
    const h = Number(habitual) > p ? Number(habitual) : p;
    const room = Math.max(0, p - capFloorPrice(h));
    return Math.min(full, room);
}

/**
 * Precio por transferencia para mostrar en una tarjeta o ficha, o null si la
 * transferencia no baja nada (libro ya en el tope, por ejemplo liquidación).
 */
export function transferDisplayPrice(item, now = new Date()) {
    const price = Number(item?.price);
    if (!Number.isFinite(price) || price <= 0) return null;
    const discount = transferUnitDiscount(price, item?.original_price, now);
    const transfer = Math.round(price - discount);
    return transfer < price ? transfer : null;
}

/**
 * Total de libros pagando por transferencia, con el tope por línea.
 * lines: [{ line_total_uyu, quantity, unit_price_uyu, habitual_unit_uyu? }].
 * Sin descuentos previos da exactamente round(total * 0.88), igual que antes.
 */
export function transferProductsTotal(lines, now = new Date()) {
    let total = 0;
    let discount = 0;
    for (const line of Array.isArray(lines) ? lines : []) {
        const qty = Number(line?.quantity) || 0;
        const unit = Number(line?.unit_price_uyu) || 0;
        const lineTotal = Number(line?.line_total_uyu) || unit * qty;
        total += lineTotal;
        if (!discountRulesActive(now)) continue;
        discount += transferUnitDiscount(unit, line?.habitual_unit_uyu, now) * qty;
    }
    if (!discountRulesActive(now)) return Math.round(total * (1 - TRANSFER_DISCOUNT));
    return total - Math.round(discount);
}
