export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    if (url.pathname.includes('/api/home')) {
      const cached = await env.AMADO_KV.get('books:active', 'json');
      if (!cached) return new Response(JSON.stringify({ error: "KV_EMPTY" }), { headers: corsHeaders });
      return new Response(JSON.stringify(cached), { headers: corsHeaders });
    }

    if (url.pathname.includes('/api/sync-all-books')) {
      const token = await getToken(env);
      const res = await fetch(`https://api.mercadolibre.com/users/${env.SELLER_ID}/items/search?limit=50`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      await env.AMADO_KV.put('books:active', JSON.stringify(data.results));
      return new Response(JSON.stringify({ success: true, count: data.results.length }), { headers: corsHeaders });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
  return new Response("Not Found", { status: 404 });
}

async function getToken(env) {
  const r = await fetch('[https://api.mercadolibre.com/oauth/token](https://api.mercadolibre.com/oauth/token)', {
    method: 'POST',
    body: new URLSearchParams({ 
      grant_type: 'refresh_token', 
      client_id: env.APP_ID, 
      client_secret: env.CLIENT_SECRET, 
      refresh_token: env.REFRESH_TOKEN 
    })
  });
  const d = await r.json();
  return d.access_token;
