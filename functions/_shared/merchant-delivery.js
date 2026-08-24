// functions/_shared/merchant-delivery.js
//
// MERCHANT-LOCAL-DELIVERY-1 — expone en el feed de Merchant Center la
// capacidad de entrega que hoy es invisible para Google: entrega en el día
// en Montevideo.
//
// Por qué importa: Amado Libros es una tienda en línea que entrega en el
// mismo día en Montevideo. Ningún competidor grande del vertical
// (marketplaces cross-border, tiendas regionales) puede igualar eso. Hasta
// ahora el feed no emitía NINGÚN atributo de envío, así que Google no tenía
// forma de saberlo y no podía mostrarlo en Shopping.
//
// Fuente única de verdad de los importes: functions/api/_orders_logic.js —
// los mismos valores que cobra el checkout real. Nunca se declara acá un
// precio de envío distinto del que el comprador va a pagar; un feed que
// promete un envío más barato que el checkout es causa de desaprobación en
// Merchant y, antes que eso, de una mala experiencia real.

import { FREE_SHIPPING_THRESHOLD, SHIPPING_COST } from '../api/_orders_logic.js';

export const SHIPPING_COUNTRY = 'UY';

// La entrega en el día está confirmada para Montevideo. Para el resto del
// país NO tenemos un plazo verificado, así que la entrada nacional se emite
// sin tiempos de tránsito: declarar un plazo que no podemos garantizar es
// peor que no declarar ninguno.
export const MONTEVIDEO_REGION = 'Montevideo';
export const MONTEVIDEO_SERVICE = 'Entrega en el día';

/**
 * Costo de envío que corresponde a ESTE ítem comprado solo.
 *
 * El umbral de envío gratis es por total de carrito, pero `g:shipping` es
 * por producto: Google espera el costo aplicable a ese ítem. Se usa el
 * mismo criterio por-ítem que ya muestra la ficha pública
 * (`hasFreeShipping` en functions/libro/[[path]].js), para que feed, ficha
 * y checkout digan exactamente lo mismo.
 *
 * @param {number} priceUyu precio del ítem en UYU
 * @returns {number} costo de envío en UYU (0 si califica para envío gratis)
 */
export function itemShippingCostUyu(priceUyu) {
    const price = Number(priceUyu);
    if (!Number.isFinite(price) || price < 0) return SHIPPING_COST;
    return price >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_COST;
}

function shippingBlock({ region, service, priceUyu, sameDay }) {
    const timing = sameDay
        ? `
            <g:min_handling_time>0</g:min_handling_time>
            <g:max_handling_time>0</g:max_handling_time>
            <g:min_transit_time>0</g:min_transit_time>
            <g:max_transit_time>0</g:max_transit_time>`
        : '';
    return `
        <g:shipping>
            <g:country>${SHIPPING_COUNTRY}</g:country>${region ? `
            <g:region>${region}</g:region>` : ''}${service ? `
            <g:service>${service}</g:service>` : ''}
            <g:price>${priceUyu} UYU</g:price>${timing}
        </g:shipping>`;
}

/**
 * Devuelve los bloques `<g:shipping>` para un ítem.
 *
 * Emite dos entradas:
 *  1. Montevideo, entrega en el día (handling 0, tránsito 0) — el
 *     diferencial real del negocio.
 *  2. Nacional, mismo precio, SIN tiempos declarados — porque no tenemos un
 *     plazo verificado para el interior.
 *
 * Idempotente y puro: depende sólo del precio del ítem.
 *
 * @param {{price?: number|string}} item
 */
export function shippingTags(item) {
    const priceUyu = itemShippingCostUyu(item?.price);
    return [
        shippingBlock({
            region: MONTEVIDEO_REGION,
            service: MONTEVIDEO_SERVICE,
            priceUyu,
            sameDay: true,
        }),
        shippingBlock({ region: '', service: '', priceUyu, sameDay: false }),
    ].join('');
}
