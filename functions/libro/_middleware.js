import { BASE } from '../_shared/catalog.js';
import {
  ORDER_HUB_PATH,
  orderHubPageForProductId,
  orderHubPath,
} from '../_shared/order-hub.js';

const PRODUCT_PATH_RE = /^\/libro\/(MLU\d+)(?:\/|$)/i;
const BREADCRUMB_RE = /<nav>\s*<a href="\/">Inicio<\/a>\s*›\s*<span>/;
const JSON_LD_RE = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
const ORDER_BOX_GENERIC_COPY = '<span>Podemos intentar conseguirlo por encargo. Consultanos y verificamos disponibilidad, edición y precio.</span>';
const ORDER_BOX_LEAD_TIME_COPY = `<span class="order-lead-time"><b>Demora estimada: 15 a 20 días desde la confirmación.</b> Salvo demoras del proveedor, courier o aduana.</span>
      <span>Antes de avanzar verificamos disponibilidad, edición y precio.</span>`;

function byRequestStyles() {
  return `
    .order-box .order-lead-time{font-weight:650}
    .order-box .order-lead-time b{display:block;font-weight:850;color:#6b4218}
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
    const serialized = JSON.stringify(schema).replace(/</g, '\\u003c');
    return `<script type="application/ld+json">${serialized}</script>`;
  });
}

export function enrichByRequestProductHtml(html, productId) {
  const source = String(html || '');
  const hubPage = orderHubPageForProductId(productId);
  if (!hubPage || source.includes('class="order-hub-links"')) return source;

  // La cohorte es estática durante el lote SEO, pero un título puede volver a
  // stock antes de regenerarla. El HTML SSR es la última verdad comercial:
  // jamás etiquetar como "por encargo" una ficha que ya muestra stock activo.
  const isPausedPage = source.includes('class="order-box"') &&
    !source.includes('class="badge in-stock"');
  if (!isPausedPage) return source;

  // CX-POR-ENCARGO: la demora aprobada ya existe en la operación comercial.
  // Se muestra sólo en fichas pausadas de la cohorte, sin convertirla en una
  // promesa rígida ni alterar precio, disponibilidad, Offer o indexación.
  let result = source.replace(ORDER_BOX_GENERIC_COPY, ORDER_BOX_LEAD_TIME_COPY);
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

function productIdFromRequest(request) {
  try {
    return new URL(request.url).pathname.match(PRODUCT_PATH_RE)?.[1]?.toUpperCase() || null;
  } catch {
    return null;
  }
}

function responseWithBody(response, body, changed) {
  const headers = new Headers(response.headers);
  if (changed) {
    headers.delete('content-length');
    headers.delete('etag');
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function onRequest(context) {
  const productId = productIdFromRequest(context.request);
  if (!productId || orderHubPageForProductId(productId) == null) {
    return context.next();
  }

  const response = await context.next();
  const contentType = response.headers.get('content-type') || '';
  if (response.status !== 200 || !contentType.toLowerCase().includes('text/html')) {
    return response;
  }

  const html = await response.text();
  const enriched = enrichByRequestProductHtml(html, productId);
  return responseWithBody(response, enriched, enriched !== html);
}
