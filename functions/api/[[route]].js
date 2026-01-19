export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // 1. Cabeceras de Seguridad (CORS) para que el navegador no bloquee
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // 2. Endpoint HOME: Devuelve los libros guardados
    if (path.includes('/api/home')) {
      const cached = await env.AMADO_KV.get('books:active', 'json');
      if (!cached) {
        return new Response(JSON.stringify({ error: "KV_EMPTY" }), { headers: corsHeaders });
      }
      return new Response(JSON.stringify(cached), { headers: corsHeaders });
    }

    // 3. Endpoint SEARCH: Buscador
    if (path.includes('/api/search')) {
      const q = url.searchParams.get('q');
      if (!q) return new Response(JSON.stringify([]), { headers: corsHeaders });
      
      const cached = await env.AMADO_KV.get('books:active', 'json');
      if (!cached) return new Response(JSON.stringify([]), { headers: corsHeaders });

      const results = cached.filter(b => 
        b.title.toLowerCase().includes(q.toLowerCase())
      );
      return new Response(JSON.stringify(results.slice(0, 50)), { headers: corsHeaders });
    }

    // 4. Endpoint SYNC: Conecta con Mercado Libre
    if (path.includes('/api/sync-all-books')) {
      const { SELLER_ID, APP_ID, CLIENT_SECRET, REFRESH_TOKEN } = env;

      if (!SELLER_ID || !APP_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
         throw new Error("Faltan credenciales en Cloudflare.");
      }

      // Paso A: Obtener Token
      const tokenRes = await fetch('https://api.mercadolibre.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ 
            grant_type: 'refresh_token', 
            client_id: APP_ID, 
            client_secret: CLIENT_SECRET, 
            refresh_token: REFRESH_TOKEN 
        })
      });
      const tokenData = await tokenRes.json();
      
      if (!tokenData.access_token) {
          throw new Error("Error de autenticación con ML: " + JSON.stringify(tokenData));
      }

      // Paso B: Buscar IDs de libros (Traemos 50 para asegurar que cargue rápido y no de timeout)
      const searchRes = await fetch(`https://api.mercadolibre.com/users/${SELLER_ID}/items/search?limit=50`, {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
      });
      const searchData = await searchRes.json();

      if (!searchData.results || searchData.results.length === 0) {
        return new Response(JSON.stringify({ success: false, message: "No se encontraron libros en la cuenta." }), { headers: corsHeaders });
      }

      // Paso C: Obtener detalles de cada libro
      const ids = searchData.results.join(',');
      const itemsRes = await fetch(`https://api.mercadolibre.com/items?ids=${ids}`, {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
      });
      const itemsData = await itemsRes.json();

      // Paso D: Limpiar datos y guardar
      const books = itemsData
        .map(i => i.body)
        .filter(b => b.status === 'active' || b.status === 'paused')
        .map(b => ({
           id: b.id,
           title: b.title,
           price: b.price,
           thumbnail: b.thumbnail,
           permalink: b.permalink,
           free_shipping: b.shipping?.free_shipping || false,
           status: b.status
        }));

      await env.AMADO_KV.put('books:active', JSON.stringify(books));

      return new Response(JSON.stringify({ success: true, count: books.length }), { headers: corsHeaders });
    }

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }

  return new Response("Not Found", { status: 404, headers: corsHeaders });
}
