import { BASE, fetchPausedIndex } from './_shared/catalog.js';
import {
  BRAND, faviconHeadHtml, footerHtml, FOOTER_STYLES,
  waFloatHtml, WA_FLOAT_STYLES,
} from './_shared/brand.js';
import { bookCoverUrl, CARD_IMAGE_SIZES, responsiveImage } from './_shared/cloudflare-images.js';
import {
  ORDER_HUB_PAGE_SIZE, ORDER_HUB_PATH, orderHubBooks, orderHubDemandBooks,
  orderHubPageCount, orderHubPageSlice, orderHubPath, parseOrderHubPage,
} from './_shared/order-hub.js';
import { buildWhatsAppMessage } from '../shared/whatsapp-messages.js';

const TITLE = 'Libros por encargo en Uruguay | Amado Libros';
const DESCRIPTION = 'Explorá libros agotados, importados y difíciles de conseguir que Amado Libros puede buscar y cotizar por encargo desde Uruguay.';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function noindexPage({ status, heading, message, retryAfter = '' }) {
  const headers = {
    'Content-Type': 'text/html;charset=UTF-8',
    'Cache-Control': status === 503 ? 'no-store' : 'public, max-age=300',
    'X-Robots-Tag': 'noindex, nofollow',
  };
  if (retryAfter) headers['Retry-After'] = retryAfter;
  return new Response(`<!doctype html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${escapeHtml(heading)} | Amado Libros</title>${faviconHeadHtml()}</head><body style="font-family:system-ui,sans-serif;max-width:680px;margin:4rem auto;padding:1rem;line-height:1.6"><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p><p><a href="${ORDER_HUB_PATH}">Volver a libros por encargo</a></p></main></body></html>`, { status, headers });
}

function pageIndexHtml(totalPages, currentPage) {
  return `<nav class="page-index" aria-label="Todas las páginas de libros por encargo">${Array.from({ length: totalPages }, (_, index) => {
    const page = index + 1;
    return page === currentPage
      ? `<span class="page-number is-current" aria-current="page">${page}</span>`
      : `<a class="page-number" href="${orderHubPath(page)}" aria-label="Ir a la página ${page}">${page}</a>`;
  }).join('')}</nav>`;
}

function pagerHtml(totalPages, currentPage) {
  const previous = currentPage > 1
    ? `<a class="pager-link" href="${orderHubPath(currentPage - 1)}" rel="prev">← Anterior</a>`
    : '<span class="pager-link is-disabled" aria-disabled="true">← Anterior</span>';
  const next = currentPage < totalPages
    ? `<a class="pager-link" href="${orderHubPath(currentPage + 1)}" rel="next">Siguiente →</a>`
    : '<span class="pager-link is-disabled" aria-disabled="true">Siguiente →</span>';
  return `<nav class="pager" aria-label="Paginación de libros por encargo">${previous}<span>Página ${currentPage} de ${totalPages}</span>${next}</nav>`;
}

function cardHtml(book, position) {
  const href = `/libro/${encodeURIComponent(book.id)}/${book.slug}`;
  const image = responsiveImage(bookCoverUrl(book.id), {
    widths: [240, 360, 480], defaultWidth: 360, sizes: CARD_IMAGE_SIZES,
  });
  const responsive = image.srcset
    ? ` srcset="${escapeHtml(image.srcset)}" sizes="${escapeHtml(image.sizes)}"`
    : '';
  return `<article class="book-card">
    <a class="book-cover-link" href="${href}" aria-label="Ver ficha de ${escapeHtml(book.title)}"><img src="${escapeHtml(image.src)}"${responsive} alt="Portada de ${escapeHtml(book.title)}" loading="${position < 8 ? 'eager' : 'lazy'}" decoding="async" width="280" height="420"></a>
    <div class="book-body"><span class="order-badge">Por encargo</span><h2><a href="${href}">${escapeHtml(book.title)}</a></h2>
      ${book.author ? `<p class="book-author">${escapeHtml(book.author)}</p>` : ''}
      ${book.isbn ? `<p class="book-isbn">ISBN ${escapeHtml(book.isbn)}</p>` : ''}
      <p class="order-note">Edición, disponibilidad, precio y plazo a confirmar.</p><a class="book-cta" href="${href}">Ver ficha y consultar →</a>
    </div>
  </article>`;
}

function priorityLinksHtml(priorityBooks) {
  if (!Array.isArray(priorityBooks) || priorityBooks.length === 0) return '';
  const items = priorityBooks.map(book => {
    const href = `/libro/${encodeURIComponent(book.id)}/${book.slug}`;
    const meta = [book.author, book.isbn ? `ISBN ${book.isbn}` : ''].filter(Boolean).join(' · ');
    return `<li class="priority-book"><a href="${href}"><strong>${escapeHtml(book.title)}</strong>${meta ? `<span>${escapeHtml(meta)}</span>` : ''}</a></li>`;
  }).join('\n');
  return `<section class="priority-links" aria-labelledby="priority-links-title">
    <p class="eyebrow">Accesos directos</p>
    <h2 id="priority-links-title">Más títulos por encargo</h2>
    <p class="priority-intro">Otros títulos de la colección para seguir explorando sin recorrer toda la paginación.</p>
    <ul class="priority-grid">${items}</ul>
  </section>`;
}

function renderPage({ books, pageBooks, priorityBooks = [], currentPage, totalPages, indexable }) {
  const offset = (currentPage - 1) * ORDER_HUB_PAGE_SIZE;
  const canonicalPath = orderHubPath(currentPage);
  const canonicalUrl = `${BASE}${canonicalPath}`;
  const pageTitle = currentPage === 1 ? TITLE : `Libros por encargo en Uruguay — Página ${currentPage} | Amado Libros`;
  const pageDescription = currentPage === 1 ? DESCRIPTION : `Página ${currentPage} de libros agotados, importados y difíciles de conseguir que Amado Libros puede buscar por encargo desde Uruguay.`;
  const schema = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage', '@id': `${canonicalUrl}#webpage`, url: canonicalUrl,
        name: pageTitle, description: pageDescription, inLanguage: 'es-UY',
        mainEntity: { '@id': `${canonicalUrl}#item-list` },
      },
      {
        '@type': 'ItemList', '@id': `${canonicalUrl}#item-list`,
        name: currentPage === 1 ? 'Libros por encargo' : `Libros por encargo — página ${currentPage}`,
        numberOfItems: pageBooks.length,
        itemListElement: pageBooks.map((book, index) => ({
          '@type': 'ListItem', position: offset + index + 1,
          url: `${BASE}/libro/${book.id}/${book.slug}`, name: book.title,
        })),
      },
      {
        '@type': 'BreadcrumbList', itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Inicio', item: `${BASE}/` },
          { '@type': 'ListItem', position: 2, name: 'Libros por encargo', item: `${BASE}${ORDER_HUB_PATH}` },
          ...(currentPage > 1 ? [{ '@type': 'ListItem', position: 3, name: `Página ${currentPage}`, item: canonicalUrl }] : []),
        ],
      },
    ],
  };
  const message = buildWhatsAppMessage({
    motive: 'Consulta por un libro por encargo', page: canonicalUrl,
    closing: 'Quisiera consultar por uno de los títulos del catálogo por encargo. Gracias.',
  });
  const pager = pagerHtml(totalPages, currentPage);
  const rangeFrom = offset + 1;
  const rangeTo = offset + pageBooks.length;
  const styles = `
    *{box-sizing:border-box;margin:0;padding:0}body{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:#f8f5ef;color:#18120e;line-height:1.6}a{color:inherit}.site-header{background:#18120e;color:#fff}.header-inner{max-width:1180px;margin:auto;padding:.75rem 1rem;display:flex;align-items:center;justify-content:space-between;gap:1rem}.brand-link{display:flex;align-items:center;gap:.7rem;text-decoration:none;font-weight:800}.brand-link img{width:48px;height:48px;object-fit:contain;background:#fff;border-radius:50%}.header-links{display:flex;gap:.5rem;font-size:.82rem}.header-links a{padding:.55rem .7rem;text-decoration:none}.crumbs{max-width:1180px;margin:auto;padding:.85rem 1rem;color:#6b6157;font-size:.84rem}.crumbs a,.book-cta{color:#8f4436;text-decoration:none}main{max-width:1180px;margin:auto;padding:0 1rem 3rem}.hero{padding:clamp(1.35rem,4vw,2.5rem);background:#fff;border:1px solid #e2dbd0;border-radius:1rem}.eyebrow{color:#a94e3d;font-size:.75rem;font-weight:800;letter-spacing:.09em;text-transform:uppercase}h1{max-width:24ch;margin-top:.45rem;font-family:Georgia,"Times New Roman",serif;font-size:clamp(1.9rem,6vw,3rem);line-height:1.08}.lead{max-width:76ch;margin-top:.85rem;color:#574d45}.truth{margin-top:1rem;padding:.85rem 1rem;border-left:4px solid #e49982;background:#fff8f4;color:#6b4b3f;font-size:.9rem}.collection-meta{display:flex;flex-wrap:wrap;justify-content:space-between;gap:.7rem;margin:1.25rem 0 .8rem;color:#6b6157;font-size:.86rem}.book-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem}.book-card{display:flex;flex-direction:column;background:#fff;border:1px solid #e2dbd0;border-radius:.8rem;overflow:hidden}.book-cover-link{display:block;aspect-ratio:2/3;background:#f3efe8;overflow:hidden}.book-cover-link img{width:100%;height:100%;object-fit:contain}.book-body{display:flex;flex:1;flex-direction:column;align-items:flex-start;padding:.8rem;gap:.38rem}.order-badge{padding:.2rem .52rem;border-radius:999px;background:#fff1e8;color:#8f4436;font-size:.68rem;font-weight:800;text-transform:uppercase}.book-body h2{font-size:.92rem;line-height:1.3}.book-body h2 a{text-decoration:none}.book-author{font-size:.8rem;color:#574d45}.book-isbn,.order-note{font-size:.74rem;color:#756a61}.book-cta{margin-top:auto;padding-top:.45rem;font-size:.8rem;font-weight:800}.pager{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:.6rem;margin:1.25rem 0;padding:.8rem;background:#fff;border:1px solid #e2dbd0;border-radius:.75rem;text-align:center;font-size:.84rem}.pager-link{min-height:44px;display:flex;align-items:center;padding:.55rem .7rem;text-decoration:none;font-weight:800}.pager-link:last-child{justify-content:flex-end}.pager-link.is-disabled{color:#a39a91}.priority-links{margin:1.25rem 0;padding:1rem;background:#fff;border:1px solid #e2dbd0;border-radius:.8rem}.priority-links h2{font-size:1.15rem;margin-top:.2rem}.priority-intro{margin-top:.35rem;color:#6b6157;font-size:.84rem}.priority-grid{display:grid;grid-template-columns:1fr;gap:.45rem;margin-top:.8rem;list-style:none}.priority-book a{display:flex;flex-direction:column;min-height:44px;padding:.65rem .75rem;border:1px solid #eee7dd;border-radius:.55rem;text-decoration:none;background:#fffdf9}.priority-book strong{font-size:.82rem;line-height:1.3}.priority-book span{margin-top:.18rem;color:#756a61;font-size:.72rem}.page-index{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:1rem;padding:1rem;background:#fff;border:1px solid #e2dbd0;border-radius:.75rem}.page-number{min-width:38px;min-height:38px;display:inline-flex;align-items:center;justify-content:center;border:1px solid #d8d1c7;border-radius:.45rem;text-decoration:none;font-size:.78rem;font-weight:700}.page-number.is-current{background:#18120e;color:#fff}.service-link{margin-top:1.25rem;padding:1rem;background:#18120e;color:#fff;border-radius:.75rem}.service-link p{color:#ffffffb8;font-size:.88rem}.service-link a{display:inline-flex;margin-top:.65rem;font-weight:800}@media(min-width:640px){.book-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem}.book-body{padding:1rem}.priority-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(min-width:980px){.book-grid{grid-template-columns:repeat(4,minmax(0,1fr));}.priority-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:560px){.header-links a:last-child{display:none}.pager{grid-template-columns:1fr 1fr}.pager>span{grid-column:1/-1;grid-row:1}.pager-link{grid-row:2}.page-index{max-height:12rem;overflow:auto}}
    ${FOOTER_STYLES}${WA_FLOAT_STYLES}`;

  return `<!doctype html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(pageTitle)}</title><meta name="description" content="${escapeHtml(pageDescription)}"><meta name="robots" content="${indexable ? 'index, follow' : 'noindex, nofollow'}"><link rel="canonical" href="${canonicalUrl}">${currentPage > 1 ? `<link rel="prev" href="${BASE}${orderHubPath(currentPage - 1)}">` : ''}${currentPage < totalPages ? `<link rel="next" href="${BASE}${orderHubPath(currentPage + 1)}">` : ''}${faviconHeadHtml()}<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script><style>${styles}</style></head><body>
    <header class="site-header"><div class="header-inner"><a class="brand-link" href="/"><img src="${BRAND.logo}" alt="${BRAND.logoAlt}" width="48" height="48"><span>Amado Libros</span></a><nav class="header-links" aria-label="Navegación principal"><a href="/catalogo">Catálogo</a><a href="/pedir-libro">Pedir un libro</a></nav></div></header>
    <nav class="crumbs" aria-label="Migas de pan"><a href="/">Inicio</a> › ${currentPage > 1 ? `<a href="${ORDER_HUB_PATH}">Libros por encargo</a> › Página ${currentPage}` : 'Libros por encargo'}</nav>
    <main><section class="hero"><p class="eyebrow">Catálogo rastreable de títulos difíciles de conseguir</p><h1>${currentPage === 1 ? 'Libros que podemos buscar por encargo' : `Libros por encargo — página ${currentPage}`}</h1><p class="lead">${currentPage === 1 ? 'Esta colección reúne títulos que hoy no están en stock local, pero que podemos buscar y cotizar en proveedores del exterior. Cada ficha corresponde a una edición identificada por título, autor o ISBN.' : `Continuá explorando los libros ${rangeFrom} a ${rangeTo} de la colección por encargo.`}</p><p class="truth"><strong>Importante:</strong> aparecer en esta colección no garantiza stock ni precio. Verificamos edición, proveedor, costo y plazo antes de aceptar un encargo.</p></section>
      <div class="collection-meta"><p><strong>${books.length.toLocaleString('es-UY')}</strong> títulos seleccionados</p><p>Mostrando ${rangeFrom}–${rangeTo} · ${ORDER_HUB_PAGE_SIZE} por página</p></div>${pager}
      <section class="book-grid" aria-label="Libros por encargo de la página ${currentPage}">${pageBooks.map(cardHtml).join('\n')}</section>${pager}
      ${currentPage === 1 ? priorityLinksHtml(priorityBooks) : ''}
      <section aria-labelledby="all-pages-title"><h2 id="all-pages-title" style="font-size:1rem;margin-top:1.35rem">Ir directamente a otra página</h2>${pageIndexHtml(totalPages, currentPage)}</section>
      <aside class="service-link"><h2 style="font-size:1rem">¿No aparece el título que buscás?</h2><p>También hacemos búsquedas manuales por título, autor, ISBN o foto de la tapa.</p><a href="/libros-agotados-importados-uruguay">Conocer el servicio de búsqueda por encargo →</a></aside>
    </main>${footerHtml(undefined, canonicalUrl)}${waFloatHtml(message, canonicalUrl)}</body></html>`;
}

export function createOrderHubHandler({ fetchPaused = fetchPausedIndex } = {}) {
  return async function onRequest(ctx) {
    const url = new URL(ctx.request.url);
    const parsed = parseOrderHubPage(url.searchParams.get('page'));
    if (!parsed.valid) return noindexPage({ status: 404, heading: 'Página no encontrada', message: 'La página de libros por encargo que buscás no existe.' });
    if (parsed.present && parsed.page === 1) return Response.redirect(new URL(ORDER_HUB_PATH, url.origin).toString(), 301);

    let pausedIndex;
    try { pausedIndex = await fetchPaused(ctx); } catch { pausedIndex = null; }
    const books = orderHubBooks(pausedIndex);
    if (!Array.isArray(pausedIndex?.items) || books.length === 0) {
      return noindexPage({ status: 503, heading: 'El catálogo por encargo está actualizándose', message: 'Probá nuevamente en unos minutos.', retryAfter: '60' });
    }

    const totalPages = orderHubPageCount(books);
    if (parsed.page > totalPages) return noindexPage({ status: 404, heading: 'Página no encontrada', message: 'La página de libros por encargo que buscás no existe.' });
    const pageBooks = orderHubPageSlice(books, parsed.page);
    const priorityBooks = parsed.page === 1
      ? orderHubDemandBooks(pausedIndex, { excludeIds: pageBooks.map(book => book.id) })
      : [];
    const html = renderPage({
      books, pageBooks, priorityBooks, currentPage: parsed.page,
      totalPages, indexable: ctx.env?.APP_ENV === 'production',
    });
    return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public, max-age=300' } });
  };
}

export const onRequest = createOrderHubHandler();