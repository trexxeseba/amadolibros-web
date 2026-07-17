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

import { slugify } from '../_shared/slug.js';
import { BASE, fetchCatalog } from '../_shared/catalog.js';

const WA = '59899841325';

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


function httpsImg(url) {
    return (url || '').replace('http://', 'https://');
}

function normalizeImages(item) {
    const urls = [];

    if (Array.isArray(item.pictures)) {
        for (const picture of item.pictures) {
            if (typeof picture === 'string') urls.push(picture);
        }
    }

    if (item.thumbnail) urls.push(item.thumbnail);

    return [...new Set(urls.map(httpsImg).filter(Boolean))].slice(0, 6);
}

function formatCondition(condition) {
    const normalized = String(condition || '').toLowerCase();
    if (normalized === 'new') return 'Nuevo';
    if (normalized === 'used') return 'Usado';
    if (normalized === 'not_specified') return 'No especificada';
    return condition ? String(condition) : null;
}

function isValidDimensionValue(v) {
    if (v == null) return false;
    const s = String(v).trim();
    return s !== '' && s !== '-1' && !s.startsWith('-1 ');
}

function normalizePublisher(publisher) {
    if (!publisher) return null;
    const s = String(publisher).trim();
    if (!s || s.toUpperCase() === 'AMADO LIBROS') return null;
    return s;
}

function formatDimensions(dimensions) {
    if (!dimensions || typeof dimensions !== 'object') return null;

    const rows = [];
    if (isValidDimensionValue(dimensions.width))  rows.push(`Ancho ${dimensions.width}`);
    if (isValidDimensionValue(dimensions.height)) rows.push(`Alto ${dimensions.height}`);
    if (isValidDimensionValue(dimensions.length)) rows.push(`Largo ${dimensions.length}`);
    if (isValidDimensionValue(dimensions.weight)) rows.push(`Peso ${dimensions.weight}`);

    return rows.length ? rows.join(' · ') : null;
}

function detailRow(label, value) {
    if (value == null || value === '') return '';
    return `<div class="detail-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function renderGallery(images, safeTitle) {
    if (!images.length) return '';

    const mainImage = images[0];
    const multi = images.length > 1;
    const imagesJson = JSON.stringify(images).replace(/</g, '\\u003c');

    const thumbsHtml = multi
        ? `<div class="thumbs" role="group" aria-label="Más imágenes del libro">
${images.map((url, i) => `    <button type="button" class="thumb-btn" data-idx="${i}" aria-label="${safeTitle} — imagen ${i + 1}" aria-current="${i === 0 ? 'true' : 'false'}"><img src="${escapeHtml(url)}" alt="${safeTitle} — imagen ${i + 1}" loading="lazy" width="56" height="56"></button>`).join('\n')}
  </div>`
        : '';

    const navBtns = multi
        ? `<button type="button" class="lb-btn lb-prev" aria-label="Imagen anterior">&#8592;</button>
      <button type="button" class="lb-btn lb-next" aria-label="Imagen siguiente">&#8594;</button>`
        : '';

    return `<div class="cover">
  <button type="button" class="cover-btn" id="gMainBtn" data-current-index="0" aria-label="Ampliar imagen de ${safeTitle}">
    <img class="cover-main" id="gMainImg" src="${escapeHtml(mainImage)}" alt="${safeTitle}" loading="eager" width="260" data-title="${safeTitle}">
  </button>
  ${thumbsHtml}
  <div id="glb" class="lb" role="dialog" aria-modal="true" aria-label="Galería de imágenes" tabindex="-1" hidden>
    <div class="lb-inner">
      <button type="button" class="lb-close" id="glbClose" aria-label="Cerrar galería">&#10005;</button>
      <img class="lb-img" id="glbImg" src="${escapeHtml(mainImage)}" alt="${safeTitle}" loading="eager">
      <p class="lb-counter" id="glbCounter" aria-live="polite" aria-atomic="true">Imagen 1 de ${images.length}</p>
      <div class="lb-nav">${navBtns}</div>
    </div>
  </div>
</div>
<script>(function(){
  var imgs=${imagesJson},n=imgs.length,cur=0,opener=null;
  var lb=document.getElementById('glb');
  var lbImg=document.getElementById('glbImg');
  var lbCtr=document.getElementById('glbCounter');
  var mainBtn=document.getElementById('gMainBtn');
  var mainImg=document.getElementById('gMainImg');
  var title=mainImg.getAttribute('data-title')||'';
  lbImg.setAttribute('data-title',title);
  var thumbBtns=[].slice.call(document.querySelectorAll('.thumb-btn'));

  function selectThumb(idx){
    cur=idx;
    mainImg.src=imgs[idx];
    mainImg.alt=title+' — imagen '+(idx+1);
    mainBtn.setAttribute('data-current-index',String(idx));
    thumbBtns.forEach(function(b,i){b.setAttribute('aria-current',i===idx?'true':'false');});
  }

  function openLb(idx,trigger){
    cur=idx;opener=trigger||mainBtn;
    lb.removeAttribute('hidden');
    document.body.style.overflow='hidden';
    updateLb();lb.focus();
  }

  function closeLb(){
    lb.setAttribute('hidden','');
    document.body.style.overflow='';
    if(opener){opener.focus();opener=null;}
  }

  function updateLb(){
    lbImg.src=imgs[cur];
    lbImg.alt=title+' — imagen '+(cur+1);
    if(lbCtr)lbCtr.textContent='Imagen '+(cur+1)+' de '+n;
  }

  function prev(){cur=(cur-1+n)%n;updateLb();}
  function next(){cur=(cur+1)%n;updateLb();}

  mainBtn.addEventListener('click',function(){
    openLb(parseInt(mainBtn.getAttribute('data-current-index')||'0',10),mainBtn);
  });
  thumbBtns.forEach(function(btn,i){
    btn.addEventListener('click',function(){selectThumb(i);});
  });
  document.getElementById('glbClose').addEventListener('click',closeLb);
  lb.addEventListener('click',function(e){if(e.target===lb)closeLb();});
  var pB=document.querySelector('.lb-prev');
  var nB=document.querySelector('.lb-next');
  if(pB)pB.addEventListener('click',prev);
  if(nB)nB.addEventListener('click',next);
  document.addEventListener('keydown',function(e){
    if(lb.hasAttribute('hidden'))return;
    if(e.key==='Escape')closeLb();
    if(e.key==='ArrowLeft')prev();
    if(e.key==='ArrowRight')next();
  });
})();<\/script>`;
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

function renderPage(item, slug, isPreview) {
    const canonicalUrl = `${BASE}/libro/${item.id}/${slug}`;
    const safeTitle    = escapeHtml(item.title);
    const safeAuthor   = item.author ? escapeHtml(item.author) : null;
    const images       = normalizeImages(item);
    const img          = images[0] || '';
    const price         = Number(item.price) || 0;
    const priceUY       = price.toLocaleString('es-UY');
    const transferPrice = Math.round(price * 0.88).toLocaleString('es-UY');
    const installment   = Math.round(price / 12).toLocaleString('es-UY');
    const stockQty      = Number(item.available_quantity) || 0;
    const inStock       = stockQty > 0;
    const condition     = formatCondition(item.condition);
    const dimensions    = formatDimensions(item.dimensions);
    const waMsg         = encodeURIComponent(`Hola! Me interesa: ${item.title}`);

    const detailRows = [
        safeAuthor ? detailRow('Autor', item.author) : '',
        detailRow('ISBN', item.isbn),
        detailRow('Editorial', normalizePublisher(item.publisher)),
        item.pages ? detailRow('Páginas', `${item.pages}`) : '',
        detailRow('Medidas', dimensions),
        detailRow('Condición', condition),
        detailRow('Stock', inStock ? `${stockQty} disponible${stockQty === 1 ? '' : 's'}` : 'Consultar disponibilidad'),
    ].filter(Boolean).join('\n');

    const metaDesc = safeAuthor
        ? `Comprá &quot;${safeTitle}&quot; de ${safeAuthor} en Amado Libros. Transferencia: $${transferPrice} UYU, 12% de descuento. Envíos a todo Uruguay.`
        : `Comprá &quot;${safeTitle}&quot; en Amado Libros. Transferencia: $${transferPrice} UYU, 12% de descuento. Envíos a todo Uruguay.`;

    // JSON-LD — generado con JSON.stringify, nunca concatenación
    const schemaProduct = {
        '@context': 'https://schema.org',
        '@type':    ['Product', 'Book'],
        'name':     item.title,
        'image':    images.length ? images : img,
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
    if (item.isbn) {
        schemaProduct.isbn = String(item.isbn);
    }
    const realPublisher = normalizePublisher(item.publisher);
    if (realPublisher) {
        schemaProduct.publisher = { '@type': 'Organization', 'name': realPublisher };
    }
    if (item.pages) {
        schemaProduct.numberOfPages = Number(item.pages);
    }
    if (item.condition === 'new') {
        schemaProduct.offers.itemCondition = 'https://schema.org/NewCondition';
    } else if (item.condition === 'used') {
        schemaProduct.offers.itemCondition = 'https://schema.org/UsedCondition';
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
  <meta name="robots" content="${isPreview ? 'noindex' : 'index, follow'}">
  <link rel="canonical" href="${canonicalUrl}">

  <meta property="og:type"        content="product">
  <meta property="og:url"         content="${canonicalUrl}">
  <meta property="og:title"       content="${safeTitle} | Amado Libros">
  <meta property="og:description" content="${metaDesc}">
  <meta property="og:image"       content="${escapeHtml(img)}">
  <meta property="og:locale"      content="es_UY">
  <meta property="og:site_name"   content="Amado Libros">

  <meta name="twitter:card"        content="summary_large_image">
  <meta name="twitter:title"       content="${safeTitle} | Amado Libros">
  <meta name="twitter:description" content="${metaDesc}">
  <meta name="twitter:image"       content="${escapeHtml(img)}">

  <script type="application/ld+json">${JSON.stringify(schemaProduct)}</script>
  <script type="application/ld+json">${JSON.stringify(schemaBreadcrumb)}</script>
  <script src="/cart.js" defer></script>

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
    main{max-width:860px;margin:1.5rem auto;padding:0 1rem;
         display:grid;grid-template-columns:1fr;gap:1.75rem}
    @media(min-width:640px){main{grid-template-columns:280px 1fr}}
    .cover-main{width:100%;max-width:260px;border-radius:.5rem;
                box-shadow:0 4px 20px rgba(0,0,0,.12);display:block;background:white}
    .cover-btn{background:none;border:none;padding:0;cursor:pointer;display:block;width:100%;text-align:left}
    .cover-btn:focus-visible{outline:2px solid #3b82f6;outline-offset:2px;border-radius:.5rem}
    .thumbs{display:flex;flex-wrap:wrap;gap:.45rem;margin-top:.75rem;max-width:260px}
    .thumb-btn{background:none;border:1px solid #e2e8f0;border-radius:.35rem;padding:0;cursor:pointer;overflow:hidden;width:56px;height:56px;flex-shrink:0}
    .thumb-btn[aria-current="true"]{border:2px solid #3b82f6}
    .thumb-btn:focus-visible{outline:2px solid #3b82f6;outline-offset:2px}
    .thumb-btn img{width:56px;height:56px;object-fit:cover;display:block;background:white}
    .lb{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.88);display:flex;align-items:center;justify-content:center;padding:1rem}
    .lb[hidden]{display:none}
    @media(prefers-reduced-motion:no-preference){.lb{animation:_lbi .15s ease}@keyframes _lbi{from{opacity:0}to{opacity:1}}}
    .lb-inner{position:relative;max-width:min(90vw,860px);width:100%;display:flex;flex-direction:column;align-items:center;gap:.75rem}
    .lb-img{max-width:100%;max-height:75vh;object-fit:contain;border-radius:.35rem;display:block}
    .lb-counter{color:rgba(255,255,255,.75);font-size:.82rem}
    .lb-nav{display:flex;align-items:center;gap:.75rem;min-height:44px}
    .lb-btn{background:rgba(255,255,255,.15);border:none;color:white;border-radius:.5rem;cursor:pointer;min-width:44px;height:44px;font-size:1.25rem;display:flex;align-items:center;justify-content:center;padding:0 .75rem}
    .lb-btn:hover{background:rgba(255,255,255,.25)}
    .lb-btn:focus-visible{outline:2px solid white;outline-offset:2px}
    .lb-close{position:absolute;top:-.5rem;right:-.5rem;background:rgba(0,0,0,.6);border:none;color:white;border-radius:50%;cursor:pointer;width:44px;height:44px;font-size:1rem;display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .lb-close:hover{background:rgba(0,0,0,.85)}
    .lb-close:focus-visible{outline:2px solid white;outline-offset:2px}
    @media(max-width:480px){.lb-img{max-height:60vh}}
    .info h1{font-size:1.25rem;font-weight:700;line-height:1.35;
             margin-bottom:.75rem;color:#0f172a}
    .meta{font-size:.875rem;color:#475569;margin-bottom:.4rem}
    .meta strong{color:#1e293b}
    .badge{display:inline-block;padding:.2rem .7rem;border-radius:2rem;
           font-size:.75rem;font-weight:600;margin-bottom:.875rem}
    .in-stock{background:#dcfce7;color:#16a34a}
    .out-of-stock{background:#fef9c3;color:#854d0e}
    .details{background:white;border:1px solid #e2e8f0;border-radius:.5rem;
             margin:.25rem 0 .875rem;overflow:hidden}
    .detail-row{display:grid;grid-template-columns:94px 1fr;gap:.75rem;
                padding:.55rem .75rem;border-bottom:1px solid #f1f5f9;font-size:.84rem}
    .detail-row:last-child{border-bottom:0}
    .detail-row dt{font-weight:700;color:#334155}
    .detail-row dd{color:#475569}
    .price-box{background:#f5f3ff;border:1px solid #ddd6fe;border-radius:.5rem;
               padding:1rem 1.25rem;margin:.875rem 0}
    .price-transfer,.price-base,.price-installment{font-size:1rem;font-weight:700;line-height:1.35}
    .price-transfer{color:#0f172a}
    .price-base,.price-installment{color:#374151;margin-top:.15rem}
    .cta{display:flex;flex-direction:column;gap:.75rem;margin-top:1rem}
    .btn{display:block;padding:.875rem 1.25rem;border-radius:.5rem;font-size:.95rem;
         font-weight:700;text-align:center;text-decoration:none;transition:opacity .15s}
    .btn:hover{opacity:.85}
    .btn-ml{background:#ffe600;color:#1e293b}
    .btn-wa{background:#25d366;color:white}
    .btn-cart{background:#e49982;color:#fff;border:none;font-family:inherit;
              cursor:pointer;width:100%}
    .btn-cart:disabled{opacity:.7;cursor:default}
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
  ${renderGallery(images, safeTitle)}
  <div class="info">
    <h1>${safeTitle}</h1>
    <span class="badge ${inStock ? 'in-stock' : 'out-of-stock'}">
      ${inStock ? '✓ En stock' : '⏳ Por encargo'}
    </span>
    ${detailRows ? `<dl class="details">${detailRows}</dl>` : ''}
    <div class="price-box">
      <div class="price-transfer"><span class="price-label">Transferencia -12%:</span> $${transferPrice} UYU</div>
      <div class="price-base">Precio: $${priceUY} UYU</div>
      <div class="price-installment">12 cuotas de aprox. $${installment} UYU</div>
    </div>
    <div class="cta">
      <button
        type="button"
        class="btn btn-cart"
        data-action="add-to-cart"
        data-id="${escapeHtml(item.id)}"
        data-title="${escapeHtml(item.title)}"
        data-price="${price}"
        data-thumbnail="${escapeHtml(images[0] || '')}"
      >
        <span data-cart-label>🛒 Agregar al carrito</span>
      </button>
      <a class="btn btn-ml" href="${escapeHtml(item.permalink)}" target="_blank" rel="noopener noreferrer">
        🛒 Comprar en MercadoLibre
      </a>
      <a class="btn btn-wa" href="https://wa.me/${WA}?text=${waMsg}" target="_blank" rel="noopener noreferrer">
        💬 Consultar por WhatsApp
      </a>
    </div>
    <p class="shipping">🚚 Entrega en 2 horas en Montevideo · Envíos a todo Uruguay · Envío gratis desde $1.500. <a href="/politicas#envios">Ver política de envíos</a>.</p>
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

    const host      = new URL(context.request.url).hostname;
    const isPreview = host !== 'www.amadolibros.com';

    return new Response(renderPage(item, slug, isPreview), {
        headers: {
            'content-type':  'text/html;charset=UTF-8',
            'cache-control': 'public, max-age=3600',
        },
    });
}
