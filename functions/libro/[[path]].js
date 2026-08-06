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
import { BASE, fetchCatalog, fetchPausedItem } from '../_shared/catalog.js';

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

function buildPausedWaMessage(item) {
    let msg = `Hola, me interesa conseguir “${item.title}”`;
    if (item.author) msg += `, de ${item.author}`;
    if (item.isbn) msg += ` (${item.isbn})`;
    msg += '. ¿Podrían buscarlo por encargo?';
    return msg;
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

export function renderPage(item, slug, isPreview, waitlistSiteKey) {
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
    const inStock       = item.status === 'active' && stockQty > 0;
    const condition     = formatCondition(item.condition);
    const dimensions    = formatDimensions(item.dimensions);
    const waMsg         = encodeURIComponent(
        inStock
            ? `Hola! Me interesa: ${item.title}`
            : buildPausedWaMessage(item)
    );

    const detailRows = [
        safeAuthor ? detailRow('Autor', item.author) : '',
        detailRow('ISBN', item.isbn),
        detailRow('Editorial', normalizePublisher(item.publisher)),
        item.pages ? detailRow('Páginas', `${item.pages}`) : '',
        detailRow('Medidas', dimensions),
        detailRow('Condición', condition),
        // CF-STOCK-1-UX-FIX: la fila "Disponibilidad" solo tiene sentido
        // cuando hay stock que mostrar. Para no disponibles, la jerarquía
        // comercial (ver más abajo) ya cubre el mensaje — repetirlo acá
        // sería la tercera vez que la ficha dice "no disponible".
        inStock
            ? detailRow('Disponibilidad', `${stockQty} disponible${stockQty === 1 ? '' : 's'}`)
            : '',
    ].filter(Boolean).join('\n');

    const metaDesc = inStock
        ? (safeAuthor
            ? `Comprá &quot;${safeTitle}&quot; de ${safeAuthor} en Amado Libros. Transferencia: $${transferPrice} UYU. Envíos a todo Uruguay.`
            : `Comprá &quot;${safeTitle}&quot; en Amado Libros. Transferencia: $${transferPrice} UYU. Envíos a todo Uruguay.`)
        : `Pedí un aviso cuando &quot;${safeTitle}&quot; vuelva a estar disponible en Amado Libros. También podemos buscarlo por encargo.`;

    // JSON-LD — generado con JSON.stringify, nunca concatenación
    const schemaProduct = {
        '@context': 'https://schema.org',
        '@type':    ['Product', 'Book'],
        'name':     item.title,
        'image':    images.length ? images : img,
        'description': item.author ? `${item.title} — ${item.author}` : item.title,
        'sku':      item.id,
    };
    if (inStock) {
        schemaProduct.offers = {
            '@type':        'Offer',
            'url':          canonicalUrl,
            'priceCurrency':'UYU',
            'price':        String(price),
            'availability': 'https://schema.org/InStock',
            'seller': { '@type': 'Organization', 'name': 'Amado Libros' },
        };
    }
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
    if (schemaProduct.offers && item.condition === 'new') {
        schemaProduct.offers.itemCondition = 'https://schema.org/NewCondition';
    } else if (schemaProduct.offers && item.condition === 'used') {
        schemaProduct.offers.itemCondition = 'https://schema.org/UsedCondition';
    }

    const priceHtml = inStock
        ? `<div class="price-box">
      <div class="price-main"><span class="price-label">Precio web/tarjeta:</span> $${priceUY} UYU</div>
      <div class="price-installment">Hasta 12 cuotas de aprox. $${installment} UYU</div>
      <div class="price-transfer">Transferencia: $${transferPrice} UYU</div>
    </div>`
        : `<div class="order-box">
      <strong>¿Buscás este libro?</strong>
      <span>Podemos intentar conseguirlo por encargo. Consultanos y verificamos disponibilidad, edición y precio.</span>
    </div>`;

    const actionHtml = inStock
        ? `<button
        type="button"
        class="btn btn-cart"
        data-action="add-to-cart"
        data-id="${escapeHtml(item.id)}"
        data-title="${escapeHtml(item.title)}"
        data-price="${price}"
        data-thumbnail="${escapeHtml(images[0] || '')}"
        data-max-qty="${stockQty}"
      >
        <span data-cart-label>🛒 Agregar al carrito</span>
      </button>
      <a class="btn btn-wa" href="https://wa.me/${WA}?text=${waMsg}" target="_blank" rel="noopener noreferrer">
        💬 Consultar por WhatsApp
      </a>
      <a class="btn btn-ml" href="${escapeHtml(item.permalink)}" target="_blank" rel="noopener noreferrer">
        Comprar en MercadoLibre
      </a>`
        : `<a class="btn btn-wa" href="https://wa.me/${WA}?text=${waMsg}" target="_blank" rel="noopener noreferrer">
        Consultar si podemos conseguirlo
      </a>
      ${waitlistSiteKey ? `<form class="waitlist-form" id="aviso-stock" novalidate>
        <label for="waitlist-email">O dejanos tu correo y te avisamos si vuelve</label>
        <div class="waitlist-row">
          <input id="waitlist-email" name="email" type="email" inputmode="email"
                 autocomplete="email" maxlength="254" required
                 placeholder="tu@email.com">
          <button class="btn btn-waitlist" type="submit">Avisame cuando llegue</button>
        </div>
        <div class="waitlist-hp" aria-hidden="true">
          <label>Empresa <input name="company" type="text" tabindex="-1" autocomplete="off"></label>
        </div>
        <div class="cf-turnstile" data-sitekey="${escapeHtml(waitlistSiteKey)}"
             data-action="stock_waitlist" data-theme="light"></div>
        <p class="waitlist-status" id="waitlist-status" role="status" aria-live="polite"></p>
      </form>` : ''}`;

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
  <meta name="robots" content="${isPreview || !inStock ? 'noindex, follow' : 'index, follow'}">
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
    .product-header{background:#1e293b;color:white;padding:.65rem 1.25rem;
                    position:sticky;top:0;z-index:50;
                    box-shadow:0 2px 10px rgba(15,23,42,.18)}
    .header-inner{width:100%;max-width:1180px;margin:0 auto;display:grid;
                  grid-template-columns:auto minmax(260px,680px) auto;
                  align-items:center;gap:1rem}
    .brand-link{display:flex;align-items:center;gap:.65rem;min-width:max-content;
                color:white;text-decoration:none}
    .brand-logo{width:44px;height:44px;display:block;object-fit:cover;
                border-radius:50%;background:#fff;flex-shrink:0}
    .brand-copy{display:flex;flex-direction:column;line-height:1.15}
    .brand-name{font-size:1.05rem;font-weight:800;color:#fff}
    .brand-tagline{color:#94a3b8;font-size:.72rem;margin-top:.2rem}
    .header-search{width:100%;height:44px;display:flex;align-items:stretch;
                   background:#fff;border:1px solid rgba(255,255,255,.2);
                   border-radius:999px;overflow:hidden;box-shadow:0 2px 8px rgba(15,23,42,.16)}
    .header-search:focus-within{outline:3px solid rgba(228,153,130,.45);outline-offset:2px}
    .header-search input{min-width:0;flex:1;border:0;background:#fff;color:#1e293b;
                         padding:0 .25rem 0 1rem;font:inherit;font-size:.9rem;outline:0}
    .header-search input::placeholder{color:#64748b}
    .header-search button{min-width:88px;border:0;background:#e49982;color:#fff;
                          padding:0 1rem;font:inherit;font-size:.85rem;font-weight:800;
                          cursor:pointer}
    .header-search button:hover{background:#d98972}
    .header-search button:focus-visible{outline:3px solid #fff;outline-offset:-4px}
    .ssr-cart-link{position:relative;display:inline-flex;align-items:center;justify-content:center;
                   min-width:44px;min-height:44px;padding:.4rem .6rem;
                   color:rgba(255,255,255,.75);border:1px solid rgba(255,255,255,.18);
                   border-radius:999px;background:rgba(255,255,255,.08);
                   text-decoration:none;flex-shrink:0;
                   transition:background .15s,border-color .15s,color .15s}
    .ssr-cart-link:hover{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.28);color:#fff}
    .ssr-cart-badge{position:absolute;top:-5px;right:-5px;min-width:17px;height:17px;
                    padding:0 4px;border-radius:999px;background:#e49982;color:#fff;
                    font-size:.625rem;font-weight:700;line-height:17px;
                    text-align:center;pointer-events:none}
    @media(max-width:760px){
      .product-header{padding:.55rem .85rem}
      .header-inner{grid-template-columns:minmax(0,1fr) auto;gap:.55rem .75rem}
      .brand-logo{width:38px;height:38px}
      .brand-name{font-size:1rem}
      .brand-tagline{display:none}
      .header-search{grid-column:1/-1;height:42px}
      .header-search input{font-size:.86rem;padding-left:.9rem}
      .header-search button{min-width:76px;padding:0 .8rem;font-size:.8rem}
    }
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
    .details{background:white;border:1px solid #e2e8f0;border-radius:.5rem;
             margin:.25rem 0 .875rem;overflow:hidden}
    .detail-row{display:grid;grid-template-columns:94px 1fr;gap:.75rem;
                padding:.55rem .75rem;border-bottom:1px solid #f1f5f9;font-size:.84rem}
    .detail-row:last-child{border-bottom:0}
    .detail-row dt{font-weight:700;color:#334155}
    .detail-row dd{color:#475569}
    .price-box{background:#f5f3ff;border:1px solid #ddd6fe;border-radius:.5rem;
               padding:1rem 1.25rem;margin:.875rem 0}
    .price-main{font-size:1.35rem;font-weight:800;color:#0f172a;line-height:1.3}
    .price-label{font-weight:800}
    .price-installment{font-size:1rem;font-weight:600;color:#374151;margin-top:.35rem}
    .price-transfer{font-size:.85rem;font-weight:600;color:#a94e3d;margin-top:.35rem}
    .order-box{display:flex;flex-direction:column;gap:.25rem;background:#fff7e8;
               border:1px solid #efd2a6;border-radius:.5rem;padding:1rem 1.25rem;
               margin:.875rem 0;color:#6b4218}
    .order-box strong{text-transform:uppercase;letter-spacing:.05em;font-size:.82rem}
    .order-box span{font-weight:700;color:#3f2b17}
    .order-box small{font-size:.78rem;color:#7c6b59}
    .cta{display:flex;flex-direction:column;gap:.75rem;margin-top:1rem}
    .btn{display:block;padding:.875rem 1.25rem;border-radius:.5rem;font-size:.95rem;
         font-weight:700;text-align:center;text-decoration:none;transition:opacity .15s}
    .btn:hover{opacity:.85}
    .btn-wa{background:#25d366;color:white}
    .btn-cart{background:#e49982;color:#fff;border:none;font-family:inherit;
              cursor:pointer;width:100%}
    .btn-cart:disabled{opacity:.7;cursor:default}
    /* AL-WEB: Mercado Libre queda tercero y subordinado — sin relleno
       amarillo dominante, fuente más chica y peso menor que carrito/WhatsApp.
       Sigue siendo un enlace funcional, solo pierde peso visual. */
    .btn-ml{background:#fff;color:#7a6a1f;border:1.5px solid #e8dfa0;
            font-size:.82rem;font-weight:600;padding:.65rem 1.25rem}
    .btn-ml:hover{background:#fdf9e8;opacity:1}
    .waitlist-form{background:#fff;border:1px solid #d8d1c7;border-radius:.65rem;
                   padding:1rem;scroll-margin-top:1rem}
    .waitlist-form label{display:block;font-size:.82rem;font-weight:700;color:#334155;
                         margin-bottom:.35rem}
    .waitlist-row{display:flex;gap:.55rem;align-items:stretch}
    .waitlist-row input{min-width:0;flex:1;border:1px solid #cbd5e1;border-radius:.5rem;
                        padding:.75rem;font:inherit;color:#1e293b}
    .waitlist-row input:focus{outline:2px solid #a94e3d;outline-offset:1px}
    .btn-waitlist{background:#a94e3d;color:#fff;border:0;font-family:inherit;
                  cursor:pointer;white-space:nowrap;padding:.75rem 1rem}
    .btn-waitlist:disabled{opacity:.65;cursor:wait}
    .waitlist-hp{position:absolute!important;left:-10000px!important;width:1px!important;
                 height:1px!important;overflow:hidden!important}
    .cf-turnstile{margin-top:.75rem;min-height:65px}
    .waitlist-status{font-size:.84rem;color:#475569;margin-top:.45rem;min-height:1.3em}
    .waitlist-status.is-error{color:#b42318}
    .waitlist-status.is-ok{color:#16733a;font-weight:700}
    .waitlist-unavailable{font-size:.85rem;color:#64748b}
    @media(max-width:520px){.waitlist-row{flex-direction:column}.btn-waitlist{width:100%}}
    .shipping{font-size:.82rem;color:#64748b;margin-top:1rem;padding:.75rem 1rem;
              background:white;border:1px solid #e2e8f0;border-radius:.5rem}
    footer{background:#1e293b;color:#94a3b8;text-align:center;
           font-size:.8rem;padding:1.5rem;margin-top:2.5rem}
    footer a{color:#cbd5e1;text-decoration:none}
  </style>
</head>
<body>

<header class="product-header">
  <div class="header-inner">
    <a href="/" class="brand-link" aria-label="Amado Libros — ir al inicio">
      <img src="/images/logo-amado.webp" alt="" class="brand-logo" width="44" height="44" fetchpriority="high">
      <span class="brand-copy">
        <span class="brand-name">AMADO LIBROS</span>
        <span class="brand-tagline">Tu librería para libros difíciles de ubicar</span>
      </span>
    </a>
    <form class="header-search" action="/catalogo" method="get" role="search">
      <input type="search" name="q" placeholder="Buscar por título, autor, temática o ISBN"
             aria-label="Buscar por título, autor, temática o ISBN" autocomplete="off">
      <button type="submit" aria-label="Buscar libros">Buscar</button>
    </form>
    <a href="/carrito" id="ssr-cart-link" class="ssr-cart-link" aria-label="Ver carrito">
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
        <path d="M1 1h4l2.68 13.39a2 2 0 001.98 1.61h9.72a2 2 0 001.98-1.61L23 6H6"/>
      </svg>
      <span id="ssr-cart-badge" class="ssr-cart-badge" hidden aria-hidden="true">0</span>
    </a>
  </div>
</header>

<nav>
  <a href="/">Inicio</a> ›
  <span>${safeTitle.substring(0, 70)}${item.title.length > 70 ? '…' : ''}</span>
</nav>

<main>
  ${renderGallery(images, safeTitle)}
  <div class="info">
    <h1>${safeTitle}</h1>
    ${inStock ? `<span class="badge in-stock">✓ En stock</span>` : ''}
    ${inStock && detailRows ? `<dl class="details">${detailRows}</dl>` : ''}
    ${priceHtml}
    <div class="cta">
      ${actionHtml}
    </div>
    ${!inStock && detailRows ? `<dl class="details">${detailRows}</dl>` : ''}
    <p class="shipping">${inStock
      ? '🚚 Entrega en 2 horas en Montevideo · Envíos a todo Uruguay · Envío gratis desde $2.000.'
      : '🌎 Si preferís no esperar, también podemos buscarlo por encargo en el exterior.'
    } <a href="/politicas#envios">Ver política de envíos</a>.</p>
  </div>
</main>

<footer>
  &copy; 2026 Amado Libros. Todos los derechos reservados. ·
  <a href="/">Catálogo</a> ·
  <a href="/politicas">Políticas</a>
</footer>

<script>(function(){
  function updateBadge(n){
    var badge=document.getElementById('ssr-cart-badge');
    var link=document.getElementById('ssr-cart-link');
    if(!badge||!link)return;
    if(n>0){
      badge.textContent=n>99?'99+':String(n);
      badge.hidden=false;
      link.setAttribute('aria-label','Ver carrito ('+(n===1?'1 artículo':n+' artículos')+')');
    }else{
      badge.hidden=true;
      link.setAttribute('aria-label','Ver carrito');
    }
  }
  document.addEventListener('DOMContentLoaded',function(){
    if(window.AmadoCart)updateBadge(window.AmadoCart.count());
    document.addEventListener('amado:cart-updated',function(e){
      var items=e.detail&&Array.isArray(e.detail.items)?e.detail.items:[];
      updateBadge(items.reduce(function(s,i){return s+(i.quantity||0);},0));
    });
  });
}());<\/script>
${!inStock && waitlistSiteKey ? `
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer><\/script>
<script>(function(){
  var form=document.getElementById('aviso-stock');
  if(!form)return;
  var status=document.getElementById('waitlist-status');
  var button=form.querySelector('button[type="submit"]');
  function show(message,kind){
    status.textContent=message;
    status.className='waitlist-status '+(kind||'');
  }
  form.addEventListener('submit',async function(event){
    event.preventDefault();
    var email=form.elements.email.value.trim();
    var tokenInput=form.querySelector('input[name="cf-turnstile-response"]');
    var token=tokenInput?tokenInput.value:'';
    if(!email){show('Ingresá tu correo.','is-error');form.elements.email.focus();return;}
    if(!token){show('Completá la verificación antes de continuar.','is-error');return;}
    button.disabled=true;
    button.textContent='Guardando…';
    show('','');
    try{
      var response=await fetch('/api/stock-waitlist',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          product_id:${JSON.stringify(item.id)},
          email:email,
          company:form.elements.company.value,
          source_path:window.location.pathname,
          cf_turnstile_response:token
        })
      });
      var data={};
      try{data=await response.json();}catch(_error){}
      if(!response.ok)throw new Error(data.error||'No pudimos guardar el aviso.');
      show(data.already_registered
        ? 'Ya teníamos registrado este correo para este libro.'
        : 'Pronto. Te avisaremos cuando vuelva a estar disponible.','is-ok');
      form.elements.email.value='';
    }catch(error){
      show(error&&error.message?error.message:'No pudimos guardar el aviso. Intentá nuevamente.','is-error');
    }finally{
      button.disabled=false;
      button.textContent='Avisame cuando llegue';
      if(window.turnstile)window.turnstile.reset();
    }
  });
}());<\/script>` : ''}

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
    const activeCatalogAvailable = catalog && Array.isArray(catalog.items);
    let item = activeCatalogAvailable
        ? catalog.items.find(b => b.id === id)
        : null;
    // CF-R2-2-BRIDGE: habilitado en Preview y producción — cada uno resuelve
    // contra su propio manifest (fetchPausedItem -> manifestUrlFor en
    // _shared/catalog.js). Si el manifest de ese entorno falta o es
    // inválido, fetchPausedItem devuelve null y el flujo sigue igual que
    // hoy (notFound), sin 500.
    if (!item && ['preview', 'production'].includes(context.env?.APP_ENV)) {
        item = await fetchPausedItem(context, id);
    }
    if (!item && !activeCatalogAvailable) {
        return new Response('Error al cargar el catálogo. Intentá de nuevo en unos segundos.', {
            status: 503,
            headers: { 'content-type': 'text/plain;charset=UTF-8' },
        });
    }
    if (!item) return notFound();

    const slug = slugify(item.title);
    const isPreview = context.env?.APP_ENV === 'preview';
    const navigationBase = isPreview
        ? new URL(context.request.url).origin
        : BASE;

    // Redirect 301 si no viene el slug
    if (!providedSlug) {
        return Response.redirect(`${navigationBase}/libro/${id}/${slug}`, 301);
    }

    const waitlistSiteKey = typeof context.env?.STOCK_WAITLIST_TURNSTILE_SITE_KEY === 'string'
        ? context.env.STOCK_WAITLIST_TURNSTILE_SITE_KEY.trim()
        : '';

    return new Response(renderPage(item, slug, isPreview, waitlistSiteKey), {
        headers: {
            'content-type':  'text/html;charset=UTF-8',
            'cache-control': 'public, max-age=3600',
        },
    });
}
