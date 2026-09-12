import { CATALOG_URL, fetchCatalog } from './catalog.js';

// Clave sólo de Cache API: nunca se solicita esta URL al origen.
export const CATEGORY_DATES_CACHE_URL = `${CATALOG_URL}?view=category-start-times-v1`;

export async function fetchCategoryDates(ctx) {
    const cache = caches.default;
    const key = new Request(CATEGORY_DATES_CACHE_URL);
    try {
        const cached = await cache.match(key);
        if (cached) {
            const dates = await cached.json();
            if (dates && typeof dates === 'object' && !Array.isArray(dates)) {
                return new Map(Object.entries(dates));
            }
        }
    } catch { /* Un fallo de caché no impide consultar el catálogo. */ }

    const catalog = await fetchCatalog(ctx).catch(() => null);
    if (!Array.isArray(catalog?.items)) return new Map();
    const dates = Object.fromEntries(catalog.items
        .filter(item => /^MLU\d+$/.test(item.id) && Number.isFinite(Date.parse(item.start_time || '')))
        .map(item => [item.id, item.start_time]));
    if (Object.keys(dates).length && typeof ctx?.waitUntil === 'function') {
        // Se parsea la proyección pequeña en cada hit, no los 12,7 MB del catálogo.
        ctx.waitUntil(cache.put(key, Response.json(dates, {
            headers: { 'Cache-Control': 'public, max-age=60' },
        })).catch(() => {}));
    }
    return new Map(Object.entries(dates));
}
