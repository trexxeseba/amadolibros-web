export async function onRequest(context) {
  const { env } = context;
  const url = new URL(context.request.url);

  // --- 1. CREDENCIALES ---
  const SELLER_ID = env.SELLER_ID || env.USER_ID;
  const APP_ID = env.APP_ID || env.MELI_APP_ID;
  const CLIENT_SECRET = env.CLIENT_SECRET || env.MELI_CLIENT_SECRET;
  const REFRESH_TOKEN = env.REFRESH_TOKEN || env.MELI_REFRESH_TOKEN;

  // Helper para normalizar texto (Quitar acentos y minúsculas)
  const normalize = (str) => {
    if (!str) return "";
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  };

  // --- 2. ENDPOINTS DE LECTURA ---
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

  // --- BUSCADOR INTELIGENTE V3.1 (SCORING) ---
  if (url.pathname.includes('/api/search')) {
    const q = url.searchParams.get('q');
    if (!q) return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
    
    try {
      const cached = await env.AMADO_KV.get('books:all', 'json');
      const terms = normalize(q).split(" ").filter(t => t.length > 0);

      // Algoritmo de Ranking
      const scoredResults = cached?.books?.map(b => {
        let score = 0;
        const titleNorm = normalize(b.title);
        const authorNorm = normalize(b.author || "");
        const isbnNorm = normalize(b.isbn || "");
        const publisherNorm = normalize(b.publisher || "");

        // Evaluamos cada término de búsqueda
        terms.forEach(term => {
          // PUNTUACIÓN DE RELEVANCIA
          if (titleNorm.includes(term)) score += 20;      // Título: Prioridad Alta
          if (titleNorm.startsWith(term)) score += 10;    // Empieza con el término: Bonus
          if (authorNorm.includes(term)) score += 15;     // Autor: Prioridad Media-Alta
          if (isbnNorm.includes(term)) score += 50;       // ISBN: Prioridad Máxima (Búsqueda exacta)
          if (publisherNorm.includes(term)) score += 5;   // Editorial: Prioridad Baja
        });

        return { book: b, score: score };
      })
      // Filtramos los que tienen 0 coincidencias
      .filter(item => item.score > 0)
      // Ordenamos por puntaje (mayor a menor)
      .sort((a, b) => b.score - a.score)
      // Recuperamos solo el objeto libro limpio
      .map(item => item.book) || [];

      return new Response(JSON.stringify(scoredResults.slice(0, 50)), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // --- 3. DETALLES (LAZY LOAD) ---
  if (url.pathname.includes('/api/book-details')) {
    const id = url.searchParams.get('id');
    if (!id) return new Response('ID requerido', { status: 400 });

    try {
      const cacheKey = `detail:${id}`;
      const cachedDetail = await env.AMADO_KV.get(cacheKey, 'json');
      if (cachedDetail) {
        return new Response(JSON.stringify(cachedDetail), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=604800' } });
      }

      const token = await getToken({ APP_ID, CLIENT_SECRET, REFRESH_TOKEN });
      const [descRes, itemRes] = await Promise.all([
        fetch(`https://api.mercadolibre.com/items/${id}/description`, { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch(`https://api.mercadolibre.com/items/${id}`, { headers: { 'Authorization': `Bearer ${token}` } })
      ]);

      const descData = descRes.ok ? await descRes.json() : { plain_text: "Sin descripción." };
      const itemData = itemRes.ok ? await itemRes.json() : {};

      const detail = {
        id: id,
        description: descData.plain_text || descData.text || "",
        pictures: itemData.pictures ? itemData.pictures.map(p => p.url) : [],
        permalink: itemData.permalink,
        attributes: itemData.attributes || []
      };

      await env.AMADO_KV.put(cacheKey, JSON.stringify(detail), { expirationTtl: 604800 });
      return new Response(JSON.stringify(detail), { headers: { 'Content-Type': 'application/json' } });

    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // --- 4. SINCRONIZACIÓN (EXTRACTOR ROBUSTO V3) ---
  if (url.pathname.includes('/api/sync-all-books')) {
    if (!SELLER_ID || !APP_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
      return new Response(JSON.stringify({ success: false, error: "Credenciales faltantes." }), { status: 500 });
    }

    try {
      const token = await getToken({ APP_ID, CLIENT_SECRET, REFRESH_TOKEN });
      
      let allIds = [];
      let offset = 0;
      let hasMore = true;
      const LIMIT = 50; 
      const MAX_LOOPS = 80;

      // FASE A: ESCANEO
      let loopCount = 0;
      while (hasMore && loopCount < MAX_LOOPS) {
        const fetchUrl = `https://api.mercadolibre.com/users/${SELLER_ID}/items/search?offset=${offset}&limit=${LIMIT}`; 
        const r = await fetch(fetchUrl, { headers: { 'Authorization': `Bearer ${token}` } });
        
        if (!r.ok) break; 
        const d = await r.json();
        if (!d.results || d.results.length === 0) hasMore = false;
        else {
          allIds = allIds.concat(d.results);
          offset += LIMIT;
          loopCount++;
          await new Promise(r => setTimeout(r, 20)); 
        }
      }

      // FASE B: HIDRATACIÓN
      const books = [];
      const CHUNK_SIZE = 20;
      
      // HELPER EXTRACTOR DE ATRIBUTOS
      const getAttr = (attrs, possibleIds) => {
        if (!attrs) return null;
        const idsToCheck = Array.isArray(possibleIds) ? possibleIds : [possibleIds];
        const found = attrs.find(a => idsToCheck.includes(a.id));
        return found ? found.value_name : null;
      };

      for (let i = 0; i < allIds.length; i += CHUNK_SIZE) {
        const chunk = allIds.slice(i, i + CHUNK_SIZE);
        const ids = chunk.join(',');
        const r = await fetch(`https://api.mercadolibre.com/items?ids=${ids}`, { headers: { 'Authorization': `Bearer ${token}` } });
        
        if (r.ok) {
          const d = await r.json();
          d.forEach(item => {
            if (item.code === 200 && item.body) {
               const st = item.body.status;
               if (st === 'active' || st === 'paused') {
                 books.push({ 
                   id: item.body.id, 
                   title: item.body.title, 
                   price: item.body.price, 
                   thumbnail: item.body.thumbnail, 
                   permalink: item.body.permalink, 
                   stock: item.body.available_quantity,
                   status: st,
                   date_created: item.body.date_created, 
                   free_shipping: item.body.shipping?.free_shipping || false,
                   // ATRIBUTOS CLAVE PARA BÚSQUEDA
                   author: getAttr(item.body.attributes, ['AUTHOR', 'WRITER', 'AUTHORS']),
                   pages: getAttr(item.body.attributes, ['PAGE_COUNT', 'NUMBER_OF_PAGES']),
                   isbn: getAttr(item.body.attributes, ['GTIN', 'ISBN']),
                   publisher: getAttr(item.body.attributes, ['PUBLISHER', 'EDITORIAL']),
                   language: getAttr(item.body.attributes, ['LANGUAGE'])
                 });
               }
            }
          });
        }
        await new Promise(r => setTimeout(r, 20)); 
      }

      // FASE C: GUARDADO
      const dataToSave = { books, active: books, timestamp: Date.now() };
      await env.AMADO_KV.put('books:active', JSON.stringify(dataToSave.active));
      await env.AMADO_KV.put('books:all', JSON.stringify(dataToSave));

      return new Response(JSON.stringify({ 
        success: true, 
        total: books.length,
        version: "3.1-Ranked",
        message: "Sincronización completada. Ranking de búsqueda activado."
      }), { headers: { 'Content-Type': 'application/json' } });

    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 });
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
