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

  // Búsqueda EN TIEMPO REAL con Mercado Libre
  if (url.pathname === '/api/buscar') {
    const query = url.searchParams.get('q') || '';
    
    try {
      // Obtener token de acceso
      const accessToken = await getMeliAccessToken(env);
      
      // Buscar SOLO tus libros
      const searchResponse = await fetch(
        `https://api.mercadolibre.com/users/${env.MELI_USER_ID}/items/search?q=${encodeURIComponent(query)}&limit=20`,
        {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        }
      );
      
      const searchData = await searchResponse.json();
      
      // Obtener detalles de cada producto
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
          'Cache-Control': 'public, max-age=3600' // Caché 1 hora
        }
      });
    } catch (error) {
      console.error('Error en búsqueda Meli:', error);
      
      // Fallback al catálogo estático
      try {
        const catalogoResponse = await fetch('/data/catalogo_amado_libros.json');
        const catalogo = await catalogoResponse.json();
        
        const resultados = catalogo.filter(libro => 
          (libro.titulo && libro.titulo.toLowerCase().includes(query.toLowerCase())) ||
          (libro.autor && libro.autor.toLowerCase().includes(query.toLowerCase()))
        );
        
        return new Response(JSON.stringify(resultados.slice(0, 50)), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (fallbackError) {
        return new Response(JSON.stringify({ 
          error: "Error al buscar libros",
          message: error.message 
        }), {
          status: 500,
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

  return new Response('Not Found', { status: 404 });
}
