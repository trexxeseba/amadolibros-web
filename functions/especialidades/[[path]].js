import { BASE, fetchCatalog } from '../_shared/catalog.js';
import { slugify } from '../_shared/slug.js';
import {
  BRAND,
  faviconHeadHtml,
  footerHtml,
  FOOTER_STYLES,
  waFloatHtml,
  WA_FLOAT_STYLES,
} from '../_shared/brand.js';
import {
  dedupeSpecialtyItems,
  findSeoSpecialty,
  isSpecialtyMatch,
  SEO_SPECIALTIES,
  specialtyPath,
} from '../_shared/seo-specialties.js';
import {
  bookCoverUrl,
  CARD_IMAGE_SIZES,
  responsiveImage,
} from '../_shared/cloudflare-images.js';
import { buildWhatsAppMessage } from '../../shared/whatsapp-messages.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function secureImage(item) {
  const image = item?.pictures?.[0] || item?.thumbnail || '';
  return String(image).replace(/^http:/, 'https:');
}

function isAvailable(item) {
  return item?.status !== 'paused' && Number(item?.available_quantity || 0) > 0;
}

function errorPage() {
  return new Response('<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>Especialidad no encontrada | Amado Libros</title></head><body><main><h1>Especialidad no encontrada</h1><p><a href="/libros-agotados-importados-uruguay">Ver libros por encargo</a></p></main></body></html>', {
    status: 404,
    headers: { 'content-type': 'text/html;charset=UTF-8', 'cache-control': 'public,max-age=300' },
  });
}

function bookCard(item, useCloudflareImages) {
  const href = `/libro/${encodeURIComponent(item.id)}/${slugify(item.title)}`;
  const source = useCloudflareImages ? bookCoverUrl(item.id) : secureImage(item);
  const image = responsiveImage(source, {
    widths: [240, 360, 480],
    defaultWidth: 360,
    sizes: CARD_IMAGE_SIZES,
  });
  const price = Number(item.price || 0);
  const formattedPrice = price > 0 ? price.toLocaleString('es-UY') : '';
  const responsiveAttrs = image.srcset
    ? ` srcset="${escapeHtml(image.srcset)}" sizes="${escapeHtml(image.sizes)}"`
    : '';
  return `<article class="book-card">
    <a class="cover" href="${href}">${image.src
      ? `<img src="${escapeHtml(image.src)}"${responsiveAttrs} alt="${escapeHtml(item.title)}" loading="lazy" decoding="async" width="240" height="360">`
      : '<span aria-hidden="true">Libro sin imagen</span>'}</a>
    <div class="book-info"><p class="stock">Disponible</p><h3><a href="${href}">${escapeHtml(item.title)}</a></h3>
    ${item.author ? `<p class="author">${escapeHtml(item.author)}</p>` : ''}
    ${formattedPrice ? `<p class="price">$${formattedPrice} UYU</p>` : ''}
    <a class="book-link" href="${href}">Ver libro</a></div>
  </article>`;
}

export async function onRequest(ctx) {
  const parts = Array.isArray(ctx.params.path) ? ctx.params.path : [ctx.params.path].filter(Boolean);
  const specialty = parts.length === 1 ? findSeoSpecialty(String(parts[0]).toLowerCase()) : null;
  if (!specialty) return errorPage();

  const requestUrl = new URL(ctx.request.url);
  const hasParameters = requestUrl.search.length > 0;
  const isProduction = ctx.env?.APP_ENV === 'production';
  const robots = isProduction && !hasParameters ? 'index, follow' : 'noindex, follow';
  const canonical = `${BASE}${specialtyPath(specialty.id)}`;
  const catalog = await fetchCatalog(ctx);
  const items = dedupeSpecialtyItems((Array.isArray(catalog?.items) ? catalog.items : [])
    .filter(isAvailable)
    .filter(item => isSpecialtyMatch(item, specialty)))
    .slice(0, 24);
  const requestPath = `/pedir-libro?tipo=novedades-tecnicas&q=${encodeURIComponent(`Libros de ${specialty.name}`)}`;
  const waMessage = buildWhatsAppMessage({
    greeting: 'Hola, estoy buscando un libro en Amado Libros y quisiera que me ayudaran 😊',
    motive: 'Buscar un libro por encargo',
    book: `Libro de ${specialty.name}`,
    situation: 'Todavía no identifiqué la edición exacta',
    page: canonical,
    closing: 'Quisiera contarles qué libro necesito y saber si pueden conseguirlo. Gracias.',
  });
  const related = SEO_SPECIALTIES.filter(item => item.id !== specialty.id);

  const collectionSchema = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: specialty.h1,
    description: specialty.description,
    url: canonical,
    inLanguage: 'es',
    isPartOf: { '@type': 'WebSite', name: BRAND.name, url: BASE },
    publisher: { '@type': 'OnlineStore', '@id': `${BASE}/#bookstore`, name: BRAND.name, url: `${BASE}/` },
  };
  const itemListSchema = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `Catálogo de ${specialty.name}`,
    numberOfItems: items.length,
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.title,
      url: `${BASE}/libro/${item.id}/${slugify(item.title)}`,
    })),
  };
  const serviceSchema = {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: `Búsqueda por encargo de libros de ${specialty.name}`,
    description: specialty.description,
    url: canonical,
    areaServed: { '@type': 'Country', name: 'Uruguay' },
    serviceType: 'Búsqueda e importación de libros por encargo',
    provider: { '@type': 'OnlineStore', '@id': `${BASE}/#bookstore`, name: BRAND.name, url: `${BASE}/` },
  };
  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Inicio', item: `${BASE}/` },
      { '@type': 'ListItem', position: 2, name: 'Libros por encargo', item: `${BASE}/libros-agotados-importados-uruguay` },
      { '@type': 'ListItem', position: 3, name: specialty.name, item: canonical },
    ],
  };

  const html = `<!doctype html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(specialty.title)}</title><meta name="description" content="${escapeHtml(specialty.description)}"><meta name="robots" content="${robots}">
<link rel="canonical" href="${canonical}">${faviconHeadHtml()}
<meta property="og:type" content="website"><meta property="og:locale" content="es_UY"><meta property="og:site_name" content="${BRAND.name}">
<meta property="og:title" content="${escapeHtml(specialty.title)}"><meta property="og:description" content="${escapeHtml(specialty.description)}"><meta property="og:url" content="${canonical}"><meta property="og:image" content="${BASE}${BRAND.logo}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(specialty.title)}"><meta name="twitter:description" content="${escapeHtml(specialty.description)}"><meta name="twitter:image" content="${BASE}${BRAND.logo}">
<script type="application/ld+json">${safeJson(collectionSchema)}</script><script type="application/ld+json">${safeJson(itemListSchema)}</script><script type="application/ld+json">${safeJson(serviceSchema)}</script><script type="application/ld+json">${safeJson(breadcrumbSchema)}</script>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Inter,system-ui,sans-serif;background:#f8f5ef;color:#18120e;line-height:1.65}a{color:inherit}.head{background:#18120e;color:#fff}.head-in,.crumbs,main{max-width:1100px;margin:auto}.head-in{padding:.75rem 1rem}.brand{display:flex;align-items:center;gap:.7rem;text-decoration:none;font-weight:900}.brand img{width:50px;height:50px;object-fit:contain}.crumbs{padding:1rem;color:#6b6157;font-size:.84rem}.crumbs a{color:#a94e3d;text-decoration:none}main{padding:0 1rem 3rem}.hero{padding:clamp(1.4rem,5vw,3.5rem);background:#fff;border:1px solid #e2dbd0;border-radius:1.2rem}.eyebrow{color:#a94e3d;font-size:.73rem;font-weight:900;letter-spacing:.08em;text-transform:uppercase}h1{max-width:22ch;margin:.55rem 0 1rem;font:700 clamp(2rem,6vw,3.5rem)/1.06 Georgia,serif;letter-spacing:-.025em}.lead{max-width:72ch;color:#574d45;font-size:1.03rem}.actions{display:flex;flex-wrap:wrap;gap:.7rem;margin-top:1.4rem}.btn{display:inline-flex;min-height:48px;align-items:center;justify-content:center;padding:.72rem 1rem;border-radius:.7rem;text-decoration:none;font-weight:850}.primary{background:#18120e;color:#fff}.secondary{border:1px solid #d2c7bb;background:#f8f5ef}.truth{margin-top:1.2rem;padding:1rem;border-left:4px solid #e49982;background:#fff8f4;color:#6b4b3f}.section{padding-top:2.5rem}.section h2,.closing h2{font:700 clamp(1.45rem,4vw,2rem)/1.2 Georgia,serif}.section-intro{max-width:72ch;margin-top:.65rem;color:#6b6157}.topic-grid,.process-grid,.books-grid{display:grid;gap:1rem;margin-top:1.1rem}.card{padding:1.2rem;background:#fff;border:1px solid #e2dbd0;border-radius:.85rem}.card h3{font-size:1rem;margin-bottom:.35rem}.card p{color:#6b6157;font-size:.92rem}.books-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.book-card{overflow:hidden;background:#fff;border:1px solid #e2dbd0;border-radius:.85rem}.cover{display:flex;aspect-ratio:2/3;align-items:center;justify-content:center;background:#eee8df;color:#6b6157;text-decoration:none}.cover img{width:100%;height:100%;object-fit:contain;background:#fff}.book-info{display:flex;min-height:190px;flex-direction:column;padding:.8rem}.stock{color:#16763c;font-size:.72rem;font-weight:850;text-transform:uppercase}.book-info h3{margin-top:.35rem;font-size:.84rem;line-height:1.35}.book-info h3 a{text-decoration:none}.author{margin-top:.3rem;color:#6b6157;font-size:.75rem}.price{margin-top:.55rem;font-weight:900}.book-link{margin-top:auto;padding-top:.7rem;color:#a94e3d;font-size:.78rem;font-weight:850}.international{margin-top:2.5rem;padding:1.4rem;background:#fff;border:1px solid #e2dbd0;border-radius:1rem}.international p{max-width:75ch;margin-top:.6rem;color:#574d45}.links{display:flex;flex-wrap:wrap;gap:.55rem;margin-top:1rem}.links a{padding:.55rem .75rem;border:1px solid #e2dbd0;border-radius:999px;background:#fff;text-decoration:none;font-size:.8rem}.closing{margin-top:2.5rem;padding:1.5rem;border-radius:1rem;background:#18120e;color:#fff}.closing p{margin:.5rem 0 1rem;color:#d8d0c8}@media(min-width:650px){.books-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.topic-grid,.process-grid{grid-template-columns:repeat(3,1fr)}}@media(min-width:980px){.books-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}${FOOTER_STYLES}${WA_FLOAT_STYLES}</style></head>
<body><header class="head"><div class="head-in"><a class="brand" href="/"><img src="${BRAND.logo}" alt="${BRAND.logoAlt}" width="50" height="50"><span>Amado Libros</span></a></div></header>
<nav class="crumbs" aria-label="Migas de pan"><a href="/">Inicio</a> › <a href="/libros-agotados-importados-uruguay">Libros por encargo</a> › ${escapeHtml(specialty.name)}</nav>
<main><section class="hero"><p class="eyebrow">Ediciones de España, Argentina y otros mercados</p><h1>${escapeHtml(specialty.h1)}</h1><p class="lead">${escapeHtml(specialty.intro)}</p>
<div class="actions"><a class="btn primary" href="${requestPath}">Pedir una búsqueda</a><a class="btn secondary" href="/catalogo?q=${encodeURIComponent(specialty.name)}">Buscar en el catálogo</a></div>
<p class="truth"><strong>Información verificable:</strong> confirmamos título, autor, ISBN, editorial, edición, idioma, formato, precio y plazo. No prometemos disponibilidad ni presentamos una reimpresión como edición actualizada.</p></section>
<section class="section"><h2>Libros de ${escapeHtml(specialty.name)} disponibles</h2><p class="section-intro">Estos resultados provienen del catálogo vigente de Amado Libros. Si no aparece la referencia exacta, podés pedir una búsqueda manual.</p>
${items.length ? `<div class="books-grid">${items.map(item => bookCard(item, isProduction)).join('')}</div>` : `<div class="card"><h3>No hay coincidencias disponibles ahora</h3><p>La página sigue sirviendo para solicitar una edición concreta por encargo. Pasanos autor, ISBN, editorial o una foto de la tapa.</p></div>`}</section>
<section class="section"><h2>Áreas que podemos buscar</h2><div class="topic-grid">${specialty.topics.map(topic => `<article class="card"><h3>${escapeHtml(topic)}</h3><p>Buscamos por referencia bibliográfica y verificamos la edición antes de cotizar.</p></article>`).join('')}</div></section>
<section class="international"><h2>¿Consultás desde España o Latinoamérica?</h2><p>Podés enviarnos el país, la ciudad y los datos del libro. La venta, el medio de pago y un eventual envío internacional se confirman caso a caso antes de asumir cualquier compromiso. Los precios visibles en el catálogo están expresados en pesos uruguayos.</p><div class="actions"><a class="btn secondary" href="${requestPath}">Enviar país y libro buscado</a></div></section>
<section class="section"><h2>Cómo funciona la búsqueda</h2><div class="process-grid"><article class="card"><h3>1. Identificamos el libro</h3><p>Usamos título, autor, ISBN, editorial, edición o foto para evitar confusiones.</p></article><article class="card"><h3>2. Verificamos mercados</h3><p>Revisamos disponibilidad real en Uruguay, España, Argentina y otros orígenes pertinentes.</p></article><article class="card"><h3>3. Confirmamos antes de vender</h3><p>Informamos edición, formato, moneda, precio, plazo y destino posible antes de avanzar.</p></article></div></section>
<section class="section"><h2>Otras especialidades</h2><nav class="links" aria-label="Otras especialidades">${related.map(item => `<a href="${specialtyPath(item.id)}">${escapeHtml(item.name)}</a>`).join('')}</nav></section>
<section class="closing"><h2>¿Qué libro de ${escapeHtml(specialty.name)} necesitás?</h2><p>Mandanos la referencia y tu país. Una persona de Amado Libros revisa la búsqueda.</p><a class="btn secondary" href="${requestPath}">Pedir que lo busquemos</a></section></main>${footerHtml(undefined, canonical)}${waFloatHtml(waMessage, canonical)}</body></html>`;

  return new Response(html, {
    headers: { 'content-type': 'text/html;charset=UTF-8', 'cache-control': 'public,max-age=3600' },
  });
}
