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
        // Idempotente: un item que ya trae `original_price` ya fue rebajado.
        if (Number(item.original_price) > 0) return item;
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

// Estado público de la promo (lo consume la home estática, que se arma en el
// build y no puede conocer la ventana vigente).
export function webPromoState(now = new Date(), env = {}, promo = WEB_PROMO) {
    return {
        active: webPromoActive(now, env, promo),
        percent: promo.percent,
        starts_at: promo.startsAt,
        ends_at: promo.endsAt,
    };
}

// Línea "habitual / promocional" que se muestra bajo el precio vigente en todas
// las tarjetas y en la ficha. Vacía si el item no está en promoción.
export function promoWasHtml(item, promo = WEB_PROMO) {
    const original = Number(item?.original_price);
    const price = Number(item?.price);
    if (!(original > 0) || !(price > 0) || original <= price) return '';
    const habitual = original.toLocaleString('es-UY');
    return `<span class="promo-was" style="display:block;font-size:.82rem;font-weight:700;color:#9a3412;margin-top:.1rem">${promo.percent}% menos por tiempo limitado. Precio habitual: <s>$${habitual} UYU</s></span>`;
}

// Segundos hasta el próximo cambio de precio (inicio de la promo o instante
// posterior a su fin). null si no queda ningún cambio por delante.
export function secondsToNextPromoBoundary(now = new Date(), promo = WEB_PROMO) {
    const t = now instanceof Date ? now.getTime() : Number(now);
    const start = Date.parse(promo.startsAt);
    const afterEnd = Date.parse(promo.endsAt) + 1000;
    if (![t, start, afterEnd].every(Number.isFinite)) return null;
    const next = [start, afterEnd].filter(boundary => boundary > t).sort((a, b) => a - b)[0];
    return next === undefined ? null : Math.max(1, Math.ceil((next - t) / 1000));
}

// Cache-Control para páginas con precio: el TTL normal, recortado para que la
// copia de borde venza justo cuando cambia el precio (inicio o fin de la promo).
export function promoAwareCacheControl(ttlSeconds, now = new Date(), env = {}, promo = WEB_PROMO) {
    let ttl = ttlSeconds;
    if (String(env?.WEB_PROMO_OFF || '') !== '1') {
        const boundary = secondsToNextPromoBoundary(now, promo);
        if (boundary !== null) ttl = Math.min(ttl, boundary);
    }
    return `public, max-age=${ttl}`;
}

// Cloudflare sube el TTL de navegador a 4 h sin importar lo que envíe el
// origen, así que una ficha abierta antes del fin podría seguir mostrando el
// precio promocional. Este guard, inyectado solo en páginas generadas durante la
// promo, recarga una vez (con otra URL de caché) cuando la ventana ya terminó.
export function promoEndGuardScript(promo = WEB_PROMO) {
    const end = Date.parse(promo.endsAt);
    return `<script>(function(){try{if(!document.querySelector('.promo-was'))return;if(Date.now()<=${end})return;var k='amado-promo-end';if(sessionStorage.getItem(k))return;sessionStorage.setItem(k,'1');var u=new URL(location.href);u.searchParams.set('_p','${end}');location.replace(u.toString());}catch(e){}})();</script>`;
}
