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
// FICHAS-QUALITY-GUARD-1: fuente única sobre autoría genérica/ausente.
import { isGenericAuthor, realAuthor, stripGenericAuthorMention } from '../_shared/generic-author.js';
import { BASE, fetchCatalog, fetchPausedItem } from '../_shared/catalog.js';
import { applyBookEnrichment } from '../_shared/book-enrichment-registry.js';
import { previewCoverUrl as resolvePreviewCoverUrl } from '../_shared/preview-cover.js';
import { authorPathForName } from '../_shared/seo-authors.js';
import { PRODUCT_ID_REDIRECTS, PRODUCT_SEO_OVERRIDES } from '../_shared/seo-products.js';
import {
    bookCoverUrl,
    cloudflareImageUrl,
    PRODUCT_IMAGE_SIZES,
    responsiveImage,
} from '../_shared/cloudflare-images.js';
import {
    ensurePerf,
    perfNow,
    perfSummary,
    recordPerf,
    serverTimingValue,
} from '../_shared/perf.js';
// GLOBAL-SHELL-1: shell global compartido con Astro (marca, favicon, footer
// y burbuja de WhatsApp). Ver functions/_shared/brand.js.
import {
    faviconHeadHtml,
    footerHtml,
    FOOTER_STYLES,
    waFloatHtml,
    WA_FLOAT_STYLES,
} from '../_shared/brand.js';
import {
    buildBookWhatsAppMessage,
    whatsappHref,
} from '../../shared/whatsapp-messages.js';
import { isPausedProductInSeoCohort } from '../_shared/paused-seo-cohort.js';

const FREE_SHIPPING_THRESHOLD_UYU = 1500;

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

function safeJson(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}


function httpsImg(url) {
    return (url || '')
        .replace('http://', 'https://')
        .replace(/-I\.(jpg|jpeg|png|webp)(?=($|\?))/i, '-O.$1');
}

export function normalizeImages(item, previewCoverSrc = '') {
    const NON_BOOK_IMAGE_ASSETS = new Set([
        'D_768794-MLU78243849622_082024-O.jpg',
        'D_823347-MLU78243898758_082024-O.jpg',
    ]);
    const pictures = [];

    if (Array.isArray(item.pictures)) {
        for (const picture of item.pictures) {
            if (typeof picture !== 'string') continue;
            const normalized = httpsImg(picture);
            const asset = normalized.split('/').pop()?.split('?')[0] || '';
            if (!NON_BOOK_IMAGE_ASSETS.has(asset)) pictures.push(normalized);
        }
    }

    // `thumbnail` es una versión -I de la primera portada y no una foto
    // adicional. Solo se usa como fallback si ML no entregó pictures[].
    if (pictures.length === 0 && item.thumbnail) pictures.push(httpsImg(item.thumbnail));
    // Mercado Libre suele entregar menos, pero se preserva la galería oficial
    // completa con una guarda amplia y coherente con el proxy 0..15.
    const normalized = [...new Set(pictures.filter(Boolean))].slice(0, 16);
    if (previewCoverSrc && normalized.length > 0) normalized[0] = previewCoverSrc;
    if (previewCoverSrc && normalized.length === 0) normalized.push(previewCoverSrc);
    return normalized;
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

    const displayImages = images.map(source => {
        const main = responsiveImage(source, {
            widths: [320, 480, 768, 1024],
            defaultWidth: 480,
            sizes: PRODUCT_IMAGE_SIZES,
        });
        return {
            src: main.src,
            srcset: main.srcset,
            sizes: main.sizes,
            thumb: cloudflareImageUrl(source, { width: 96, quality: 82 }),
            lightbox: cloudflareImageUrl(source, { width: 1024, quality: 88 }),
        };
    });
    const mainImage = displayImages[0];
    const multi = images.length > 1;
    const imagesJson = JSON.stringify(displayImages).replace(/</g, '\\u003c');
    const mainResponsiveAttrs = mainImage.srcset
        ? ` srcset="${escapeHtml(mainImage.srcset)}" sizes="${escapeHtml(mainImage.sizes)}"`
        : '';

    const thumbsHtml = multi
        ? `<div class="thumbs" role="group" aria-label="Más imágenes del libro">
${displayImages.map((image, i) => `    <button type="button" class="thumb-btn" data-idx="${i}" aria-label="${safeTitle} — imagen ${i + 1}" aria-current="${i === 0 ? 'true' : 'false'}"><img src="${escapeHtml(image.thumb)}" alt="${safeTitle} — imagen ${i + 1}" loading="lazy" decoding="async" width="56" height="56"></button>`).join('\n')}
  </div>`
        : '';

    const navBtns = multi
        ? `<button type="button" class="lb-btn lb-prev" aria-label="Imagen anterior">&#8592;</button>
      <button type="button" class="lb-btn lb-next" aria-label="Imagen siguiente">&#8594;</button>`
        : '';

    return `<div class="cover">
  <button type="button" class="cover-btn" id="gMainBtn" data-current-index="0" aria-label="Ampliar imagen de ${safeTitle}">
    <img class="cover-main" id="gMainImg" src="${escapeHtml(mainImage.src)}"${mainResponsiveAttrs} alt="${safeTitle}" loading="eager" decoding="async" fetchpriority="high" width="360" height="540" data-title="${safeTitle}">
  </button>
  ${thumbsHtml}
  <div id="glb" class="lb" role="dialog" aria-modal="true" aria-label="Galería de imágenes" tabindex="-1" hidden>
    <div class="lb-inner">
      <button type="button" class="lb-close" id="glbClose" aria-label="Cerrar galería">&#10005;</button>
      <img class="lb-img" id="glbImg" src="${escapeHtml(mainImage.lightbox)}" alt="${safeTitle}" loading="eager" decoding="async">
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
    mainImg.src=imgs[idx].src;
    if(imgs[idx].srcset){
      mainImg.srcset=imgs[idx].srcset;
      mainImg.sizes=imgs[idx].sizes||'';
    }else{
      mainImg.removeAttribute('srcset');
      mainImg.removeAttribute('sizes');
    }
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
    lbImg.src=imgs[cur].lightbox;
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

// FICHAS-QUALITY-GUARD-1: la lista local de autores genéricos se eliminó.
// Ahora se usa isGenericAuthor() de _shared/generic-author.js — una sola lista
// para ficha, relacionados, WhatsApp, JSON-LD y feed.

function authorKey(author) {
    return String(author || '').trim().toLocaleLowerCase('es').replace(/\s+/g, ' ');
}

/**
 * SEO-AUTOR: el catálogo activo ya está en memoria cuando se renderiza una
 * ficha. Reutilizarlo evita otra lectura de R2 y permite crear enlaces HTML
 * rastreables hacia otros títulos del mismo autor.
 */
export function selectRelatedBooks(catalogItems, item, limit = 4) {
    if (!Array.isArray(catalogItems) || !item) return [];

    const currentAuthor = authorKey(item.author);
    const requestedLimit = Math.min(4, Math.max(0, Number(limit) || 0));
    if (!currentAuthor || isGenericAuthor(currentAuthor) || requestedLimit === 0) return [];

    const seen = new Set([String(item.id || '')]);
    const related = [];
    for (const candidate of catalogItems) {
        const candidateId = String(candidate?.id || '');
        if (!candidateId || seen.has(candidateId)) continue;
        if (!candidate?.title || candidate.status !== 'active') continue;
        if ((Number(candidate.available_quantity) || 0) <= 0) continue;
        if (isGenericAuthor(candidate.author)) continue;
        if (authorKey(candidate.author) !== currentAuthor) continue;

        seen.add(candidateId);
        related.push(candidate);
        if (related.length === requestedLimit) break;
    }
    return related;
}

function renderRelatedBooks(relatedBooks, author, useCloudflareImages = true) {
    if (!Array.isArray(relatedBooks) || relatedBooks.length === 0) return '';

    const cards = relatedBooks.map((book) => {
        // FICHAS-QUALITY-GUARD-1: se limpia sólo el fragmento explícito
        // «de <autor genérico>» del texto VISIBLE (título de tarjeta y alt).
        // El título comercial almacenado no se modifica.
        const title = escapeHtml(stripGenericAuthorMention(book.title) || book.title);
        const href = `/libro/${encodeURIComponent(book.id)}/${slugify(book.title)}`;
        const source = useCloudflareImages
            ? bookCoverUrl(book.id)
            : normalizeImages(book)[0] || '';
        const image = responsiveImage(source, {
            widths: [120, 180, 240],
            defaultWidth: 180,
            sizes: '(max-width: 759px) calc(50vw - 40px), 180px',
        });
        const responsiveAttrs = image.srcset
            ? ` srcset="${escapeHtml(image.srcset)}" sizes="${escapeHtml(image.sizes)}"`
            : '';
        return `<li class="related-book">
      <a class="related-book-link" href="${escapeHtml(href)}">
        ${image.src ? `<img class="related-book-cover" src="${escapeHtml(image.src)}"${responsiveAttrs} alt="Portada de ${title}" loading="lazy" width="120" height="180" decoding="async">` : ''}
        <span class="related-book-title">${title}</span>
      </a>
    </li>`;
    }).join('\n');

    // FICHAS-QUALITY-GUARD-1: sin autoría real no se puede decir "Otros libros
    // de X". El bloque conserva su valor de navegación con un heading neutro.
    const realName = realAuthor(author);
    const authorPath = realName ? authorPathForName(realName) : null;
    const heading = !realName
        ? 'Libros relacionados'
        : authorPath
            ? `Otros libros de <a href="${escapeHtml(authorPath)}">${escapeHtml(realName)}</a>`
            : `Otros libros de ${escapeHtml(realName)}`;
    return `<section class="related-books" aria-labelledby="related-books-title">
    <h2 id="related-books-title">${heading}</h2>
    <ul class="related-books-grid">${cards}</ul>
  </section>`;
}

function renderEditorialEnrichment(editorial) {
    if (!editorial || typeof editorial !== 'object') return '';
    const paragraphs = Array.isArray(editorial.paragraphs)
        ? editorial.paragraphs.map(value => String(value || '').trim()).filter(Boolean)
        : [];
    if (!paragraphs.length || !editorial.heading) return '';

    const highlights = Array.isArray(editorial.highlights)
        ? editorial.highlights.map(value => String(value || '').trim()).filter(Boolean)
        : [];
    const links = Array.isArray(editorial.links)
        ? editorial.links.filter(link =>
            link && typeof link.href === 'string' && link.href.startsWith('/') && link.label
          )
        : [];

    return `<section class="editorial-enrichment" aria-labelledby="editorial-enrichment-heading">
      ${editorial.eyebrow ? `<p class="editorial-eyebrow">${escapeHtml(editorial.eyebrow)}</p>` : ''}
      <h2 id="editorial-enrichment-heading">${escapeHtml(editorial.heading)}</h2>
      ${paragraphs.map(paragraph => `<p>${escapeHtml(paragraph)}</p>`).join('\n')}
      ${highlights.length ? `<h3>${escapeHtml(editorial.highlights_heading || 'Características comprobadas')}</h3>
      <ul>${highlights.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul>` : ''}
      ${editorial.decision_heading && editorial.decision_copy ? `<div class="editorial-decision">
        <h3>${escapeHtml(editorial.decision_heading)}</h3>
        <p>${escapeHtml(editorial.decision_copy)}</p>
      </div>` : ''}
      ${links.length ? `<div class="editorial-links">${links.map(link =>
        `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)} →</a>`
      ).join('')}</div>` : ''}
    </section>`;
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
  ${faviconHeadHtml()}
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

export function renderPage(item, slug, isPreview, waitlistSiteKey, previewCoverSrc = '', relatedBooks = []) {
    const canonicalUrl = `${BASE}/libro/${item.id}/${slug}`;
    const safeTitle    = escapeHtml(item.title);
    // B11: los textos alternativos describen la portada sin arrastrar una
    // autoría genérica del título comercial. El título almacenado, el slug,
    // el canonical y la identidad de carrito permanecen intactos.
    const safeImageTitle = escapeHtml(stripGenericAuthorMention(item.title) || item.title);
    // FICHAS-QUALITY-GUARD-1: 'Desconocido', 'Unknown', 'Varios autores'… no
    // son autoría. displayAuthor queda null y TODA superficie que dependa de
    // él (fila Autor, JSON-LD, WhatsApp, relacionados, meta description) omite
    // el dato en vez de imprimir un nombre falso. Nunca se sustituye.
    const displayAuthor = realAuthor(item.author);
    const safeAuthor   = displayAuthor ? escapeHtml(displayAuthor) : null;
    const editorial = item._amadoEditorial && typeof item._amadoEditorial === 'object'
        ? item._amadoEditorial
        : null;
    const enrichmentSchema = item._amadoSchema && typeof item._amadoSchema === 'object'
        ? item._amadoSchema
        : null;
    const seoOverride  = PRODUCT_SEO_OVERRIDES[item.id] || null;
    const documentTitle = escapeHtml(seoOverride?.title || editorial?.seo_title || item.title);
    const indexWhenPaused = seoOverride?.indexWhenPaused === true ||
        isPausedProductInSeoCohort(item.id);
    const sourceImages = normalizeImages(item, previewCoverSrc);
    const images       = isPreview
        ? sourceImages
        : sourceImages.map((_, position) => bookCoverUrl(item.id, position));
    const img          = images[0] || '';
    const cartThumbnail = responsiveImage(img, {
        widths: [240],
        defaultWidth: 240,
        sizes: '240px',
    }).src;
    // Las redes sociales suelen bloquear imágenes servidas directamente por
    // mlstatic. La portada social sale desde nuestro dominio y el proxy valida
    // el MLU antes de obtenerla, para que WhatsApp/Facebook reciban HTTP 200.
    const socialImage  = `${BASE}/book-cover/${encodeURIComponent(item.id)}/cover.jpg`;
    const price         = Number(item.price) || 0;
    const currency      = String(item.currency || item.currency_id || 'UYU').trim().toUpperCase() || 'UYU';
    const checkoutCurrencySupported = currency === 'UYU';
    const priceUY       = price.toLocaleString('es-UY');
    const transferAmount = Math.round(price * 0.88);
    const transferPrice = transferAmount.toLocaleString('es-UY');
    const transferSaving = (price - transferAmount).toLocaleString('es-UY');
    const installment   = Math.round(price / 12).toLocaleString('es-UY');
    const stockQty      = Number(item.available_quantity) || 0;
    const inStock       = item.status === 'active' && stockQty > 0;
    const sellableInCheckout = inStock && checkoutCurrencySupported;
    // QW1 (Merchant): un producto activo con precio real de catálogo publica
    // Offer aunque hoy esté sin stock — Google necesita ver el precio real y
    // la disponibilidad real (OutOfStock), no la ausencia total de Offer.
    // 'paused' sigue sin Offer (no está realmente en venta). Nunca se inventa
    // un precio: sin precio real de catálogo, tampoco hay Offer.
    const hasRealPrice = item.status === 'active' && checkoutCurrencySupported && price > 0;
    const hasFreeShipping = sellableInCheckout && price >= FREE_SHIPPING_THRESHOLD_UYU;
    const condition     = formatCondition(item.condition);
    const dimensions    = item.dimensions_text || formatDimensions(item.dimensions);
    const bibliographic = item.bibliographic && typeof item.bibliographic === 'object'
        ? item.bibliographic
        : {};
    const editorialHtml = renderEditorialEnrichment(editorial);
    const description = item.description ? String(item.description).trim() : '';
    const descriptionHtml = description && !editorial
        ? `<div class="book-description"><h2>Descripción</h2><p>${escapeHtml(description)}</p></div>`
        : '';
    const waMessage = buildBookWhatsAppMessage({
        title: item.title,
        author: displayAuthor,
        page: canonicalUrl,
        available: inStock,
        unsupportedCurrency: inStock && !checkoutCurrencySupported,
    });
    const waLink = whatsappHref(waMessage);
    const relatedBooksHtml = renderRelatedBooks(relatedBooks, displayAuthor, !isPreview);
    const viewItemAnalytics = {
        dedupeKey: `view_item_${item.id}`,
        ...(sellableInCheckout ? { value: price } : {}),
        items: [{
            item_id: item.id,
            item_name: item.title,
            ...(sellableInCheckout ? { price } : {}),
            quantity: 1,
        }],
    };

    const detailRows = [
        displayAuthor ? detailRow('Autor', displayAuthor) : '',
        detailRow('ISBN', item.isbn),
        detailRow('Editorial', normalizePublisher(item.publisher)),
        item.pages ? detailRow('Páginas', `${item.pages}`) : '',
        detailRow('Idioma', bibliographic.language),
        detailRow('Formato', bibliographic.format),
        detailRow('Edición', bibliographic.edition),
        detailRow('Año', bibliographic.publication_year),
        detailRow('Fecha de publicación', bibliographic.publication_date),
        detailRow('Género', bibliographic.genre),
        detailRow('Temas', Array.isArray(bibliographic.subjects)
            ? bibliographic.subjects.map(value => String(value || '').trim()).filter(Boolean).join(' · ')
            : ''),
        detailRow('Colección', bibliographic.collection),
        detailRow('Traductor/a', bibliographic.translator),
        detailRow('Ilustrador/a', bibliographic.illustrator),
        detailRow('Subtítulo', bibliographic.subtitle),
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
    const moreDetailsHtml = detailRows || descriptionHtml
        ? `<details class="book-more">
      <summary>Ver más sobre este libro</summary>
      ${descriptionHtml}
      ${detailRows ? `<dl class="details">${detailRows}</dl>` : ''}
    </details>`
        : '';

    const defaultMetaDesc = sellableInCheckout
        ? (safeAuthor
            ? `Comprá &quot;${safeTitle}&quot; de ${safeAuthor} en Amado Libros. Transferencia: $${transferPrice} UYU. Envíos a todo Uruguay.`
            : `Comprá &quot;${safeTitle}&quot; en Amado Libros. Transferencia: $${transferPrice} UYU. Envíos a todo Uruguay.`)
        : inStock
          ? `Consultá precio y forma de pago de &quot;${safeTitle}&quot;, publicado en ${escapeHtml(currency)}, en Amado Libros.`
        : indexWhenPaused
          ? (safeAuthor
              ? `Buscamos &quot;${safeTitle}&quot; de ${safeAuthor} por encargo en Uruguay. Consultá disponibilidad, edición, precio y demora.`
              : `Buscamos &quot;${safeTitle}&quot; por encargo en Uruguay. Consultá disponibilidad, edición, precio y demora.`)
          : `Pedí un aviso cuando &quot;${safeTitle}&quot; vuelva a estar disponible en Amado Libros. También podemos buscarlo por encargo.`;
    const metaDesc = seoOverride?.description
        ? escapeHtml(seoOverride.description)
        : editorial?.meta_description
          ? escapeHtml(editorial.meta_description)
          : defaultMetaDesc;
    const seoOpportunityHtml = seoOverride?.heading && seoOverride?.copy
        ? `<section class="seo-opportunity" aria-labelledby="seo-opportunity-heading">
      <h2 id="seo-opportunity-heading">${escapeHtml(seoOverride.heading)}</h2>
      <p>${escapeHtml(seoOverride.copy)}</p>
      <a href="/catalogo?q=murdoku">Ver otros libros Murdoku</a>
    </section>`
        : '';

    // JSON-LD — generado con JSON.stringify, nunca concatenación
    const schemaProduct = {
        '@context': 'https://schema.org',
        '@type':    ['Product', 'Book'],
        'name':     item.title,
        'image':    images.length ? images : img,
        'description': description || (displayAuthor ? `${item.title} — ${displayAuthor}` : item.title),
        'sku':      item.id,
    };
    if (hasRealPrice) {
        schemaProduct.offers = {
            '@type':        'Offer',
            'url':          canonicalUrl,
            'priceCurrency': currency,
            'price':        String(price),
            'availability': inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
            'seller': {
                '@type': 'OnlineStore',
                '@id': `${BASE}/#bookstore`,
                'name': 'Amado Libros',
                'url': `${BASE}/`,
            },
            'shippingDetails': {
                '@type': 'OfferShippingDetails',
                'hasShippingService': {
                    '@id': `${BASE}/envios#shipping-service`,
                },
            },
            'hasMerchantReturnPolicy': {
                '@id': `${BASE}/devoluciones#merchant-return-policy`,
            },
        };
    }
    // FICHAS-QUALITY-GUARD-1: sin autoría real no se declara `author` en el
    // JSON-LD. Un Person llamado "Desconocido" es un dato estructurado falso.
    if (displayAuthor) {
        schemaProduct.author = { '@type': 'Person', 'name': displayAuthor };
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
    if (bibliographic.language) {
        schemaProduct.inLanguage = bibliographic.language;
    }
    if (bibliographic.format) {
        schemaProduct.bookFormat = bibliographic.format;
    }
    if (bibliographic.edition) {
        schemaProduct.bookEdition = bibliographic.edition;
    }
    if (bibliographic.publication_year) {
        schemaProduct.datePublished = String(bibliographic.publication_year);
    }
    if (bibliographic.genre) {
        schemaProduct.genre = bibliographic.genre;
    }
    if (Array.isArray(bibliographic.subjects) && bibliographic.subjects.length) {
        schemaProduct.keywords = bibliographic.subjects.map(value => String(value || '').trim()).filter(Boolean).slice(0, 6);
    }
    if (bibliographic.translator) {
        schemaProduct.translator = { '@type': 'Person', 'name': bibliographic.translator };
    }
    if (bibliographic.illustrator) {
        schemaProduct.illustrator = { '@type': 'Person', 'name': bibliographic.illustrator };
    }
    if (enrichmentSchema?.inLanguage) schemaProduct.inLanguage = enrichmentSchema.inLanguage;
    if (enrichmentSchema?.bookFormat) schemaProduct.bookFormat = enrichmentSchema.bookFormat;
    if (enrichmentSchema?.bookEdition) schemaProduct.bookEdition = enrichmentSchema.bookEdition;
    if (enrichmentSchema?.datePublished) schemaProduct.datePublished = enrichmentSchema.datePublished;
    if (enrichmentSchema?.genre) schemaProduct.genre = enrichmentSchema.genre;
    if (schemaProduct.offers && item.condition === 'new') {
        schemaProduct.offers.itemCondition = 'https://schema.org/NewCondition';
    } else if (schemaProduct.offers && item.condition === 'used') {
        schemaProduct.offers.itemCondition = 'https://schema.org/UsedCondition';
    }

    const priceHtml = sellableInCheckout
        ? `<div class="price-box">
      <div class="price-main">
        <span class="price-main-label">Precio web/tarjeta:</span>
        <strong>$${priceUY} UYU</strong>
      </div>
      <div class="price-installment">Hasta 12 cuotas de aprox. $${installment} UYU</div>
      <div class="price-transfer">
        <span class="price-transfer-line"><span aria-hidden="true">🏷️</span> 12% menos por transferencia: <strong>$${transferPrice} UYU</strong></span>
        <span class="price-saving">Ahorrás $${transferSaving} UYU</span>
      </div>
      ${hasFreeShipping ? '<div class="price-free-shipping"><span aria-hidden="true">🚚</span> Envío gratis</div>' : ''}
    </div>`
        : inStock
          ? `<div class="order-box">
      <strong>Precio publicado: ${escapeHtml(currency)} ${escapeHtml(priceUY)}</strong>
      <span>Esta publicación no se convierte automáticamente a UYU. Consultanos para confirmar precio y forma de pago, o comprala directamente en MercadoLibre.</span>
    </div>`
        : `<div class="order-box">
      <strong>¿Buscás este libro?</strong>
      <span>Podemos intentar conseguirlo por encargo. Consultanos y verificamos disponibilidad, edición y precio.</span>
    </div>`;

    const actionHtml = sellableInCheckout
        ? `<button
        type="button"
        class="btn btn-cart"
        data-action="add-to-cart"
        data-id="${escapeHtml(item.id)}"
        data-title="${escapeHtml(item.title)}"
        data-price="${price}"
        data-thumbnail="${escapeHtml(cartThumbnail)}"
        data-max-qty="${stockQty}"
      >
        <span data-cart-label>🛒 Agregar al carrito</span>
      </button>
      <a class="btn btn-wa" href="${escapeHtml(waLink)}" target="_blank" rel="noopener noreferrer">
        💬 Consultar por WhatsApp
      </a>
      <a class="btn btn-ml" href="${escapeHtml(item.permalink)}" target="_blank" rel="noopener noreferrer">
        Comprar en MercadoLibre
      </a>`
        : inStock
          ? `<a class="btn btn-wa" href="${escapeHtml(waLink)}" target="_blank" rel="noopener noreferrer">
        Consultar precio y forma de pago
      </a>
      <a class="btn btn-ml" href="${escapeHtml(item.permalink)}" target="_blank" rel="noopener noreferrer">
        Comprar en MercadoLibre
      </a>`
        : `<a class="btn btn-wa" href="${escapeHtml(waLink)}" target="_blank" rel="noopener noreferrer">
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
  <title>${documentTitle} | Amado Libros</title>
  <meta name="description" content="${metaDesc}">
  <meta name="robots" content="${isPreview || (!inStock && !indexWhenPaused) ? 'noindex, follow' : 'index, follow'}">
  <link rel="canonical" href="${canonicalUrl}">
  ${faviconHeadHtml()}

  <meta property="og:type"        content="product">
  <meta property="og:url"         content="${canonicalUrl}">
  <meta property="og:title"       content="${documentTitle} | Amado Libros">
  <meta property="og:description" content="${metaDesc}">
  <meta property="og:image"       content="${escapeHtml(socialImage)}">
  <meta property="og:image:secure_url" content="${escapeHtml(socialImage)}">
  <meta property="og:image:alt"   content="Portada de ${safeImageTitle}">
  <meta property="og:locale"      content="es_UY">
  <meta property="og:site_name"   content="Amado Libros">

  <meta name="twitter:card"        content="summary_large_image">
  <meta name="twitter:title"       content="${documentTitle} | Amado Libros">
  <meta name="twitter:description" content="${metaDesc}">
  <meta name="twitter:image"       content="${escapeHtml(socialImage)}">
  <meta name="twitter:image:alt"   content="Portada de ${safeImageTitle}">

  <script type="application/ld+json">${safeJson(schemaProduct)}</script>
  <script type="application/ld+json">${safeJson(schemaBreadcrumb)}</script>
  <script src="/cart.js" defer></script>
  <script src="/search-autocomplete.js" defer></script>

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
    .brand-logo{width:44px;height:44px;display:block;object-fit:contain;
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
             margin:.65rem 0 0;overflow:hidden}
    .detail-row{display:grid;grid-template-columns:94px 1fr;gap:.75rem;
                padding:.55rem .75rem;border-bottom:1px solid #f1f5f9;font-size:.84rem}
    .detail-row:last-child{border-bottom:0}
    .detail-row dt{font-weight:700;color:#334155}
    .detail-row dd{color:#475569}
    .book-more{margin:.25rem 0 .875rem;background:#fff;border:1px solid #e2e8f0;
               border-radius:.5rem;overflow:hidden}
    .book-more summary{cursor:pointer;min-height:44px;display:flex;align-items:center;
                       padding:.65rem .8rem;font-size:.86rem;font-weight:750;color:#334155}
    .book-more summary:hover{background:#f8fafc}
    .book-more summary:focus-visible{outline:2px solid #3b82f6;outline-offset:-2px}
    .book-more[open] summary{border-bottom:1px solid #e2e8f0}
    .book-more .details{border:0;border-radius:0;margin:0}
    .book-description{padding:.8rem;border-bottom:1px solid #e2e8f0}
    .book-description h2{font-size:.9rem;margin:0 0 .35rem;color:#334155}
    .book-description p{white-space:pre-line;font-size:.84rem;color:#475569;line-height:1.55}
    .price-box{background:#fff;border:1px solid #d8d1c7;border-radius:.65rem;
               padding:1rem 1.25rem;margin:.875rem 0}
    .price-main{display:flex;flex-direction:column;align-items:flex-start;gap:.12rem}
    .price-main-label{font-size:.82rem;font-weight:700;color:#334155}
    .price-main strong{font-size:1.55rem;font-weight:850;color:#18120e;line-height:1.25}
    .price-installment{font-size:.88rem;font-weight:600;color:#475569;margin-top:.15rem}
    .price-transfer{display:flex;flex-direction:column;align-items:flex-start;gap:.12rem;
                    margin-top:.75rem;padding-top:.7rem;border-top:1px solid #e2e8f0}
    .price-transfer-line{font-size:.88rem;font-weight:700;color:#a94e3d;line-height:1.35}
    .price-transfer-line strong{font-size:1rem;font-weight:850;color:#8f4436}
    .price-saving{font-size:.78rem;font-weight:650;color:#64748b}
    .price-free-shipping{font-size:.86rem;font-weight:750;color:#267a42;margin-top:.5rem}
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
    .editorial-enrichment{margin-top:1.1rem;padding:1.15rem;background:#fff;
                            border:1px solid #dbe3ec;border-radius:.7rem}
    .editorial-enrichment h2{font-size:1.22rem;line-height:1.3;color:#0f172a;margin-bottom:.75rem}
    .editorial-enrichment h3{font-size:1rem;line-height:1.35;color:#1e293b;margin:1rem 0 .45rem}
    .editorial-enrichment p{font-size:.92rem;color:#334155;margin-top:.65rem}
    .editorial-eyebrow{font-size:.76rem!important;font-weight:800;text-transform:uppercase;
                       letter-spacing:.055em;color:#9a3412!important;margin:0 0 .4rem!important}
    .editorial-enrichment ul{padding-left:1.15rem;margin-top:.45rem;color:#334155}
    .editorial-enrichment li{margin:.3rem 0;font-size:.9rem}
    .editorial-decision{margin-top:1rem;padding-top:.15rem;border-top:1px solid #e2e8f0}
    .editorial-links{display:flex;flex-wrap:wrap;gap:.65rem 1rem;margin-top:1rem}
    .editorial-links a{font-size:.86rem;font-weight:700;color:#9a3412}
    .shipping{font-size:.82rem;color:#64748b;margin-top:1rem;padding:.75rem 1rem;
              background:white;border:1px solid #e2e8f0;border-radius:.5rem}
    .seo-opportunity{margin-top:1rem;padding:1rem;background:#fff7ed;
                     border:1px solid #fdba74;border-radius:.65rem;color:#7c2d12}
    .seo-opportunity h2{font-size:1rem;line-height:1.35;margin-bottom:.4rem;color:#431407}
    .seo-opportunity p{font-size:.88rem;margin-bottom:.45rem}
    .seo-opportunity a{font-size:.85rem;font-weight:700;color:#9a3412}
    .related-books{grid-column:1/-1;border-top:1px solid #e2e8f0;padding-top:1.25rem}
    .related-books h2{font-size:1.05rem;line-height:1.35;color:#0f172a;margin-bottom:.85rem}
    .related-books-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));
                        gap:.8rem;list-style:none}
    .related-book{min-width:0}
    .related-book-link{height:100%;display:flex;flex-direction:column;gap:.55rem;
                       padding:.65rem;background:#fff;border:1px solid #e2e8f0;
                       border-radius:.55rem;color:#334155;text-decoration:none}
    .related-book-link:hover{border-color:#94a3b8;color:#0f172a}
    .related-book-link:focus-visible{outline:2px solid #3b82f6;outline-offset:2px}
    .related-book-cover{display:block;width:100%;aspect-ratio:2/3;height:auto;max-height:180px;
                        object-fit:contain;background:#f8fafc;border-radius:.3rem}
    .related-book-title{font-size:.82rem;font-weight:700;line-height:1.35}
    @media(min-width:760px){.related-books-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
    ${FOOTER_STYLES}
    ${WA_FLOAT_STYLES}
  </style>
</head>
<body>

<header class="product-header">
  <div class="header-inner">
    <a href="/" class="brand-link" aria-label="Amado Libros — ir al inicio">
      <img src="/images/logo-amado.webp" alt="Amado Libros" class="brand-logo" width="44" height="44" fetchpriority="high">
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
  ${renderGallery(images, safeImageTitle)}
  <div class="info">
    <h1>${safeTitle}</h1>
    ${inStock ? `<span class="badge in-stock">✓ En stock</span>` : ''}
    ${inStock ? moreDetailsHtml : ''}
    ${priceHtml}
    <div class="cta">
      ${actionHtml}
    </div>
    ${editorialHtml}
    ${!inStock ? moreDetailsHtml : ''}
    ${seoOpportunityHtml}
    <p class="shipping">${inStock
      ? '🚚 Entrega en el día en Montevideo según zona, horario y confirmación · Envío $250 · Gratis desde $1.500 · Atención personalizada.'
      : '🌎 Si preferís no esperar, también podemos buscarlo por encargo en el exterior.'
    } <a href="/politicas/#envios">Ver política de envíos</a>.</p>
  </div>
  ${relatedBooksHtml}
</main>

<script>(function(){
  if(window.AmadoAnalytics&&typeof window.AmadoAnalytics.trackCommerce==='function'){
    window.AmadoAnalytics.trackCommerce('view_item',${safeJson(viewItemAnalytics)});
  }
}());<\/script>

${footerHtml(undefined, canonicalUrl)}
${waFloatHtml(waMessage, canonicalUrl)}

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
// Normalización de URL canónica de producto
// ---------------------------------------------------------------------------

export function canonicalProductRedirectUrl({
    requestUrl,
    navigationBase,
    id,
    providedSlug,
    canonicalSlug,
}) {
    if (providedSlug && providedSlug === canonicalSlug) return null;

    const currentUrl = new URL(requestUrl);
    // layout es un parámetro histórico de presentación: no debe sobrevivir
    // al salto canónico. El resto de la query se conserva.
    currentUrl.searchParams.delete('layout');
    return `${navigationBase}/libro/${id}/${canonicalSlug}${currentUrl.search}`;
}

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------

export async function onRequest(context) {
    const requestStartedAt = perfNow();
    ensurePerf(context);
    const pathParts = Array.isArray(context.params.path)
        ? context.params.path
        : [context.params.path].filter(Boolean);

    const id           = (pathParts[0] || '').toUpperCase();
    const providedSlug = pathParts[1] || null;

    // Validar formato ID
    if (!id || !/^MLU\d+$/.test(id)) {
        return notFound();
    }

    const productRedirect = PRODUCT_ID_REDIRECTS[id];
    if (productRedirect) {
        const currentUrl = new URL(context.request.url);
        const destination = new URL(productRedirect.path, BASE);
        destination.search = currentUrl.search;
        destination.searchParams.delete('layout');
        return Response.redirect(destination.toString(), 301);
    }

    // Cargar catálogo (con edge cache)
    const catalog = await fetchCatalog(context);
    const activeCatalogAvailable = catalog && Array.isArray(catalog.items);
    const activeLookupStartedAt = perfNow();
    let item = activeCatalogAvailable
        ? catalog.items.find(b => b.id === id)
        : null;
    recordPerf(context, 'active_lookup', activeLookupStartedAt, {
        found: Boolean(item),
    });
    // CF-R2-2-BRIDGE: habilitado en Preview y producción — cada uno resuelve
    // contra su propio manifest (fetchPausedItem -> manifestUrlFor en
    // _shared/catalog.js). Si el manifest de ese entorno falta o es
    // inválido, fetchPausedItem devuelve null y el flujo sigue igual que
    // hoy (notFound), sin 500.
    if (!item && ['preview', 'production'].includes(context.env?.APP_ENV)) {
        const pausedLookupStartedAt = perfNow();
        item = await fetchPausedItem(context, id);
        recordPerf(context, 'paused_lookup', pausedLookupStartedAt, {
            found: Boolean(item),
        });
    }
    if (!item && !activeCatalogAvailable) {
        return new Response('Error al cargar el catálogo. Intentá de nuevo en unos segundos.', {
            status: 503,
            headers: { 'content-type': 'text/plain;charset=UTF-8' },
        });
    }
    if (!item) return notFound();

    // El enriquecimiento sólo agrega datos bibliográficos verificados. El
    // título permanece intacto, por lo que el slug/canonical conserva la URL
    // comercial existente.
    item = applyBookEnrichment(item);
    const slug = slugify(item.title);
    const isPreview = context.env?.APP_ENV === 'preview';
    const navigationBase = isPreview
        ? new URL(context.request.url).origin
        : BASE;

    // Una sola URL por entidad: slug faltante o incorrecto -> 301 canónico.
    const canonicalRedirect = canonicalProductRedirectUrl({
        requestUrl: context.request.url,
        navigationBase,
        id,
        providedSlug,
        canonicalSlug: slug,
    });
    if (canonicalRedirect) {
        return Response.redirect(canonicalRedirect, 301);
    }

    const waitlistSiteKey = typeof context.env?.STOCK_WAITLIST_TURNSTILE_SITE_KEY === 'string'
        ? context.env.STOCK_WAITLIST_TURNSTILE_SITE_KEY.trim()
        : '';

    const originalImages = normalizeImages(item);
    const coversEnabled = ['preview', 'production'].includes(context.env?.APP_ENV);
    const coverResolveStartedAt = perfNow();
    const previewCoverSrc = coversEnabled && originalImages[0]
        ? await resolvePreviewCoverUrl(context, item.id, 0, originalImages[0])
        : null;
    recordPerf(context, 'cover_resolve', coverResolveStartedAt, {
        found: Boolean(previewCoverSrc),
    });

    const relatedBooks = activeCatalogAvailable
        ? selectRelatedBooks(catalog.items, item)
        : [];

    const renderStartedAt = perfNow();
    const html = renderPage(item, slug, isPreview, waitlistSiteKey, previewCoverSrc || '', relatedBooks);
    recordPerf(context, 'render', renderStartedAt);

    const totalDuration = Math.round((perfNow() - requestStartedAt) * 100) / 100;
    const serverTiming = serverTimingValue(context, [{
        name: 'route_total',
        duration_ms: totalDuration,
    }]);
    const cacheStatus = context.data.perf.cache.miss > 0 ? 'MISS' : 'HIT';
    console.log(JSON.stringify(perfSummary(context, {
        event: 'product_page_perf',
        route: '/libro/:id/:slug',
        availability: item.status === 'paused' ? 'paused' : 'active',
        cover_r2: Boolean(previewCoverSrc),
        total_ms: totalDuration,
    })));

    return new Response(html, {
        headers: {
            'content-type':  'text/html;charset=UTF-8',
            'cache-control': 'public, max-age=3600',
            'server-timing': serverTiming,
            'x-cache-status': cacheStatus,
            'x-perf-cache-hits': String(context.data.perf.cache.hit),
            'x-perf-cache-misses': String(context.data.perf.cache.miss),
        },
    });
}
