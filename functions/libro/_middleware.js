import { BASE } from '../_shared/catalog.js';
import {
  buildAutomaticProductShowcase,
  productItemFromProductHtml,
} from '../_shared/automatic-product-showcase.js';
import {
  ORDER_HUB_PATH,
  orderHubPageForProductId,
  orderHubPath,
} from '../_shared/order-hub.js';
import { isProductInShowcaseCohort } from '../_shared/showcase-cohort.js';
import { PRODUCT_SHOWCASE_OVERRIDES } from '../_shared/product-showcases.js';
import { applyShowcaseTitleQuality } from '../_shared/showcase-title-quality.js';
import { getBookEnrichmentByIsbn } from '../_shared/book-enrichment-registry.js';

const PRODUCT_PATH_RE = /^\/libro\/(MLU\d+)(?:\/|$)/i;
const BREADCRUMB_RE = /<nav>\s*<a href="\/">Inicio<\/a>\s*›\s*<span>/;
const PRODUCT_NAV_RE = /(<nav>[\s\S]*?<span>)[\s\S]*?(<\/span>\s*<\/nav>)/;
const PRODUCT_H1_RE = /<h1>[\s\S]*?<\/h1>/;
const JSON_LD_RE = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
const CATALOG_PATH = '/catalogo';
const ACTIVE_PAGE_MARKER = 'class="badge in-stock"';
const RELATED_BOOKS_MARKER = '<section class="related-books"';
const ORDER_BOX_GENERIC_COPY = '<span>Podemos intentar conseguirlo por encargo. Consultanos y verificamos disponibilidad, edición y precio.</span>';
const ORDER_BOX_LEAD_TIME_COPY = `<span class="order-lead-time"><b>Demora estimada: 15 a 20 días desde la confirmación.</b> Salvo demoras del proveedor, courier o aduana.</span>
      <span>Antes de avanzar verificamos disponibilidad, edición y precio.</span>`;
const ORDER_LEAD_TIME_STYLE_MARKER = '.order-box .order-lead-time{';
const SHOWCASE_MARKER = 'class="product-showcase"';
const SHOWCASE_STYLE_MARKER = '.product-showcase{';
const CATEGORY_TAGS_CACHE_TTL_MS = 5 * 60 * 1000;

let categoryTagsMemory = {
  expiresAt: 0,
  items: null,
};

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
    .showcase-sources{margin-top:.9rem;padding-top:.75rem;border-top:1px solid #eef2f7}
    .showcase-sources summary{cursor:pointer;font-size:.8rem;font-weight:800;color:#64748b}
    .showcase-source-links{display:flex;flex-wrap:wrap;gap:.45rem 1rem;margin-top:.55rem}
    .showcase-source-links a{font-size:.8rem;font-weight:750;color:#8f4436;text-decoration:none}
    .showcase-source-links a:hover{text-decoration:underline}
    .showcase-help{display:flex;align-items:center;justify-content:space-between;gap:1rem;
                   margin-top:1.15rem;padding:.85rem 1rem;background:#fff8f4;
                   border:1px solid #ecd1c6;border-radius:.65rem}
    .showcase-help p{margin:0;font-size:.9rem;font-weight:750;color:#4b342b;line-height:1.45}
    .showcase-help a{display:inline-flex;align-items:center;min-height:44px;flex:0 0 auto;
                     font-size:.86rem;font-weight:850;color:#8f4436;text-decoration:none}
    .showcase-help a:hover{text-decoration:underline}
    .showcase-help a:focus-visible{outline:2px solid #a94e3d;outline-offset:3px}
    @media(max-width:760px){
      .showcase-grid{grid-template-columns:1fr}
      .showcase-card{border-right:0;border-bottom:1px solid #e2e8f0}
      .showcase-card:last-child{border-bottom:0}
      .showcase-edition-head{display:block}
      .showcase-verified{display:inline-block;margin-top:.55rem;white-space:normal}
      .showcase-facts{grid-template-columns:1fr}
      .showcase-fact,.showcase-fact:nth-child(odd){border-right:0;border-bottom:1px solid #eef2f7}
      .showcase-fact:last-child{border-bottom:0}
      .showcase-help{align-items:flex-start;flex-direction:column;gap:.35rem}
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
  const isPausedPage = (hasGenericOrderCopy || hasLeadTime) &&
    !source.includes('class="badge in-stock"');
  if (!isPausedPage) return source;

  let result = hasGenericOrderCopy
    ? source.replace(ORDER_BOX_GENERIC_COPY, ORDER_BOX_LEAD_TIME_COPY)
    : source;
  if (!result.includes(ORDER_LEAD_TIME_STYLE_MARKER)) {
    result = result.replace('</style>', `${leadTimeStyles()}\n  </style>`);
  }

  const hubPage = orderHubPageForProductId(productId);
  if (!hubPage || result.includes('class="order-hub-links"')) return result;

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

// FICHAS-QUALITY-GUARD-1: helper local — una sección sólo se renderiza si
// tiene texto real, no espacios en blanco.
function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function renderProductShowcase(config, productId) {
  const paragraphs = (Array.isArray(config.summary) ? config.summary : [])
    .map(paragraph => `    <p>${escapeHtml(paragraph)}</p>`)
    .join('\n');
  const highlights = (Array.isArray(config.highlights) ? config.highlights : [])
    .map(item => `        <li>${escapeHtml(item)}</li>`)
    .join('\n');
  const facts = (Array.isArray(config.editionFacts) ? config.editionFacts : [])
    .map(({ label, value }) => `<div class="showcase-fact"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join('\n      ');
  const links = (Array.isArray(config.links) ? config.links : [])
    .map(({ href, label }) => `<a href="${escapeHtml(href)}">${escapeHtml(label)} →</a>`)
    .join('\n      ');
  const linksHtml = links
    ? `<div class="showcase-links">\n      ${links}\n    </div>`
    : '';
  const sourceLinks = (Array.isArray(config.sources) ? config.sources : [])
    // La corroboración comercial queda en la trazabilidad interna, pero la
    // ficha no deriva compradores hacia otros comercios. Sólo se muestran
    // fuentes editoriales o bibliográficas primarias.
    .filter(source => source?.type !== 'commercial_reference')
    .filter(source => /^https:\/\//i.test(String(source?.url || '')))
    .slice(0, 3)
    .map(source => `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.provider || 'Fuente bibliográfica')}</a>`)
    .join('\n        ');
  const sourcesHtml = sourceLinks
    ? `<details class="showcase-sources"><summary>Fuentes bibliográficas consultadas</summary><div class="showcase-source-links">\n        ${sourceLinks}\n      </div></details>`
    : '';
  const requestQuery = new URLSearchParams({
    tipo: 'exacto',
    q: String(config.h1 || ''),
    origen: 'ficha',
  });
  if (productId) requestQuery.set('libro', productId);
  const requestHelp = config.requestHelp || {
    question: '¿Buscás otro libro o una edición específica?',
    href: `/pedir-libro?${requestQuery.toString()}`,
    label: 'Contanos qué buscás',
  };
  const requestHelpHtml = `<aside class="showcase-help" aria-label="Ayuda para encontrar otro libro">
      <p>${escapeHtml(requestHelp.question)}</p>
      <a href="${escapeHtml(requestHelp.href)}">${escapeHtml(requestHelp.label)} →</a>
    </aside>`;

  // FICHAS-QUALITY-GUARD-1: cada tarjeta se emite sólo si tiene contenido
  // real. Una sección vacía o rellenada con frases genéricas ocupa espacio
  // comercial sin informar; es preferible una ficha más corta y honesta.
  const cards = [
    highlights
      ? `    <section class="showcase-card" aria-labelledby="showcase-highlights-title">
      <h3 id="showcase-highlights-title">${escapeHtml(config.highlightsHeading || 'Datos destacados')}</h3>
      <ul>
${highlights}
      </ul>
    </section>`
      : '',
    hasText(config.audience)
      ? `    <section class="showcase-card" aria-labelledby="showcase-audience-title">
      <h3 id="showcase-audience-title">${escapeHtml(config.audienceHeading || '¿Para quién es este libro?')}</h3>
      <p>${escapeHtml(config.audience)}</p>
    </section>`
      : '',
    hasText(config.authorBio)
      ? `    <section class="showcase-card" aria-labelledby="showcase-author-title">
      <h3 id="showcase-author-title">${escapeHtml(config.authorHeading || 'Sobre la autoría')}</h3>
      <p>${escapeHtml(config.authorBio)}</p>
    </section>`
      : '',
  ].filter(Boolean);
  const gridHtml = cards.length
    ? `  <div class="showcase-grid">\n${cards.join('\n')}\n  </div>\n`
    : '';

  return `<section class="product-showcase" aria-labelledby="showcase-title">
  <div class="showcase-intro">
    <p class="showcase-eyebrow">${escapeHtml(config.eyebrow)}</p>
    <h2 id="showcase-title">${escapeHtml(config.introHeading || `¿De qué trata ${config.h1}?`)}</h2>
${paragraphs}
  </div>
${gridHtml}  <section class="showcase-edition" aria-labelledby="showcase-edition-title">
    <div class="showcase-edition-head">
      <h2 id="showcase-edition-title">${escapeHtml(config.editionHeading || 'Ficha de esta edición')}</h2>
      <span class="showcase-verified">${escapeHtml(config.verifiedLabel || 'Datos tomados de la publicación')}</span>
    </div>
    <dl class="showcase-facts">
      ${facts}
    </dl>
    ${linksHtml}
    ${sourcesHtml}
    ${requestHelpHtml}
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

function enrichAutomaticShowcaseSchema(html, productId, config) {
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
    if (!types.includes('Book') || String(schema.sku || '').toUpperCase() !== productId) return full;

    if (config.titleChanged) {
      schema.name = config.h1;
      if (!schema.alternateName && config.rawTitle) schema.alternateName = config.rawTitle;
    }
    schema.description = config.schemaDescription;
    if (config.schemaVerified?.inLanguage) schema.inLanguage = config.schemaVerified.inLanguage;
    if (config.schemaVerified?.bookFormat) schema.bookFormat = config.schemaVerified.bookFormat;
    if (config.schemaVerified?.bookEdition) schema.bookEdition = config.schemaVerified.bookEdition;
    return `<script type="application/ld+json">${serializeSchema(schema)}</script>`;
  });
}

function replaceDescriptionMeta(html, config) {
  const safeDescription = escapeHtml(config.metaDescription);
  return html
    .replace(
      /<meta\s+name="description"\s+content="[^"]*">/,
      `<meta name="description" content="${safeDescription}">`,
    )
    .replace(
      /<meta\s+property="og:description"\s+content="[^"]*">/,
      `<meta property="og:description" content="${safeDescription}">`,
    )
    .replace(
      /<meta\s+name="twitter:description"\s+content="[^"]*">/,
      `<meta name="twitter:description" content="${safeDescription}">`,
    );
}

function replaceTitleMeta(html, config) {
  const safeTitle = escapeHtml(config.seoTitle || `${config.h1} | Amado Libros`);
  return html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${safeTitle}</title>`)
    .replace(
      /<meta\s+property="og:title"\s+content="[^"]*">/,
      `<meta property="og:title" content="${safeTitle}">`,
    )
    .replace(
      /<meta\s+name="twitter:title"\s+content="[^"]*">/,
      `<meta name="twitter:title" content="${safeTitle}">`,
    );
}

function insertShowcaseBeforeRelated(html, block) {
  const index = html.indexOf(RELATED_BOOKS_MARKER);
  if (index >= 0) return `${html.slice(0, index)}${block}\n  ${html.slice(index)}`;
  return html.replace('</main>', `${block}\n</main>`);
}

export function enrichAutomaticProductShowcaseHtml(html, productId, options = {}) {
  const source = String(html || '');
  const id = String(productId || '').toUpperCase();
  if (!source.includes(ACTIVE_PAGE_MARKER) ||
      source.includes(SHOWCASE_MARKER) ||
      PRODUCT_SHOWCASE_OVERRIDES[id]) {
    return source;
  }

  const item = productItemFromProductHtml(source, id);
  const enrichment = getBookEnrichmentByIsbn(item?.isbn);
  const baseConfig = buildAutomaticProductShowcase(item, { ...options, enrichment });
  const config = applyShowcaseTitleQuality(baseConfig, item);
  if (!config) return source;

  let result = source.replace(
    PRODUCT_H1_RE,
    `<h1>${escapeHtml(config.h1)}</h1>${config.subtitle ? `\n    <p class="book-subtitle">${escapeHtml(config.subtitle)}</p>` : ''}`,
  );
  result = result.replace(
    PRODUCT_NAV_RE,
    `$1${escapeHtml(config.h1)}$2`,
  );
  result = replaceTitleMeta(result, config);
  result = replaceDescriptionMeta(result, config);
  result = enrichAutomaticShowcaseSchema(result, id, config);
  result = insertShowcaseBeforeRelated(result, renderProductShowcase(config, id));
  if (!result.includes(SHOWCASE_STYLE_MARKER)) {
    result = result.replace('</style>', `${showcaseStyles()}\n  </style>`);
  }
  return result;
}

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
  result = result.replace('</main>', `${renderProductShowcase(config, productId)}\n</main>`);
  if (!result.includes(SHOWCASE_STYLE_MARKER)) {
    result = result.replace('</style>', `${showcaseStyles()}\n  </style>`);
  }
  return result;
}

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

async function classificationTagsForProduct(context, productId) {
  const now = Date.now();
  if (categoryTagsMemory.items && categoryTagsMemory.expiresAt > now) {
    return categoryTagsMemory.items[productId] || [];
  }

  try {
    const url = new URL('/data/active-categories.json', context.request.url).toString();
    const cache = caches.default;
    const cacheKey = new Request(url);
    let response = await cache.match(cacheKey);
    if (!response) {
      const fetched = await fetch(url);
      if (!fetched.ok) return [];
      response = new Response(fetched.body, {
        status: fetched.status,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300',
        },
      });
      if (typeof context?.waitUntil === 'function') {
        context.waitUntil(cache.put(cacheKey, response.clone()));
      }
    }
    const payload = await response.json();
    if (!payload?.items || typeof payload.items !== 'object') return [];
    categoryTagsMemory = {
      expiresAt: now + CATEGORY_TAGS_CACHE_TTL_MS,
      items: payload.items,
    };
    return payload.items[productId] || [];
  } catch {
    return [];
  }
}

export async function onRequest(context) {
  const productId = productIdFromRequest(context.request);
  if (!productId) return context.next();

  const response = await context.next();
  const contentType = response.headers.get('content-type') || '';
  if (response.status !== 200 || !contentType.toLowerCase().includes('text/html')) {
    return response;
  }

  const html = await response.clone().text();
  const withCatalogBreadcrumb = enrichActiveCatalogBreadcrumbHtml(html);
  const withByRequestCx = enrichByRequestProductHtml(withCatalogBreadcrumb, productId);

  let withAutomaticShowcase = withByRequestCx;
  if (withByRequestCx.includes(ACTIVE_PAGE_MARKER) && !PRODUCT_SHOWCASE_OVERRIDES[productId]) {
    // Una investigación por ISBN pertenece a la EDICIÓN y debe beneficiar a
    // todas sus publicaciones compatibles, aunque un duplicado concreto no
    // haya quedado dentro de la cohorte general de 3.000 fichas.
    const extractedItem = productItemFromProductHtml(withByRequestCx, productId);
    const hasVerifiedEnrichment = Boolean(getBookEnrichmentByIsbn(extractedItem?.isbn));
    const selected = hasVerifiedEnrichment || await isProductInShowcaseCohort(context, productId);
    if (selected) {
      const classificationTags = await classificationTagsForProduct(context, productId);
      withAutomaticShowcase = enrichAutomaticProductShowcaseHtml(
        withByRequestCx,
        productId,
        { classificationTags },
      );
    }
  }

  const withShowcase = enrichProductShowcaseHtml(withAutomaticShowcase, productId);
  const enriched = normalizeProductSnippetSchemaHtml(withShowcase);
  if (enriched === html) return response;
  return responseWithBody(response, enriched);
}
