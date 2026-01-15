export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;
  
  // Detectar qué ruta es
  if (pathname.includes('/api/home')) {
    return handleHome(context);
  } else if (pathname.includes('/api/search')) {
    return handleSearch(context);
  } else if (pathname.includes('/api/sync-all-books')) {
    return handleSync(context);
  } else {
    return new Response('Not found', { status: 404 });
  }
}

// RUTA 1: /api/home
async function handleHome(context) {
  const { env } = context;
  
  try {
    const cached = await env.AMADO_KV.get('books:active', 'json');
    
    if (!cached) {
      return new Response(JSON.stringify([]), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify(cached), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600'
      }
    });
    
  } catch (e) {
    console.error('Error en /api/home:', e);
    return new Response(JSON.stringify([]), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// RUTA 2: /api/search
async function handleSearch(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const query = url.searchParams.get('q') || '';
  
  if (!query) {
    return new Response(JSON.stringify([]), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  try {
    const cached = await env.AMADO_KV.get('books:all', 'json');
    
    if (!cached || !cached.books) {
      return new Response(JSON.stringify([]), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const queryLower = query.toLowerCase();
    const results = cached.books.filter(book =>
      book.title.toLowerCase().includes(queryLower)
    );
    
    return new Response(JSON.stringify(results.slice(0, 50)), {
      headers: {
      
