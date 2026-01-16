export async function onRequest(context) {
  const { env } = context;
  const url = new URL(context.request.url);

  // --- 1. GESTIÓN DE CREDENCIALES (NORMALIZACIÓN) ---
  const SELLER_ID = env.SELLER_ID || env.USER_ID;
  const APP_ID = env.APP_ID || env.MELI_APP_ID;
  const CLIENT_SECRET = env.CLIENT_SECRET || env.MELI_CLIENT_SECRET;
  const REFRESH_TOKEN = env.REFRESH_TOKEN || env.MELI_REFRESH_TOKEN;

  // --- 2. ENDPOINTS DE LECTURA (RÁPIDOS) ---
  if (url.pathname.includes('/api/home')) {
    try {
      const cached = await env.AMADO_KV.get('books:active', 'json');
      return new Response(JSON.stringify(cached || []), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' }
      });
    } catch (e) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (url.pathname.includes('/api/search')) {
    const q = url.searchParams.get('q');
    if (!q) return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
    
    try {
      const cached = await env.AMADO_KV.get('books:all', 'json');
      const results = cached?.books?.filter(b => 
        b.title.toLowerCase().includes(q.toLowerCase())
      ) || [];
      return new Response(JSON.stringify(results.slice(0, 50)), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // --- 3. ENDPOINT CRÍTICO: SINCRONIZACIÓN (HOTFIX MEJORADO) ---
  if (url.pathname.includes('/api/sync-all-books')) {
    
    // DIAGNÓSTICO DETALLADO: Identificamos exactamente qué falta
    const missing = [];
    if (!SELLER_ID) missing.push("SELLER_ID (o USER_ID)");
    if (!APP_ID) missing.push("APP_ID (o MELI_APP_ID)");
    if (!CLIENT_SECRET) missing.push("CLIENT_SECRET (o MELI_CLIENT_SECRET)");
    if (!REFRESH_TOKEN) missing.push("REFRESH_TOKEN (o MELI_REFRESH_TOKEN)");

    if (missing.length > 0) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: `Faltan variables de entorno: ${missing.join(', ')}.`,
        instruction: "Ve a Cloudflare Pages -> Settings -> Environment Variables y agrégalas."
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    try {
      const token = await getToken({ APP_ID, CLIENT_SECRET, REFRESH_TOKEN });
      
      // ... (Lógica de sincronización idéntica a la anterior) ...
      let allIds = [];
      let offset = 0;
      let hasMore = true;
      const LIMIT = 50; 
      const MAX_LOOPS = 40; 

      let loopCount = 0;
      while (hasMore && loopCount < MAX_LOOPS) {
        const fetchUrl = `https://api.mercadolibre.com/users/${SELLER_ID}/items/search?offset=${offset}&limit=${LIMIT}`;
        const r = await fetch(fetchUrl, { headers: { 'Authorization': `Bearer ${token}` } });
        
        if (!r.ok) {
           if (r.status === 401 || r.status === 403) throw new Error(`Error de Permisos Meli: ${r.status}`);
           break; 
        }
        const d = await r.json();
        if (!d.results || d.results.length === 0) hasMore = false;
        else {
          allIds = allIds.concat(d.results);
          offset += LIMIT;
          loopCount++;
          await new Promise(r => setTimeout(r, 50)); 
        }
      }

      const books = [];
      const CHUNK_SIZE = 20;
      for (let i = 0; i < allIds.length; i += CHUNK_SIZE) {
        const chunk = allIds.slice(i, i + CHUNK_SIZE);
        const ids = chunk.join(',');
        const r = await fetch(`https://api.mercadolibre.com/items?ids=${ids}`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (r.ok) {
          const d = await r.json();
          d.forEach(item => {
            if (item.code === 200 && item.body && item.body.status === 'active') {
               books.push({ 
                 id: item.body.id, title: item.body.title, price: item.body.price, 
                 thumbnail: item.body.thumbnail, permalink: item.body.permalink, stock: item.body.available_quantity 
               });
            }
          });
        }
        await new Promise(r => setTimeout(r, 20)); 
      }

      const dataToSave = { books, active: books.filter(b => b.stock > 0), timestamp: Date.now() };
      await env.AMADO_KV.put('books:active', JSON.stringify(dataToSave.active), { expirationTtl: 86400 });
      await env.AMADO_KV.put('books:all', JSON.stringify(dataToSave), { expirationTtl: 86400 });

      return new Response(JSON.stringify({ 
        success: true, 
        message: "Sincronización Exitosa",
        total: books.length 
      }), { headers: { 'Content-Type': 'application/json' } });

    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }
  return new Response('Endpoint no encontrado', { status: 404 });
}

async function getToken({ APP_ID, CLIENT_SECRET, REFRESH_TOKEN }) {
  const response = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: APP_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH_TOKEN })
  });
  if (!response.ok) throw new Error(`Fallo Auth MercadoLibre: ${response.status}`);
  const data = await response.json();
  return data.access_token;
}
