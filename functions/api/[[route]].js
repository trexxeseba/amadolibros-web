export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;
  
  // Detectar qué ruta es
  if (pathname.includes('/api/home')) {
    return handleHome(context);
  } else if (pathname.includes('/api/search')) {
    return handleSearch(context);
  } else if (pathname.includes('/api/sync-all-books')) {
    return handleSync(context);
  } else {
    return new Response('Not found', { status: 404 });
  }
}

// RUTA 1: /api/home
async function handleHome(context) {
  const { env } = context;
  
  try {
    // Leer del KV
    const cached = await env.AMADO_KV.get('books:active', 'json');
    
    if (!cached) {
      return new Response(JSON.stringify([]), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify(cached), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600'
      }
    });
    
  } catch (e) {
    console.error('Error en /api/home:', e);
    return new Response(JSON.stringify([]), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// RUTA 2: /api/search
async function handleSearch(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const query = url.searchParams.get('q') || '';
  
  if (!query) {
    return new Response(JSON.stringify([]), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  try {
    const cached = await env.AMADO_KV.get('books:all', 'json');
    
    if (!cached || !cached.books) {
      return new Response(JSON.stringify([]), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const queryLower = query.toLowerCase();
    const results = cached.books.filter(book =>
      book.title.toLowerCase().includes(queryLower)
    );
    
    return new Response(JSON.stringify(results.slice(0, 50)), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=600'
      }
    });
    
  } catch (e) {
    console.error('Error en /api/search:', e);
    return new Response(JSON.stringify([]), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// RUTA 3: /api/sync-all-books
async function handleSync(context) {
  const { request, env } = context;
  
  // DEFENSA: Solo admin
  const authHeader = request.headers.get('Authorization') || '';
  if (authHeader !== `Bearer ${env.ADMIN_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  
  // DEFENSA: Max 1 sync por hora
  const lastSync = await env.AMADO_KV.get('sync:timestamp');
  if (lastSync && Date.now() - parseInt(lastSync) < 3600000) {
    return new Response(JSON.stringify({ 
      error: 'Sync ejecutado hace poco. Espera 1 hora.' 
    }), { status: 429 });
  }
  
  try {
    const USER_ID = env.USER_ID || '440298103';
    const token = await getAccessToken(env);
    
    let allBooks = [];
    let offset = 0;
    const limit = 100;
    let maxPages = 150;
    
    while (offset < maxPages * 100) {
      const url = `https://api.mercadolibre.com/users/${USER_ID}/items/search?offset=${offset}&limit=${limit}`;
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (!res.ok) throw new Error(`ML API error: ${res.status}`);
      
      const data = await res.json();
      if (!data.results || data.results.length === 0) break;
      
      allBooks = allBooks.concat(data.results);
      offset += limit;
      
      await new Promise(r => setTimeout(r, 200));
    }
    
    const books = [];
    for (let i = 0; i < allBooks.length; i += 20) {
      const batch = allBooks.slice(i, i + 20);
      const ids = batch.join(',');
      
      const itemsRes = await fetch(`https://api.mercadolibre.com/items?ids=${ids}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (!itemsRes.ok) throw new Error(`ML items error: ${itemsRes.status}`);
      
      const itemsData = await itemsRes.json();
      itemsData.forEach(item => {
        if (item.body && item.body.status === 'active') {
          books.push({
            id: item.body.id,
            title: item.body.title,
            price: item.body.price,
            thumbnail: item.body.thumbnail,
            permalink: item.body.permalink,
            status: item.body.status,
            stock: item.body.available_quantity
          });
        }
      });
      
      await new Promise(r => setTimeout(r, 200));
    }
    
    await env.AMADO_KV.put('books:all', JSON.stringify({
      books,
      active: books.filter(b => b.stock > 0),
      timestamp: Date.now()
    }), { expirationTtl: 86400 });
    
    await env.AMADO_KV.put('sync:timestamp', Date.now().toString());
    
    return new Response(JSON.stringify({
      success: true,
      total: books.length,
      active: books.filter(b => b.stock > 0).length,
      sync_time: new Date().toISOString()
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (e) {
    console.error('Sync error:', e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function getAccessToken(env) {
  const res = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.MELI_APP_ID,
      client_secret: env.MELI_CLIENT_SECRET,
      refresh_token: env.MELI_REFRESH_TOKEN
    })
  });
  
  const data = await res.json();
  return data.access_token;
}
