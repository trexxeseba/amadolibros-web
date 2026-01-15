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
  
  // Salud (verifica KV y variables)
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

  // Catálogo HOME (primeros 50 libros)
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
      console.error('Error en home Meli:', error);
      
      // ✅ FALLBACK MEJORADO: Si falla Mercado Libre, usa el JSON estático
      try {
        // Esta ruta debe apuntar al archivo estático en tu servidor
        const fallbackResponse = await fetch(`${new URL(request.url).origin}/data/catalogo_amado_libros.json`);
        const fallbackData = await fallbackResponse.json();
        
        return new Response(JSON.stringify(fallbackData), {
          headers: { 
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600'
          }
        });
      } catch (fallbackError) {
        // Si también falla el estático, devuelve un error claro
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

  // Búsqueda EN TIEMPO REAL con Mercado Libre
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
      console.error('Error en búsqueda Meli:', error);
      
      // ✅ FALLBACK MEJORADO: Si falla la búsqueda en vivo, filtra el catálogo estático
      try {
        const fallbackResponse = await fetch(`${new URL(request.url).origin}/data/catalogo_amado_libros.json`);
        const catalogo = await fallbackResponse.json();
        
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
      } catch (fallbackError) {
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

  // Sistema de encargos (sin cambios)
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

  // Para cualquier otra ruta /api/* que no coincida, devuelve 404
  return new Response('Not Found', { status: 404 });
}
