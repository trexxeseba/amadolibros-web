/**
 * functions/libro/[id].js
 *
 * /libro/:id → 301 a la URL canónica /libro/:id/:slug
 */

const CATALOG_URL = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json';
const BASE        = 'https://www.amadolibros.com';

function slugify(text) {
    return (text || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 60);
}

async function fetchCatalog(context) {
    const cache    = caches.default;
    const cacheKey = new Request(CATALOG_URL);

    let resp = await cache.match(cacheKey);
    if (!resp) {
        const fetched = await fetch(CATALOG_URL);
        if (!fetched.ok) return null;
        resp = new Response(fetched.body, {
            status: fetched.status,
            headers: {
                'Content-Type':  'application/json',
                'Cache-Control': 'public, max-age=3600',
            },
        });
        context.waitUntil(cache.put(cacheKey, resp.clone()));
    }
    try {
        return await resp.json();
    } catch {
        return null;
    }
}

function notFound() {
    return new Response('Not found', {
        status: 404,
        headers: {
            'content-type': 'text/plain;charset=UTF-8',
            'x-robots-tag': 'noindex, nofollow',
        },
    });
}

export async function onRequest(context) {
    const id = String(context.params.id || '').toUpperCase();
    if (!id || !/^MLU\d+$/.test(id)) return notFound();

    const catalog = await fetchCatalog(context);
    if (!catalog || !Array.isArray(catalog.items)) return notFound();

    const item = catalog.items.find(b => b.id === id);
    if (!item) return notFound();

    return Response.redirect(`${BASE}/libro/${id}/${slugify(item.title)}`, 301);
}
