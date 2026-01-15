async function getMeliAccessToken(env) {
  const response = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.MELI_APP_ID,
      client_secret: env.MELI_CLIENT_SECRET,
      refresh_token: env.MELI_REFRESH_TOKEN
    })
  });
  
  const data = await response.json();
  return data.access_token;
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  
  // 1. Endpoint de salud
  if (url.pathname === '/api/health') {
    return new Response(JSON.stringify({ 
      status: "OK",
      kv_configurado: !!env.ENCARGOS_KV,
      meli_configurado: !!env.MELI_APP_ID,
      timestamp: new Date().toISOString()
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // 2. Catálogo principal (HOME)
  if (url.pathname === '/api/home') {
    try {
      const accessToken = await getMeliAccessToken(env);
      
      const searchResponse = await fetch(
        `https://api.mercadolibre.com/users/${env.MELI_USER_ID}/items/search?limit=50`,
        {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        }
      );
      
      const searchData = await searchResponse.json();
      
      const items = await Promise.all(
        searchData.results.map(async (itemId) => {
          const itemResponse = await fetch(
            `https://api.mercadolibre.com/items/${itemId}`,
            { headers: { 'Authorization': `Bearer ${accessToken}` } }
          );
          return await itemResponse.json();
        })
      );
      
      return new Response(JSON.stringify(items), {
        headers: { 
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    } catch (error) {
      console.error('Error en /api/home (Meli):', error);
      
      // ✅ FALLBACK PRINCIPAL: Leer del KV (clave 'full_catalog')
      try {
        const fullCatalog = await env.ENCARGOS_KV.get("full_catalog", "json");
        const fallbackData = fullCatalog || [];
        
        return new Response(JSON.stringify(fallbackData), {
          headers: { 
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600'
          }
        });
      } catch (kvError) {
        // ✅ FALLBACK SECUNDARIO: Intentar archivo estático (por si el KV falla)
        try {
          const staticResponse = await fetch(`${url.origin}/data/catalogo_amado_libros.json`);
          const staticData = await staticResponse.json();
          return new Response(JSON.stringify(staticData), {
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (staticError) {
          return new Response(JSON.stringify({ 
            error: "Catálogo no disponible",
            message: "Intenta recargar la página más tarde."
          }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
    }
  }

  // 3. Búsqueda en tiempo real
  if (url.pathname === '/api/buscar') {
    const query = url.searchParams.get('q') || '';
    
    try {
      const accessToken = await getMeliAccessToken(env);
      
      const searchResponse = await fetch(
        `https://api.mercadolibre.com/users/${env.MELI_USER_ID}/items/search?q=${encodeURIComponent(query)}&limit=20`,
        {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        }
      );
      
      const searchData = await searchResponse.json();
      
      const items = await Promise.all(
        searchData.results.map(async (itemId) => {
          const itemResponse = await fetch(
            `https://api.mercadolibre.com/items/${itemId}`,
            { headers: { 'Authorization': `Bearer ${accessToken}` } }
          );
          return await itemResponse.json();
        })
      );
      
      return new Response(JSON.stringify(items), {
        headers: { 
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    } catch (error) {
      console.error('Error en /api/buscar (Meli):', error);
      
      // ✅ FALLBACK PRINCIPAL: Buscar dentro del KV
      try {
        const fullCatalog = await env.ENCARGOS_KV.get("full_catalog", "json");
        const catalogo = fullCatalog || [];
        
        const resultados = catalogo.filter(libro => 
          (libro.title && libro.title.toLowerCase().includes(query.toLowerCase())) ||
          (libro.id && libro.id.toLowerCase().includes(query.toLowerCase()))
        );
        
        return new Response(JSON.stringify(resultados.slice(0, 50)), {
          headers: { 
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=300'
          }
        });
      } catch (kvError) {
        // ✅ FALLBACK SECUNDARIO: Buscar en archivo estático
        try {
          const staticResponse = await fetch(`${url.origin}/data/catalogo_amado_libros.json`);
          const staticCatalog = await staticResponse.json();
          
          const staticResults = staticCatalog.filter(libro => 
            (libro.title && libro.title.toLowerCase().includes(query.toLowerCase())) ||
            (libro.id && libro.id.toLowerCase().includes(query.toLowerCase()))
          );
          
          return new Response(JSON.stringify(staticResults.slice(0, 50)), {
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (staticError) {
          return new Response(JSON.stringify({ 
            error: "Búsqueda no disponible",
            message: "Usa el catálogo principal o intenta más tarde."
          }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
    }
  }

  // 4. Sistema de encargos (POST)
  if (url.pathname === '/api/encargo' && request.method === 'POST') {
    try {
      const { libroId, email, tituloLibro } = await request.json();
      
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: "Email inválido" 
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      if (!libroId || !tituloLibro) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: "Faltan datos del libro" 
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      await env.ENCARGOS_KV.put(
        `encargo:${libroId}:${Date.now()}`, 
        JSON.stringify({
          email,
          tituloLibro,
          libroId,
          fecha: new Date().toISOString(),
          estado: "pendiente"
        })
      );
      
      return new Response(JSON.stringify({ 
        success: true,
        message: "¡Gracias! Te avisaremos cuando este libro esté disponible."
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error("Error en encargo:", error);
      return new Response(JSON.stringify({ 
        success: false, 
        error: "Error al registrar encargo" 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // 5. Cualquier otra ruta /api/*
  return new Response('Not Found', { status: 404 });
}
