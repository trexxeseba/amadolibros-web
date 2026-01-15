export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  
  // Ruta de salud (verifica conexión con KV)
  if (url.pathname === '/api/health') {
    return new Response(JSON.stringify({ 
      status: "OK",
      kv_configurado: !!env.ENCARGOS_KV,
      kv_namespace: "AMADO_KV",
      timestamp: new Date().toISOString()
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // Sistema de búsqueda (usa catálogo estático)
  if (url.pathname === '/api/buscar') {
    const query = url.searchParams.get('q') || '';
    
    try {
      // Cargar catálogo desde la carpeta pública
      const catalogoResponse = await fetch('/data/catalogo_amado_libros.json');
      if (!catalogoResponse.ok) {
        throw new Error('No se pudo cargar el catálogo');
      }
      
      const catalogo = await catalogoResponse.json();
      
      // Búsqueda simple
      const resultados = catalogo.filter(libro => 
        (libro.titulo && libro.titulo.toLowerCase().includes(query.toLowerCase())) ||
        (libro.autor && libro.autor.toLowerCase().includes(query.toLowerCase()))
      );
      
      return new Response(JSON.stringify(resultados.slice(0, 50)), {
        headers: { 
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    } catch (error) {
      return new Response(JSON.stringify({ 
        error: "Error al buscar libros",
        message: error.message 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // Sistema de encargos (USA EL KV VINCULADO)
  if (url.pathname === '/api/encargo' && request.method === 'POST') {
    try {
      const { libroId, email, tituloLibro } = await request.json();
      
      // Validaciones
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
      
      // Guardar en KV (USANDO EL NOMBRE DE ENLACE CORRECTO)
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
