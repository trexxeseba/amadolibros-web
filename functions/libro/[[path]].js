/**
 * functions/libro/[[path]].js
 *
 * Fichas de producto SSR para amadolibros.com.
 * URLs: /libro/:id/:slug (canonical) | /libro/:id → 301 a canonical
 *
 * Fuente de datos: catalog.json en R2 (via URL pública + CF edge cache).
 * No depende de item:MLU... en KV (esas keys no existen).
 *
 * REGLAS DE SEGURIDAD:
 * - Todos los datos de KV/catálogo se escapan antes de insertarlos en HTML.
 * - JSON-LD generado con JSON.stringify, nunca concatenación manual.
 * - URLs de WhatsApp con encodeURIComponent.
 */

const CATALOG_URL = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json';
const BASE        = 'https://www.amadolibros.com';
const WA          = '59899841325';

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#39;');
}

function slugify(text) {
    return (text || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 60);
}

function httpsImg(url) {
    return (url || '').replace('http://', 'https://');
}

// ---------------------------------------------------------------------------
// Catálogo — CF edge cache, TTL 1h
// ---------------------------------------------------------------------------

async function fetchCatalog(context) {
    const cache    = caches.default;
    const cacheKey = new Request(CATALOG_URL);

    let resp = await cache.match(cacheKey);
    if (!resp) {
        const fetched = await fetch(CATALOG_URL);
        if (!fetched.ok) return null;
        // Re-envolver con Cache-Control explícito para que CF lo cachee
        resp = new Response(fetched.body, {
            status: fetched.status,
            headers: {
                'Content-Type':  'application/json',
                'Cache-Control': 'public, max-age=3600',
            },
        });
        context.waitUntil(cache.put(cacheKey, resp.clone()));
    }
    try {
        return await resp.json();
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Respuestas de error
// ---------------------------------------------------------------------------

function notFound() {
    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Libro no encontrado — Amado Libros</title>
  <meta name="robots" content="noindex">
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         max-width:600px;margin:4rem auto;padding:1rem;text-align:center;color:#1e293b}
    a{color:#3b82f6}
  </style>
</head>
<body>
  <h1 style="font-size:1.5rem;margin-bottom:1rem">Libro no encontrado</h1>
  <p style="color:#64748b;margin-bottom:1.5rem">
    Este libro no está disponible en el catálogo.
  </p>
  <a href="/">← Volver al catálogo</a>
</body>
</html>`;
    return new Response(html, {
        status: 404,
        headers: { 'content-type': 'text/html;charset=UTF-8' },
    });
}

// ---------------------------------------------------------------------------
// Render HTML completo de la ficha
// ---------------------------------------------------------------------------

function renderPage(item, slug) {
    const canonicalUrl = `${BASE}/libro/${item.id}/${slug}`;
    const safeTitle    = escapeHtml(item.title);
    const safeAuthor   = item.author ? escapeHtml(item.author) : null;
    const img          = httpsImg(
        (item.pictures && item.pictures[0]) ? item.pictures[0] : (item.thumbnail || '')
    );
    const price     = Number(item.price) || 0;
    const priceUY   = price.toLocaleString('es-UY');
    const inStock   = (item.available_quantity || 0) > 0;
    const waMsg     = encodeURIComponent(`Hola! Me interesa: ${item.title}`);

    const metaDesc = safeAuthor
        ? `Comprá &quot;${safeTitle}&quot; de ${safeAuthor} en Amado Libros. Precio: $${priceUY} UYU. Envíos a todo Uruguay en 24 a 48hs.`
        : `Comprá &quot;${safeTitle}&quot; en Amado Libros. Precio: $${priceUY} UYU. Envíos a todo Uruguay en 24 a 48hs.`;

    // JSON-LD — generado con JSON.stringify, nunca concatenación
    const schemaProduct = {
        '@context': 'https://schema.org',
        '@type':    'Product',
        'name':     item.title,
        'image':    img,
        'description': item.author ? `${item.title} — ${item.author}` : item.title,
        'sku':      item.id,
        'offers': {
            '@type':        'Offer',
            'url':          canonicalUrl,
            'priceCurrency':'UYU',
            'price':        String(price),
            'availability': inStock
                ? 'https://schema.org/InStock'
                : 'https://schema.org/OutOfStock',
            'seller': { '@type': 'Organization', 'name': 'Amado Libros' },
        },
    };
    if (item.author) {
        schemaProduct.author = { '@type': 'Person', 'name': item.author };
    }

    const schemaBreadcrumb = {
        '@context': 'https://schema.org',
        '@type':    'BreadcrumbList',
        'itemListElement': [
            { '@type': 'ListItem', 'position': 1, 'name': 'Inicio', 'item': `${BASE}/` },
            { '@type': 'ListItem', 'position': 2, 'name': item.title.substring(0, 80) },
        ],
    };

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle} | Amado Libros</title>
  <meta name="description" content="${metaDesc}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${canonicalUrl}">

  <meta property="og:type"        content="product">
  <meta property="og:url"         content="${canonicalUrl}">
  <meta property="og:title"       content="${safeTitle} | Amado Libros">
  <meta property="og:description" content="${metaDesc}">
  <meta property="og:image"       content="${escapeHtml(img)}">
  <meta property="og:locale"      content="es_UY">

  <meta name="twitter:card"        content="summary_large_image">
  <meta name="twitter:title"       content="${safeTitle} | Amado Libros">
  <meta name="twitter:description" content="${metaDesc}">
  <meta name="twitter:image"       content="${escapeHtml(img)}">

  <script type="application/ld+json">${JSON.stringify(schemaProduct)}</script>
  <script type="application/ld+json">${JSON.stringify(schemaBreadcrumb)}</script>

  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         background:#f8fafc;color:#1e293b;line-height:1.6}
    a{color:#3b82f6}
    header{background:#1e293b;color:white;padding:.75rem 1.25rem;
           display:flex;align-items:center;gap:.75rem}
    header a{color:white;text-decoration:none;font-weight:700;font-size:1.05rem}
    header span{color:#94a3b8;font-size:.8rem}
    nav{background:white;padding:.5rem 1.25rem;font-size:.85rem;
        border-bottom:1px solid #e2e8f0;color:#64748b}
    nav a{color:#3b82f6;text-decoration:none}
    main{max-width:820px;margin:1.5rem auto;padding:0 1rem;
         display:grid;grid-template-columns:1fr;gap:1.75rem}
    @media(min-width:580px){main{grid-template-columns:260px 1fr}}
    .cover img{width:100%;max-width:260px;border-radius:.5rem;
               box-shadow:0 4px 20px rgba(0,0,0,.12);display:block}
    .info h1{font-size:1.25rem;font-weight:700;line-height:1.35;
             margin-bottom:.75rem;color:#0f172a}
    .meta{font-size:.875rem;color:#475569;margin-bottom:.4rem}
    .meta strong{color:#1e293b}
    .badge{display:inline-block;padding:.2rem .7rem;border-radius:2rem;
           font-size:.75rem;font-weight:600;margin-bottom:.875rem}
    .in-stock{background:#dcfce7;color:#16a34a}
    .out-of-stock{background:#fef9c3;color:#854d0e}
    .price-box{background:#f5f3ff;border:1px solid #ddd6fe;border-radius:.5rem;
               padding:1rem 1.25rem;margin:.875rem 0}
    .price{font-size:1.75rem;font-weight:800;color:#7c3aed}
    .price-note{font-size:.78rem;color:#6b7280;margin-top:.2rem}
    .cta{display:flex;flex-direction:column;gap:.75rem;margin-top:1rem}
    .btn{display:block;padding:.875rem 1.25rem;border-radius:.5rem;font-size:.95rem;
         font-weight:700;text-align:center;text-decoration:none;transition:opacity .15s}
    .btn:hover{opacity:.85}
    .btn-ml{background:#ffe600;color:#1e293b}
    .btn-wa{background:#25d366;color:white}
    .shipping{font-size:.82rem;color:#64748b;margin-top:1rem;padding:.75rem 1rem;
              background:white;border:1px solid #e2e8f0;border-radius:.5rem}
    footer{background:#1e293b;color:#94a3b8;text-align:center;
           font-size:.8rem;padding:1.5rem;margin-top:2.5rem}
    footer a{color:#cbd5e1;text-decoration:none}
  </style>
</head>
<body>

<header>
  <a href="/">📚 Amado Libros</a>
  <span>Tu librería para libros difíciles de ubicar</span>
</header>

<nav>
  <a href="/">Inicio</a> ›
  <span>${safeTitle.substring(0, 70)}${item.title.length > 70 ? '…' : ''}</span>
</nav>

<main>
  <div class="cover">
    <img src="${escapeHtml(img)}" alt="${safeTitle}" loading="eager" width="260">
  </div>
  <div class="info">
    <h1>${safeTitle}</h1>
    ${safeAuthor ? `<p class="meta"><strong>Autor:</strong> ${safeAuthor}</p>` : ''}
    <span class="badge ${inStock ? 'in-stock' : 'out-of-stock'}">
      ${inStock ? '✓ En stock' : '⏳ Por encargo'}
    </span>
    <div class="price-box">
      <div class="price">$${priceUY} <span style="font-size:.9rem;font-weight:400;color:#6b7280">UYU</span></div>
      <div class="price-note">Precio lista · Pagando con transferencia: <strong>$${Math.round(price * 0.88).toLocaleString('es-UY')} UYU (−12%)</strong></div>
    </div>
    <div class="cta">
      <a class="btn btn-ml" href="${escapeHtml(item.permalink)}" target="_blank" rel="noopener noreferrer">
        🛒 Comprar en MercadoLibre
      </a>
      <a class="btn btn-wa" href="https://wa.me/${WA}?text=${waMsg}" target="_blank" rel="noopener noreferrer">
        💬 Consultar por WhatsApp
      </a>
    </div>
    <p class="shipping">
      🚚 Envíos a todo Uruguay en 24 a 48hs hábiles.
      Más de 16.000 títulos disponibles en Amado Libros.
      <a href="/politicas#envios">Ver política de envíos</a>.
    </p>
  </div>
</main>

<footer>
  &copy; 2026 Amado Libros. Todos los derechos reservados. ·
  <a href="/">Catálogo</a> ·
  <a href="/politicas">Políticas</a>
</footer>

</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------

export async function onRequest(context) {
    const pathParts = Array.isArray(context.params.path)
        ? context.params.path
        : [context.params.path].filter(Boolean);

    const id           = (pathParts[0] || '').toUpperCase();
    const providedSlug = pathParts[1] || null;

    // Validar formato ID
    if (!id || !/^MLU\d+$/.test(id)) {
        return notFound();
    }

    // Cargar catálogo (con edge cache)
    const catalog = await fetchCatalog(context);
    if (!catalog || !Array.isArray(catalog.items)) {
        return new Response('Error al cargar el catálogo. Intentá de nuevo en unos segundos.', {
            status: 503,
            headers: { 'content-type': 'text/plain;charset=UTF-8' },
        });
    }

    const item = catalog.items.find(b => b.id === id);
    if (!item) return notFound();

    const slug = slugify(item.title);

    // Redirect 301 si no viene el slug
    if (!providedSlug) {
        return Response.redirect(`${BASE}/libro/${id}/${slug}`, 301);
    }

    return new Response(renderPage(item, slug), {
        headers: {
            'content-type':  'text/html;charset=UTF-8',
            'cache-control': 'public, max-age=3600',
        },
    });
}
