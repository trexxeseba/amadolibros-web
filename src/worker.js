const APP_ID = env.APP_ID || env.CLIENT_ID || env.MELI_APP_ID;
const CLIENT_SECRET = env.CLIENT_SECRET || env.MELI_SECRET || env.SECRET;
const REFRESH_TOKEN = env.MELI_REFRESH_TOKEN || env.REFRESH_TOKEN;
const SELLER_ID = env.SELLER_ID || env.USER_ID;

async function getAccessToken(env) {
  const tokenUrl = `https://api.mercadolibre.com/oauth/token?grant_type=refresh_token&client_id=${APP_ID}&client_secret=${CLIENT_SECRET}&refresh_token=${REFRESH_TOKEN}`;
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  const data = await response.json();
  if (data.access_token) {
    await env.AMADO_KV.put('meli_access_token', data.access_token, { expirationTtl: data.expires_in - 60 }); // Expire 60 seconds before actual expiry
    await env.AMADO_KV.put('meli_refresh_token', data.refresh_token);
    return data.access_token;
  } else {
    throw new Error('Failed to get access token: ' + JSON.stringify(data));
  }
}

async function getMeliAccessToken(env) {
  let accessToken = await env.AMADO_KV.get('meli_access_token');
  if (!accessToken) {
    accessToken = await getAccessToken(env);
  }
  return accessToken;
}

async function fetchMeliItems(accessToken, sellerId, offset = 0, limit = 50, query = null) {
  let url = `https://api.mercadolibre.com/users/${sellerId}/items/search?offset=${offset}&limit=${limit}`;
  if (query) {
    url += `&q=${encodeURIComponent(query)}`;
  }
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
  });
  if (response.status === 429) {
    throw new Error('Rate limit exceeded');
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch items: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchItemDetails(accessToken, itemIds) {
  const url = `https://api.mercadolibre.com/items?ids=${itemIds.join(',')}`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
  });
  if (response.status === 429) {
    throw new Error('Rate limit exceeded');
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch item details: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function getAllMeliItems(env) {
  const accessToken = await getMeliAccessToken(env);
  let allItems = [];
  let offset = 0;
  const limit = 50; // Max items per page
  let total = 0;
  let retries = 0;
  const maxRetries = 5;
  const initialBackoff = 1000; // 1 second

  do {
    try {
      const data = await fetchMeliItems(accessToken, SELLER_ID, offset, limit);
      if (data.results) {
        allItems = allItems.concat(data.results);
        total = data.paging.total;
        offset += data.results.length;
      } else {
        break; // No more results
      }
      retries = 0; // Reset retries on success
    } catch (error) {
      if (error.message === 'Rate limit exceeded' && retries < maxRetries) {
        retries++;
        const backoffTime = initialBackoff * Math.pow(2, retries - 1);
        console.warn(`Rate limit hit. Retrying in ${backoffTime}ms... (Attempt ${retries}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, backoffTime));
      } else {
        console.error('Error fetching Mercado Libre items:', error);
        break; // Exit on other errors or max retries
      }
    }
  } while (offset < total);

  // Fetch item details in batches
  const detailedItems = [];
  const batchSize = 20; // Max items per detail request
  for (let i = 0; i < allItems.length; i += batchSize) {
    const batchIds = allItems.slice(i, i + batchSize).map(item => item.id);
    try {
      const details = await fetchItemDetails(accessToken, batchIds);
      detailedItems.push(...details);
    } catch (error) {
      console.error('Error fetching item details batch:', error);
      // Implement retry logic for detail fetching if necessary
    }
  }

  return detailedItems.map(item => ({
    id: item.id,
    title: item.title,
    price: item.price,
    thumbnail: item.thumbnail,
    permalink: item.permalink,
  }));
}

async function searchMeliItems(env, query) {
  const accessToken = await getMeliAccessToken(env);
  let searchResults = [];
  let offset = 0;
  const limit = 50;
  let total = 0;
  let retries = 0;
  const maxRetries = 5;
  const initialBackoff = 1000;

  do {
    try {
      const data = await fetchMeliItems(accessToken, SELLER_ID, offset, limit, query);
      if (data.results) {
        searchResults = searchResults.concat(data.results);
        total = data.paging.total;
        offset += data.results.length;
      } else {
        break;
      }
      retries = 0;
    } catch (error) {
      if (error.message === 'Rate limit exceeded' && retries < maxRetries) {
        retries++;
        const backoffTime = initialBackoff * Math.pow(2, retries - 1);
        console.warn(`Rate limit hit during search. Retrying in ${backoffTime}ms... (Attempt ${retries}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, backoffTime));
      } else {
        console.error('Error searching Mercado Libre items:', error);
        break;
      }
    }
  } while (offset < total);

  const detailedItems = [];
  const batchSize = 20;
  for (let i = 0; i < searchResults.length; i += batchSize) {
    const batchIds = searchResults.slice(i, i + batchSize).map(item => item.id);
    try {
      const details = await fetchItemDetails(accessToken, batchIds);
      detailedItems.push(...details);
    } catch (error) {
      console.error('Error fetching search item details batch:', error);
    }
  }

  return detailedItems.map(item => ({
    id: item.id,
    title: item.title,
    price: item.price,
    thumbnail: item.thumbnail,
    permalink: item.permalink,
  }));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/') {
      let html = await env.ASSETS.fetch(request).then(response => response.text());

      const itemId = url.searchParams.get('id');
      if (itemId) {
        const allItems = await env.AMADO_KV.get('full_catalog', { type: 'json' });
        const book = allItems ? allItems.find(item => item.id === itemId) : null;

        if (book) {
          const bookTitle = book.title;
          const bookImage = book.thumbnail;

          html = html.replace(
            '</head>',
            `  <meta property="og:title" content="${bookTitle}">
  <meta property="og:image" content="${bookImage}">
</head>`
          );
        }
      }
      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    }

    if (url.pathname === '/api/home') {
      const homeCatalog = await env.AMADO_KV.get('HOME_CATALOG', { type: 'json' });
      return new Response(JSON.stringify(homeCatalog || []), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=600',
          'Access-Control-Allow-Origin': '*'
        },
      });
    }

    if (url.pathname === '/api/search') {
      const query = url.searchParams.get('q');
      if (!query) {
        return new Response(JSON.stringify({ error: 'Missing query parameter' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      try {
        const searchResults = await searchMeliItems(env, query);
        return new Response(JSON.stringify(searchResults), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          },
        });
      } catch (error) {
        console.error('Error in /api/search:', error);
        return new Response(JSON.stringify({ error: 'Failed to perform search', details: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    console.log('Cron Trigger activado: Sincronizando catálogo desde Mercado Libre...');
    try {
      const allItems = await getAllMeliItems(env);
      await env.AMADO_KV.put('full_catalog', JSON.stringify(allItems));
      console.log(`Catálogo sincronizado exitosamente. Total de ítems: ${allItems.length}`);
    } catch (error) {
      console.error('Error durante la sincronización del catálogo:', error);
    }
  },
};
