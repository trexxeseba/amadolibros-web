export async function onRequest(context) {
  const { env } = context;
  const url = new URL(context.request.url);

  // --- 1. GESTIÓN DE CREDENCIALES (NORMALIZACIÓN) ---
  // CORRECCIÓN CRÍTICA: Unificamos los nombres de variables para que coincidan con wrangler.toml o Dashboard
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
      console.error("Error leyendo KV Home:", e);
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (url.pathname.includes('/api/search')) {
    const q = url.searchParams.get('q');
    if (!q) return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
    
    try {
      const cached = await env.AMADO_KV.get('books:all', 'json');
      // Búsqueda simple en memoria (OK para catálogos medianos)
      const results = cached?.books?.filter(b => 
        b.title.toLowerCase().includes(q.toLowerCase())
      ) || [];
      return new Response(JSON.stringify(results.slice(0, 50)), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      console.error("Error en búsqueda:", e);
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // --- 3. ENDPOINT CRÍTICO: SINCRONIZACIÓN (HOTFIX APLICADO) ---
  if (url.pathname.includes('/api/sync-all-books')) {
    // Verificación de seguridad inicial
    if (!SELLER_ID || !APP_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: "Variables de entorno faltantes. Revisa SELLER_ID, APP_ID, CLIENT_SECRET, REFRESH_TOKEN en Cloudflare." 
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    try {
      // Paso 1: Obtener Token
      const token = await getToken({ APP_ID, CLIENT_SECRET, REFRESH_TOKEN });
      
      let allIds = [];
      let offset = 0;
      let hasMore = true;
      const LIMIT = 50; // Límite por página
      const MAX_LOOPS = 40; // Seguridad: Evitamos bucles infinitos que causen Timeout (aprox 2000 libros por ejecución)

      // Paso 2: Obtener IDs (Bucle protegido)
      let loopCount = 0;
      while (hasMore && loopCount < MAX_LOOPS) {
        // Endpoint correcto: /users/{id}/items/search
        const fetchUrl = `https://api.mercadolibre.com/users/${SELLER_ID}/items/search?offset=${offset}&limit=${LIMIT}`;
        
        const r = await fetch(fetchUrl, { 
          headers: { 'Authorization': `Bearer ${token}` } 
        });
        
        if (!r.ok) {
           console.error(`Error fetching IDs at offset ${offset}: ${r.status}`);
           // Si falla un bloque, intentamos continuar o rompemos
           if (r.status === 401 || r.status === 403) throw new Error("Error de Permisos en API Meli");
           break; 
        }

        const d = await r.json();
        if (!d.results || d.results.length === 0) {
          hasMore = false;
        } else {
          allIds = allIds.concat(d.results);
          offset += LIMIT;
          loopCount++;
          // Pausa reducida a 50ms (antes 150ms) para evitar Timeouts de Cloudflare
          await new Promise(r => setTimeout(r, 50)); 
        }
      }

      // Paso 3: Obtener Detalles (Hydrate Items)
      const books = [];
      const CHUNK_SIZE = 20; // Meli permite hasta 20 IDs en /items
      
      for (let i = 0; i < allIds.length; i += CHUNK_SIZE) {
        const chunk = allIds.slice(i, i + CHUNK_SIZE);
        const ids = chunk.join(',');
        
        const r = await fetch(`https://api.mercadolibre.com/items?ids=${ids}`, { 
          headers: { 'Authorization': `Bearer ${token}` } 
        });

        if (r.ok) {
          const d = await r.json();
          d.forEach(item => {
            // Verificamos respuesta 200 dentro del array multiget
            if (item.code === 200 && item.body && item.body.status === 'active') {
               books.push({ 
                 id: item.body.id, 
                 title: item.body.title, 
                 price: item.body.price, 
                 thumbnail: item.body.thumbnail, 
                 permalink: item.body.permalink, 
                 stock: item.body.available_quantity 
               });
            }
          });
        }
        // Pausa mínima
        await new Promise(r => setTimeout(r, 20)); 
      }

      // Paso 4: Guardar en KV
      const dataToSave = { 
        books, 
        active: books.filter(b => b.stock > 0), 
        timestamp: Date.now() 
      };
      
      // Guardamos 'active' para home (rápido) y 'all' para búsquedas
      await env.AMADO_KV.put('books:active', JSON.stringify(dataToSave.active), { expirationTtl: 86400 });
      await env.AMADO_KV.put('books:all', JSON.stringify(dataToSave), { expirationTtl: 86400 });

      return new Response(JSON.stringify({ 
        success: true, 
        message: "Sincronización completada (Hotfix Mode)",
        total_scanned: allIds.length,
        total_saved: books.length 
      }), { headers: { 'Content-Type': 'application/json' } });

    } catch (e) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: e.message, 
        stack: e.stack 
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }
  
  return new Response('Endpoint no encontrado', { status: 404 });
}

// Helper para obtener token (Refactored para aceptar objeto env limpio)
async function getToken({ APP_ID, CLIENT_SECRET, REFRESH_TOKEN }) {
  const response = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/x-www-form-urlencoded', 
      'Accept': 'application/json' 
    },
    body: new URLSearchParams({ 
      grant_type: 'refresh_token', 
      client_id: APP_ID, 
      client_secret: CLIENT_SECRET, 
      refresh_token: REFRESH_TOKEN 
    })
  });
  
  if (!response.ok) {
    const errText = await response.text();
    console.error("Error renovando token:", errText);
    throw new Error(`Fallo Auth MercadoLibre: ${response.status} - Verifica tus credenciales.`);
  }

  const data = await response.json();
  return data.access_token;
}
