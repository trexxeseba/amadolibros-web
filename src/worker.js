
async function getValidToken(env) {
    const APP_ID = env.APP_ID || env.CLIENT_ID || env.MELI_APP_ID;
    const CLIENT_SECRET = env.CLIENT_SECRET || env.MELI_SECRET || env.SECRET;
    const REFRESH_TOKEN = env.MELI_REFRESH_TOKEN || env.REFRESH_TOKEN;

    if (!APP_ID) return { error: "Configuration missing", missing_var: "APP_ID" };
    if (!CLIENT_SECRET) return { error: "Configuration missing", missing_var: "CLIENT_SECRET" };
    if (!REFRESH_TOKEN) return { error: "Configuration missing", missing_var: "REFRESH_TOKEN" };

    let accessToken = await env.AMADO_KV.get('meli_access_token');
    if (accessToken) return { token: accessToken };

    const tokenUrl = `https://api.mercadolibre.com/oauth/token?grant_type=refresh_token&client_id=${APP_ID}&client_secret=${CLIENT_SECRET}&refresh_token=${REFRESH_TOKEN}`;
    try {
        const response = await fetch(tokenUrl, { method: 'POST', headers: { 'Accept': 'application/json' } });
        const data = await response.json();
        if (data.access_token) {
            await env.AMADO_KV.put('meli_access_token', data.access_token, { expirationTtl: data.expires_in - 300 });
            await env.AMADO_KV.put('meli_refresh_token', data.refresh_token);
            return { token: data.access_token };
        } else {
            return { error: "Token refresh failed", details: data };
        }
    } catch (e) {
        return { error: "Token fetch exception", details: e.message };
    }
}

async function fetchFromMeli(url, token) {
    const response = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (response.status === 429) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Simple backoff
        return fetchFromMeli(url, token); // Retry
    }
    if (!response.ok) throw new Error(`API Error: ${response.status}`);
    return response.json();
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const SELLER_ID = env.SELLER_ID || env.USER_ID;

        if (url.pathname === '/') {
            const asset = await env.ASSETS.fetch(request);
            let html = await asset.text();
            const itemId = url.searchParams.get('id');
            if (itemId) {
                const tokenResult = await getValidToken(env);
                if (tokenResult.token) {
                    const itemData = await fetchFromMeli(`https://api.mercadolibre.com/items/${itemId}`, tokenResult.token);
                    if (itemData) {
                        html = html.replace('</head>', `<meta property="og:title" content="${itemData.title}"><meta property="og:image" content="${itemData.thumbnail}"></head>`);
                    }
                }
            }
            return new Response(html, { headers: { 'Content-Type': 'text/html' } });
        }

        if (url.pathname === '/api/home') {
            const homeCatalog = await env.AMADO_KV.get('HOME_CATALOG');
            return new Response(homeCatalog || '[]', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=600' } });
        }

        if (url.pathname === '/api/search') {
            const tokenResult = await getValidToken(env);
            if (tokenResult.error) return new Response(JSON.stringify(tokenResult), { status: 500 });

            const query = url.searchParams.get('q');
            if (!query) return new Response(JSON.stringify({ error: 'Query param missing' }), { status: 400 });

            const searchUrl = `https://api.mercadolibre.com/users/${SELLER_ID}/items/search?q=${query}`;
            const searchData = await fetchFromMeli(searchUrl, tokenResult.token);
            const itemIds = searchData.results.slice(0, 20).join(',');
            const itemsData = await fetchFromMeli(`https://api.mercadolibre.com/items?ids=${itemIds}`, tokenResult.token);
            
            const finalJson = itemsData.map(item => ({ id: item.id, title: item.title, price: item.price, thumbnail: item.thumbnail, permalink: item.permalink }));
            return new Response(JSON.stringify(finalJson), { headers: { 'Content-Type': 'application/json' } });
        }

        return env.ASSETS.fetch(request);
    },

    async scheduled(event, env, ctx) {
        const tokenResult = await getValidToken(env);
        if (tokenResult.error) {
            console.error("Scheduled task failed:", tokenResult.error, tokenResult.details || '');
            return;
        }

        const SELLER_ID = env.SELLER_ID || env.USER_ID;
        let allItems = [];
        let offset = 0;
        while (true) {
            const data = await fetchFromMeli(`https://api.mercadolibre.com/users/${SELLER_ID}/items/search?offset=${offset}`, tokenResult.token);
            if (!data.results || data.results.length === 0) break;
            allItems.push(...data.results);
            offset += 50;
        }

        await env.AMADO_KV.put('full_catalog', JSON.stringify(allItems));
        console.log(`Catalog synced: ${allItems.length} items.`);
    }
};
