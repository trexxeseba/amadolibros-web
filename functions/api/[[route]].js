export async function onRequest(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  
  if (url.pathname.includes('/api/home')) {
    const cached = await env.AMADO_KV.get('books:active', 'json');
    return new Response(JSON.stringify(cached || []), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' } });
  }
  
  if (url.pathname.includes('/api/search')) {
    const q = url.searchParams.get('q');
    if (!q) return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
    const cached = await env.AMADO_KV.get('books:all', 'json');
    const results = cached?.books?.filter(b => b.title.toLowerCase().includes(q.toLowerCase())) || [];
    return new Response(JSON.stringify(results.slice(0, 50)), { headers: { 'Content-Type': 'application/json' } });
  }
  
  if (url.pathname.includes('/api/sync-all-books')) {
    try {
      const token = await getToken(env);
      let all = [], offset = 0;
      for (let i = 0; i < 150; i++) {
        const r = await fetch(`https://api.mercadolibre.com/users/${env.USER_ID}/items/search?offset=${offset}&limit=100`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!r.ok) break;
        const d = await r.json();
        if (!d.results?.length) break;
        all = all.concat(d.results);
        offset += 100;
        await new Promise(r => setTimeout(r, 150));
      }
      const books = [];
      for (let i = 0; i < all.length; i += 20) {
        const ids = all.slice(i, i+20).join(',');
        const r = await fetch(`https://api.mercadolibre.com/items?ids=${ids}`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!r.ok) break;
        const d = await r.json();
        d.forEach(item => {
          if (item.body?.status === 'active') {
            books.push({ id: item.body.id, title: item.body.title, price: item.body.price, thumbnail: item.body.thumbnail, permalink: item.body.permalink, stock: item.body.available_quantity });
          }
        });
        await new Promise(r => setTimeout(r, 150));
      }
      await env.AMADO_KV.put('books:all', JSON.stringify({ books, active: books.filter(b => b.stock > 0), timestamp: Date.now() }), { expirationTtl: 86400 });
      return new Response(JSON.stringify({ success: true, total: books.length, active: books.filter(b => b.stock > 0).length }), { headers: { 'Content-Type': 'application/json' } });
    } cat
