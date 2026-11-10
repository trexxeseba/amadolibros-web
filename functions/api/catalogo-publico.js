import { BASE, fetchCheckoutCatalog, fetchPausedIndex } from '../_shared/catalog.js';
import { slugify } from '../_shared/slug.js';
import { promoAwareCacheControl } from '../_shared/web-promo.js';

// Public catalog only. Use the same versioned stock/prices as checkout and
// explicitly map fields so future internal catalog fields cannot leak here.
export function publicCatalogItem(item, availability) {
    if (!item || !/^MLU\d+$/.test(String(item.id)) || !String(item.title || '').trim()) return null;
    const available = availability === 'in_stock';
    const price = Number(item.price);
    const stock = Number(item.available_quantity);
    if (available && (!Number.isFinite(price) || price <= 0 || !Number.isInteger(stock) || stock <= 0)) return null;
    return {
        id: String(item.id),
        title: String(item.title).trim(),
        author: item.author ? String(item.author).trim() : null,
        isbn: item.isbn ? String(item.isbn).trim() : null,
        price: available ? price : null,
        currency: 'UYU',
        stock: available ? stock : 0,
        availability,
        url: `${BASE}/libro/${item.id}/${slugify(item.title)}`,
    };
}

export function createPublicCatalogHandler({ loadActive = fetchCheckoutCatalog, loadPaused = fetchPausedIndex } = {}) {
    return async context => {
        const headers = {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Robots-Tag': 'noindex, nofollow',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'X-Content-Type-Options': 'nosniff',
        };
        const method = context.request.method;
        if (method === 'OPTIONS') return new Response(null, { status: 204, headers });
        if (!['GET', 'HEAD'].includes(method)) {
            return Response.json({ error: 'METHOD_NOT_ALLOWED' }, {
                status: 405, headers: { ...headers, Allow: 'GET, HEAD, OPTIONS', 'Cache-Control': 'no-store' },
            });
        }
        try {
            const [active, paused] = await Promise.all([loadActive(context), loadPaused(context)]);
            // Never return a partial success: a failed source must not cause
            // partners to remove valid offers as if they had disappeared.
            if (!Array.isArray(active?.items) || !Array.isArray(paused?.items) ||
                !active.version || active.version !== paused.version) throw new Error('catalog unavailable');
            const seen = new Set();
            const items = [];
            let inStock = 0;
            let onRequest = 0;
            for (const [source, availability] of [[active.items, 'in_stock'], [paused.items, 'on_request']]) {
                for (const candidate of source) {
                    const item = publicCatalogItem(candidate, availability);
                    if (!item || seen.has(item.id)) continue;
                    seen.add(item.id);
                    items.push(item);
                    if (availability === 'in_stock') inStock++; else onRequest++;
                }
            }
            const data = {
                schema_version: 1,
                catalog_version: active.version,
                seller: 'Amado Libros',
                website: BASE,
                complete: true,
                total: items.length,
                counts: { in_stock: inStock, on_request: onRequest },
                items,
            };
            return new Response(method === 'HEAD' ? null : JSON.stringify(data), {
                headers: { ...headers, 'Cache-Control': promoAwareCacheControl(60, new Date(), context.env),
                    'X-Amado-Catalog-Version': String(active.version) },
            });
        } catch {
            return new Response(method === 'HEAD' ? null : JSON.stringify({ error: 'CATALOG_UNAVAILABLE', retry: true }), {
                status: 503, headers: { ...headers, 'Cache-Control': 'no-store', 'Retry-After': '60' },
            });
        }
    };
}

export const onRequest = createPublicCatalogHandler();
