import { BASE } from '../_shared/catalog.js';
import {
  ORDER_HUB_PATH,
  orderHubPageForProductId,
  orderHubPath,
} from '../_shared/order-hub.js';
import { PRODUCT_SHOWCASE_OVERRIDES } from '../_shared/product-showcases.js';

const PRODUCT_PATH_RE = /^\/libro\/(MLU\d+)(?:\/|$)/i;
const BREADCRUMB_RE = /<nav>\s*<a href="\/">Inicio<\/a>\s*›\s*<span>/;
const PRODUCT_NAV_RE = /(<nav>[\s\S]*?<span>)[\s\S]*?(<\/span>\s*<\/nav>)/;
const PRODUCT_H1_RE = /<h1>[\s\S]*?<\/h1>/;
const JSON_LD_RE = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
const CATALOG_PATH = '/catalogo';
const ACTIVE_PAGE_MARKER = 'class="badge in-stock"';
const ORDER_BOX_GENERIC_COPY = '<span>Podemos intentar conseguirlo por encargo. Consultanos y verificamos disponibilidad, edición y precio.</span>';
const ORDER_BOX_LEAD_TIME_COPY = `<span class="order-lead-time"><b>Demora estimada: 15 a 20 días desde la confirmación.</b> Salvo demoras del proveedor, courier o aduana.</span>
      <span>Antes de avanzar verificamos disponibilidad, edición y precio.</span>`;
const ORDER_LEAD_TIME_STYLE_MARKER = '.order-box .order-lead-time{';
const SHOWCASE_MARKER = 'class="product-showcase"';
const SHOWCASE_STYLE_MARKER = '.product-showcase{';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function serializeSchema(schema) {
  return JSON.stringify(schema).replace(/</g, '\\u003c');
}

function leadTimeStyles() {
  return `
    .order-box .order-lead-time{font-weight:650}
    .order-box .order-lead-time b{display:block;font-weight:850;color:#6b4218}
  `;
}

function byRequestStyles() {
  return `
    .order-hub-links{grid-column:1/-1;padding:1rem 1.1rem;background:#fff8f4;
                     border:1px solid #ecd1c6;border-radius:.65rem;color:#4b342b}
    .order-hub-links h2{font-size:1.05rem;line-height:1.35;color:#18120e;margin-bottom:.35rem}
    .order-hub-links p{font-size:.86rem;color:#6b4b3f;margin-bottom:.7rem}
    .order-hub-actions{display:flex;flex-wrap:wrap;gap:.5rem .9rem}
    .order-hub-actions a{font-size:.84rem;font-weight:750;color:#8f4436;text-decoration:none}
    .order-hub-actions a:hover{text-decoration:underline}
    .order-hub-actions a:focus-visible{outline:2px solid #a94e3d;outline-offset:2px}
  `;
}

function showcaseStyles() {
  return `
    .book-subtitle{margin:-.45rem 0 .8rem;color:#475569;font-size:.95rem;
                   font-weight:650;line-height:1.4}
    .product-showcase{grid-column:1/-1;background:#fff;border:1px solid #d8d1c7;
                      border-radius:.8rem;overflow:hidden;box-shadow:0 8px 24px rgba(15,23,42,.05)}
    .showcase-intro{padding:1.35rem 1.4rem;border-bottom:1px solid #e2e8f0}
    .showcase-eyebrow{font-size:.76rem;font-weight:850;letter-spacing:.055em;
                      text-transform:uppercase;color:#8f4436;margin-bottom:.4rem}
    .product-showcase h2{font-size:1.3rem;line-height:1.3;color:#18120e;margin-bottom:.75rem}
    .product-showcase h3{font-size:1rem;line-height:1.35;color:#1e293b;margin-bottom:.5rem}
    .showcase-intro p:not(.showcase-eyebrow){font-size:.95rem;color:#334155;
                                             line-height:1.75;margin-top:.7rem}
    .showcase-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));
                   gap:0;border-bottom:1px solid #e2e8f0}
    .showcase-card{padding:1.15rem 1.25rem;border-right:1px solid #e2e8f0}
    .showcase-card:last-child{border-right:0}
    .showcase-card p,.showcase-card li{font-size:.88rem;color:#475569;line-height:1.62}
    .showcase-card ul{padding-left:1.15rem;display:grid;gap:.4rem}
    .showcase-edition{padding:1.3rem 1.4rem}
    .showcase-edition-head{display:flex;align-items:flex-start;justify-content:space-between;
                           gap:1rem;margin-bottom:.85rem}
    .showcase-edition-head h2{margin:0}
    .showcase-verified{font-size:.78rem;font-weight:750;color:#267a42;
                       background:#edf9f0;border:1px solid #c9ead2;border-radius:999px;
                       padding:.28rem .65rem;white-space:nowrap}
    .showcase-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));
                    border:1px solid #e2e8f0;border-radius:.6rem;overflow:hidden}
    .showcase-fact{display:grid;grid-template-columns:130px 1fr;gap:.65rem;
                   padding:.62rem .75rem;border-bottom:1px solid #eef2f7}
    .showcase-fact:nth-child(odd){border-right:1px solid #eef2f7}
    .showcase-fact:nth-last-child(-n+2){border-bottom:0}
    .showcase-fact dt{font-size:.8rem;font-weight:800;color:#334155}
    .showcase-fact dd{font-size:.82rem;color:#475569;min-width:0}
    .showcase-links{display:flex;flex-wrap:wrap;gap:.55rem 1rem;margin-top:1rem}
    .showcase-links a{font-size:.84rem;font-weight:800;color:#8f4436;text-decoration:none}
    .showcase-links a:hover{text-decoration:underline}
    .showcase-links a:focus-visible{outline:2px solid #a94e3d;outline-offset:2px}
    @media(max-width:760px){
      .showcase-grid{grid-template-columns:1fr}
      .showcase-card{border-right:0;border-bottom:1px solid #e2e8f0}
      .showcase-card:last-child{border-bottom:0}
      .showcase-edition-head{display:block}
      .showcase-verified{display:inline-block;margin-top:.55rem;white-space:normal}
      .showcase-facts{grid-template-columns:1fr}
      .showcase-fact,.showcase-fact:nth-child(odd){border-right:0;border-bottom:1px solid #eef2f7}
      .showcase-fact:last-child{border-bottom:0}
    }
    @media(max-width:430px){
      .showcase-intro,.showcase-edition{padding:1.05rem}
      .showcase-card{padding:1rem 1.05rem}
      .showcase-fact{grid-template-columns:105px 1fr}
    }
  `;
}

function enrichCatalogBreadcrumbSchema(html) {
  return html.replace(JSON_LD_RE, (full, rawJson) => {
    let schema;
    try {
      schema = JSON.parse(rawJson);
    } catch {
      return full;
    }
    if (schema?.['@type'] !== 'BreadcrumbList' || !Array.isArray(schema.itemListElement) || schema.itemListElement.length === 0) {
      return full;
    }
    const current = schema.itemListElement.at(-1);
    schema.itemListElement = [
      { '@type': 'ListItem', position: 1, name: 'Inicio', item: `${BASE}/` },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Catálogo',
        item: `${BASE}${CATALOG_PATH}`,
      },
      { ...current, position: 3 },
    ];
    return `<script type="application/ld+json">${serializeSchema(schema)}</script>`;
  });
}

// SEO-ACTIVE-CATALOG-BREADCRUMB: las fichas realmente disponibles recuperan
// un enlace HTML rastreable hacia /catalogo y el mismo nivel en BreadcrumbList.
// No se aplica a pausadas: la cohorte SEO conserva su rama específica
// Inicio → Libros por encargo → ficha, y las pausadas fuera de cohorte no se
// mezclan en este lote.
export function enrichActiveCatalogBreadcrumbHtml(html) {
  const source = String(html || '');
  if (!source.includes(ACTIVE_PAGE_MARKER)) return source;

  let result = source;
  if (!result.includes(`<a href="${CATALOG_PATH}">Catálogo</a>`)) {
    result = result.replace(
      BREADCRUMB_RE,
      `<nav>\n  <a href="/">Inicio</a> ›\n  <a href="${CATALOG_PATH}">Catálogo</a> ›\n  <span>`,
    );
  }
  return enrichCatalogBreadcrumbSchema(result);
}

function enrichBreadcrumbSchema(html) {
  return html.replace(JSON_LD_RE, (full, rawJson) => {
    let schema;
    try {
      schema = JSON.parse(rawJson);
    } catch {
      return full;
    }
    if (schema?.['@type'] !== 'BreadcrumbList' || !Array.isArray(schema.itemListElement)) {
      return full;
    }
    const current = schema.itemListElement.at(-1) || {};
    schema.itemListElement = [
      { '@type': 'ListItem', position: 1, name: 'Inicio', item: `${BASE}/` },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Libros por encargo',
        item: `${BASE}${ORDER_HUB_PATH}`,
      },
      { ...current, position: 3 },
    ];
    return `<script type="application/ld+json">${serializeSchema(schema)}</script>`;
  });
}

export function enrichByRequestProductHtml(html, productId) {
  const source = String(html || '');
  const hasGenericOrderCopy = source.includes(ORDER_BOX_GENERIC_COPY);
  const hasLeadTime = source.includes('class="order-lead-time"');

  // El copy exacto de la caja es la señal de una ficha pausada. Las fichas
  // activas en moneda no-UYU también usan .order-box, pero tienen otro texto:
  // nunca deben recibir el plazo de un encargo.
  const isPausedPage = (hasGenericOrderCopy || hasLeadTime) &&
    !source.includes('class="badge in-stock"');
  if (!isPausedPage) return source;

  // CX-POR-ENCARGO-ALL: el plazo aprobado es una condición operativa común,
  // no una regla SEO. Se muestra en toda ficha pausada válida, aunque sea
  // noindex, sin alterar precio, Offer, canonical, robots ni disponibilidad.
  let result = hasGenericOrderCopy
    ? source.replace(ORDER_BOX_GENERIC_COPY, ORDER_BOX_LEAD_TIME_COPY)
    : source;
  if (!result.includes(ORDER_LEAD_TIME_STYLE_MARKER)) {
    result = result.replace('</style>', `${leadTimeStyles()}\n  </style>`);
  }

  const hubPage = orderHubPageForProductId(productId);
  if (!hubPage || result.includes('class="order-hub-links"')) return result;

  // La cohorte es estática durante el lote SEO, pero un título puede volver a
  // stock antes de regenerarla. La guarda isPausedPage evita etiquetar como
  // "por encargo" una ficha que ya volvió a estar disponible.
  result = result.replace(
    BREADCRUMB_RE,
    `<nav>\n  <a href="/">Inicio</a> ›\n  <a href="${ORDER_HUB_PATH}">Libros por encargo</a> ›\n  <span>`,
  );
  result = enrichBreadcrumbSchema(result);

  const exactHubPath = orderHubPath(hubPage);
  const exactLinkLabel = hubPage === 1
    ? 'Volver a la colección donde aparece este título →'
    : `Volver a la página ${hubPage} donde aparece este título →`;
  const rootLink = hubPage > 1
    ? `<a href="${ORDER_HUB_PATH}">Ver todo el catálogo por encargo</a>`
    : '';
  const block = `<section class="order-hub-links" aria-labelledby="order-hub-links-title">
    <h2 id="order-hub-links-title">Más libros por encargo</h2>
    <p>Este título forma parte de nuestra colección de libros que podemos buscar y cotizar. La edición, disponibilidad, precio y plazo se confirman antes de aceptar el encargo.</p>
    <div class="order-hub-actions">
      <a href="${exactHubPath}">${exactLinkLabel}</a>
      ${rootLink}
      <a href="/libros-agotados-importados-uruguay">Cómo funciona la búsqueda por encargo</a>
    </div>
  </section>`;

  result = result.replace('</main>', `${block}\n</main>`);
  result = result.replace('</style>', `${byRequestStyles()}\n  </style>`);
  return result;
}

function renderProductShowcase(config) {
  const paragraphs = config.summary
    .map(paragraph => `    <p>${escapeHtml(paragraph)}</p>`)
    .join('\n');
  const highlights = config.highlights
    .map(item => `        <li>${escapeHtml(item)}</li>`)
    .join('\n');
  const facts = config.editionFacts
    .map(({ label, value }) => `<div class="showcase-fact"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join('\n      ');
  const links = config.links
    .map(({ href, label }) => `<a href="${escapeHtml(href)}">${escapeHtml(label)} →</a>`)
    .join('\n      ');

  return `<section class="product-showcase" aria-labelledby="showcase-title">
  <div class="showcase-intro">
    <p class="showcase-eyebrow">${escapeHtml(config.eyebrow)}</p>
    <h2 id="showcase-title">¿De qué trata ${escapeHtml(config.h1)}?</h2>
${paragraphs}
  </div>
  <div class="showcase-grid">
    <section class="showcase-card" aria-labelledby="showcase-highlights-title">
      <h3 id="showcase-highlights-title">Qué vas a encontrar</h3>
      <ul>
${highlights}
      </ul>
    </section>
    <section class="showcase-card" aria-labelledby="showcase-audience-title">
      <h3 id="showcase-audience-title">¿Para quién es este libro?</h3>
      <p>${escapeHtml(config.audience)}</p>
    </section>
    <section class="showcase-card" aria-labelledby="showcase-author-title">
      <h3 id="showcase-author-title">Sobre Meg Meeker</h3>
      <p>${escapeHtml(config.authorBio)}</p>
    </section>
  </div>
  <section class="showcase-edition" aria-labelledby="showcase-edition-title">
    <div class="showcase-edition-head">
      <h2 id="showcase-edition-title">Ficha de esta edición</h2>
      <span class="showcase-verified">Edición identificada por ISBN</span>
    </div>
    <dl class="showcase-facts">
      ${facts}
    </dl>
    <div class="showcase-links">
      ${links}
    </div>
  </section>
</section>`;
}

function enrichShowcaseSchema(html, productId, config) {
  return html.replace(JSON_LD_RE, (full, rawJson) => {
    let schema;
    try {
      schema = JSON.parse(rawJson);
    } catch {
      return full;
    }

    if (schema?.['@type'] === 'BreadcrumbList' && Array.isArray(schema.itemListElement)) {
      const current = schema.itemListElement.at(-1);
      if (current) current.name = config.h1;
      return `<script type="application/ld+json">${serializeSchema(schema)}</script>`;
    }

    const rawType = schema?.['@type'];
    const types = Array.isArray(rawType) ? rawType : [rawType].filter(Boolean);
    if (!types.includes('Book') || String(schema.sku || '') !== productId) return full;

    const verified = config.schema;
    schema.name = verified.name;
    schema.alternateName = verified.alternateName;
    schema.description = verified.description;
    schema.isbn = verified.isbn;
    schema.numberOfPages = verified.numberOfPages;
    schema.inLanguage = verified.inLanguage;
    schema.bookFormat = verified.bookFormat;
    schema.bookEdition = verified.bookEdition;
    schema.datePublished = verified.datePublished;
    schema.genre = verified.genre;
    schema.publisher = { ...verified.publisher };
    schema.translator = { ...verified.translator };
    return `<script type="application/ld+json">${serializeSchema(schema)}</script>`;
  });
}

// FICHAS-VIDRIERA-1: capa editorial visible para un MLU/ISBN exacto. Usa la
// publicación de Mercado Libre como fuente de precio, stock, condición,
// imágenes y CTA, y agrega sólo contenido original + bibliografía verificada.
export function enrichProductShowcaseHtml(html, productId) {
  const source = String(html || '');
  const config = PRODUCT_SHOWCASE_OVERRIDES[productId];
  if (!config || source.includes(SHOWCASE_MARKER)) return source;

  let result = source.replace(
    PRODUCT_H1_RE,
    `<h1>${escapeHtml(config.h1)}</h1>\n    <p class="book-subtitle">${escapeHtml(config.subtitle)}</p>`,
  );
  result = result.replace(
    PRODUCT_NAV_RE,
    `$1${escapeHtml(config.h1)}$2`,
  );
  result = enrichShowcaseSchema(result, productId, config);
  result = result.replace('</main>', `${renderProductShowcase(config)}\n</main>`);
  if (!result.includes(SHOWCASE_STYLE_MARKER)) {
    result = result.replace('</style>', `${showcaseStyles()}\n  </style>`);
  }
  return result;
}

// SEO-PRODUCT-SCHEMA-1: Google exige que Product tenga al menos una señal
// elegible para fragmentos de producto (Offer, review o aggregateRating).
// Las fichas sin oferta real no deben fingir precio, disponibilidad ni reseñas:
// conservan toda la semántica bibliográfica como Book y dejan de declarar
// Product hasta que exista una señal elegible real.
export function normalizeProductSnippetSchemaHtml(html) {
  const source = String(html || '');
  return source.replace(JSON_LD_RE, (full, rawJson) => {
    let schema;
    try {
      schema = JSON.parse(rawJson);
    } catch {
      return full;
    }

    const rawType = schema?.['@type'];
    const types = Array.isArray(rawType) ? rawType : [rawType].filter(Boolean);
    if (!types.includes('Product') || !types.includes('Book')) return full;

    const hasEligibleProductSignal = Boolean(
      schema.offers || schema.review || schema.aggregateRating,
    );
    if (hasEligibleProductSignal) return full;

    schema['@type'] = 'Book';
    return `<script type="application/ld+json">${serializeSchema(schema)}</script>`;
  });
}

function productIdFromRequest(request) {
  try {
    return new URL(request.url).pathname.match(PRODUCT_PATH_RE)?.[1]?.toUpperCase() || null;
  } catch {
    return null;
  }
}

function responseWithBody(response, body) {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('etag');
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function onRequest(context) {
  const productId = productIdFromRequest(context.request);
  if (!productId) return context.next();

  const response = await context.next();
  const contentType = response.headers.get('content-type') || '';
  if (response.status !== 200 || !contentType.toLowerCase().includes('text/html')) {
    return response;
  }

  // Se inspecciona un clon. Si ninguna transformación aplica, se devuelve la
  // Response original con body, ETag y headers intactos. Si el HTML cambia,
  // responseWithBody descarta validators del contenido anterior.
  const html = await response.clone().text();
  const withCatalogBreadcrumb = enrichActiveCatalogBreadcrumbHtml(html);
  const withByRequestCx = enrichByRequestProductHtml(withCatalogBreadcrumb, productId);
  const withShowcase = enrichProductShowcaseHtml(withByRequestCx, productId);
  const enriched = normalizeProductSnippetSchemaHtml(withShowcase);
  if (enriched === html) return response;
  return responseWithBody(response, enriched);
}
