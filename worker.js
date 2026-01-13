/**
 * Cloudflare Worker: Amado Libros API Proxy & SEO Injector
 * Pilares: Performance, Seguridad y SEO.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 1. Ruta de API: Obtener Catálogo desde KV
    if (url.pathname === '/api/books') {
      return handleBooksRequest(request, env);
    }

    // 2. Ruta de Webhook: Sincronización desde Mercado Libre
    if (url.pathname === '/api/webhook/meli' && request.method === 'POST') {
      return handleMeliWebhook(request, env);
    }

    // 3. SEO Dinámico: Inyección de Metatags para Libros Individuales
    if (url.pathname.startsWith('/libro/')) {
      return handleSeoInjection(request, env);
    }

    // Por defecto, servir el sitio estático
    return fetch(request);
  }
};

/**
 * Maneja la entrega del catálogo optimizado desde KV
 */
async function handleBooksRequest(request, env) {
  const cacheKey = 'full_catalog';
  // AMADO_KV debe estar configurado en el panel de Cloudflare
  let catalog = await env.AMADO_KV.get(cacheKey, { type: 'json' });

  if (!catalog) {
    return new Response(JSON.stringify({ error: 'Catalog not ready' }), {
      status: 503,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  return new Response(JSON.stringify(catalog), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300' // Cache en navegador por 5 min
    }
  });
}

/**
 * Procesa notificaciones de Mercado Libre para actualizar stock/precio
 */
async function handleMeliWebhook(request, env) {
  try {
    const body = await request.json();
    // Lógica para procesar el recurso de MeLi y actualizar KV
    // Se requiere MELI_ACCESS_TOKEN en las variables de entorno
    return new Response('OK', { status: 200 });
  } catch (e) {
    return new Response('Error', { status: 500 });
  }
}

/**
 * Inyecta Metatags y Schema.org dinámicamente
 */
async function handleSeoInjection(request, env) {
  const url = new URL(request.url);
  const slug = url.pathname.split('/').pop();
  
  const bookData = await env.AMADO_KV.get(`book:${slug}`, { type: 'json' });
  
  if (!bookData) return fetch(request);

  const response = await fetch(request);
  const html = await response.text();

  const seoHtml = html
    .replace('<title>Amado Libros', `<title>${bookData.title} - Amado Libros`)
    .replace('property="og:title" content=".*?"', `property="og:title" content="${bookData.title} de ${bookData.author}"`)
    .replace('property="og:image" content=".*?"', `property="og:image" content="${bookData.image}"`)
    .replace('</head>', `
      <script type="application/ld+json">
      {
        "@context": "https://schema.org/",
        "@type": "Book",
        "name": "${bookData.title}",
        "author": { "@type": "Person", "name": "${bookData.author}" },
        "offers": {
          "@type": "Offer",
          "price": "${bookData.price}",
          "priceCurrency": "UYU",
          "availability": "https://schema.org/InStock"
        }
      }
      </script>
      </head>
    `);

  return new Response(seoHtml, {
    headers: { 'Content-Type': 'text/html' }
  });
}
