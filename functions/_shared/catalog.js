export const CATALOG_URL = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json';
export const PREVIEW_CATALOG_URL = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog-stock1-preview.json';
export const BASE        = 'https://www.amadolibros.com';

export function catalogUrlFor(ctx) {
    return ctx?.env?.APP_ENV === 'preview' ? PREVIEW_CATALOG_URL : CATALOG_URL;
}

export async function fetchCatalog(ctx) {
    const catalogUrl = catalogUrlFor(ctx);
    const cache    = caches.default;
    const cacheKey = new Request(catalogUrl);

    let resp = await cache.match(cacheKey);
    if (!resp) {
        const fetched = await fetch(catalogUrl);
        if (!fetched.ok) return null;
        resp = new Response(fetched.body, {
            status:  fetched.status,
            headers: {
                'Content-Type':  'application/json',
                'Cache-Control': 'public, max-age=3600',
            },
        });
        ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    }
    try {
        return await resp.json();
    } catch {
        return null;
    }
}
