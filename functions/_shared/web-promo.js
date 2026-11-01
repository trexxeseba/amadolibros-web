// Promo temporal de la web: descuento porcentual sobre el precio publicado.
//
// Se aplica una sola vez, al leer el catálogo (fetchCatalog / fetchActiveIndex /
// fetchCheckoutCatalog). Ficha, listados, feed de Merchant, carrito, validación
// de carrito y creación de pedidos leen el mismo precio, así que no hay forma
// de que el cliente vea un monto y el servidor cobre otro.
//
// Fuera de la ventana de fechas no hace nada. Para una promo nueva se cambian
// las constantes de abajo. Corte inmediato sin esperar al fin de ventana:
// variable WEB_PROMO_OFF=1 en el entorno de Cloudflare Pages.

export const WEB_PROMO = Object.freeze({
    percent: 15,
    // Domingo 1/11/2026 00:00 a lunes 2/11/2026 23:59:59, hora de Montevideo.
    startsAt: '2026-11-01T00:00:00-03:00',
    endsAt: '2026-11-02T23:59:59-03:00',
});

export function webPromoActive(now = new Date(), env = {}, promo = WEB_PROMO) {
    if (String(env?.WEB_PROMO_OFF || '') === '1') return false;
    const pct = Number(promo?.percent);
    if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) return false;
    const start = Date.parse(promo.startsAt);
    const end = Date.parse(promo.endsAt);
    const t = now instanceof Date ? now.getTime() : Number(now);
    if (![start, end, t].every(Number.isFinite)) return false;
    return t >= start && t <= end;
}

export function applyPromoToPrice(price, promo = WEB_PROMO) {
    const value = Number(price);
    if (!Number.isFinite(value) || value <= 0) return price;
    return Math.max(1, Math.round(value * (1 - promo.percent / 100)));
}

// Devuelve una copia de los items con el precio ya rebajado y el original en
// `original_price`. Items sin precio válido (y pausadas) quedan intactos.
export function applyWebPromoToItems(items, { now = new Date(), env = {}, promo = WEB_PROMO } = {}) {
    if (!Array.isArray(items) || !webPromoActive(now, env, promo)) return items;
    return items.map(item => {
        if (!item || typeof item !== 'object') return item;
        if (item.status && item.status !== 'active') return item;
        const price = Number(item.price);
        if (!Number.isFinite(price) || price <= 0) return item;
        return { ...item, price: applyPromoToPrice(price, promo), original_price: price };
    });
}

// Para respuestas con forma { items: [...] } (catalog.json y el índice activo).
export function applyWebPromoToCatalog(catalog, options = {}) {
    if (!catalog || !Array.isArray(catalog.items)) return catalog;
    const items = applyWebPromoToItems(catalog.items, options);
    return items === catalog.items ? catalog : { ...catalog, items };
}
