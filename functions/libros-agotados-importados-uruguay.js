/**
 * Landing comercial indexable para búsquedas de libros agotados, importados
 * y difíciles de conseguir. No publica inventario ni promete disponibilidad:
 * explica el servicio de búsqueda por encargo y deriva la consulta a WhatsApp.
 */

import { BASE } from './_shared/catalog.js';
import {
    BRAND,
    faviconHeadHtml,
    footerHtml,
    FOOTER_STYLES,
    waFloatHtml,
    WA_FLOAT_STYLES,
    waHref,
} from './_shared/brand.js';
import { SEO_SPECIALTIES, specialtyPath } from './_shared/seo-specialties.js';
import { buildWhatsAppMessage } from '../shared/whatsapp-messages.js';

const PATH = '/libros-agotados-importados-uruguay';
const TITLE = 'Libros agotados e importados en Uruguay | Amado Libros';
const DESCRIPTION = 'Buscamos libros agotados, importados y difíciles de conseguir en Europa y otros mercados. Consultá por título, autor, ISBN o foto desde Uruguay.';
const LAST_REVIEWED_ISO = '2026-11-05';

export async function onRequest() {
    const canonical = `${BASE}${PATH}`;
    const REQUEST_MESSAGE = buildWhatsAppMessage({
        greeting: 'Hola, estoy buscando un libro en Amado Libros y quisiera que me ayudaran 😊',
        motive: 'Solicitar una búsqueda por encargo',
        situation: 'Libro agotado, importado o difícil de conseguir',
        page: canonical,
        closing: 'Quisiera pasarles el título, autor, ISBN o una foto de la tapa para que puedan buscarlo. Gracias.',
    });
    const requestHref = waHref(REQUEST_MESSAGE);
    const schema = {
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'OnlineStore',
                '@id': `${BASE}/#bookstore`,
                'name': BRAND.name,
                'url': `${BASE}/`,
                'logo': `${BASE}/images/logo-amado.webp`,
                'telephone': '+59899841325',
                'email': 'adm@amadolibros.com',
            },
            {
                '@type': 'WebPage',
                '@id': `${canonical}#webpage`,
                'url': canonical,
                'name': TITLE,
                'description': DESCRIPTION,
                'dateModified': LAST_REVIEWED_ISO,
                'reviewedBy': { '@id': `${BASE}/#bookstore` },
                'mainEntity': { '@id': `${canonical}#service` },
                'inLanguage': 'es-UY',
            },
            {
                '@type': 'Service',
                '@id': `${canonical}#service`,
                'name': 'Búsqueda de libros agotados e importados por encargo',
                'description': DESCRIPTION,
                'url': canonical,
                'areaServed': { '@type': 'Country', 'name': 'Uruguay' },
                'provider': { '@id': `${BASE}/#bookstore` },
            },
            {
                '@type': 'BreadcrumbList',
                'itemListElement': [
                    {
                        '@type': 'ListItem',
                        'position': 1,
                        'name': 'Inicio',
                        'item': `${BASE}/`,
                    },
                    {
                        '@type': 'ListItem',
                        'position': 2,
                        'name': 'Libros agotados e importados',
                        'item': canonical,
                    },
                ],
            },
        ],
    };

    const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${TITLE}</title>
  <meta name="description" content="${DESCRIPTION}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${canonical}">
  ${faviconHeadHtml()}
  <meta property="og:type" content="website">
  <meta property="og:locale" content="es_UY">
  <meta property="og:site_name" content="${BRAND.name}">
  <meta property="og:title" content="${TITLE}">
  <meta property="og:description" content="${DESCRIPTION}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${BASE}/images/logo-amado.webp">
  <meta property="og:image:alt" content="Amado Libros, librería uruguaya">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${TITLE}">
  <meta name="twitter:description" content="${DESCRIPTION}">
  <meta name="twitter:image" content="${BASE}/images/logo-amado.webp">
  <script type="application/ld+json">${JSON.stringify(schema)}</script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:#f8f5ef;color:#18120e;line-height:1.65}
    a{color:inherit}
    .site-header{background:#18120e;color:#fff}
    .header-inner{max-width:1100px;margin:0 auto;padding:.75rem 1rem;display:flex;align-items:center;gap:.75rem}
    .brand-link{display:flex;align-items:center;gap:.7rem;text-decoration:none;font-weight:800}
    .brand-link img{width:58px;height:57px;object-fit:contain}
    .crumbs{max-width:1100px;margin:0 auto;padding:1rem;color:#6b6157;font-size:.85rem}
    .crumbs a{color:#a94e3d;text-decoration:none}
    main{max-width:1100px;margin:0 auto;padding:1rem 1rem 3rem}
    .hero{display:grid;gap:1.5rem;padding:clamp(1.5rem,5vw,3.5rem);background:#fff;border:1px solid #e2dbd0;border-radius:1.25rem;box-shadow:0 12px 36px rgba(24,18,14,.06)}
    .eyebrow{color:#a94e3d;font-size:.75rem;font-weight:800;letter-spacing:.09em;text-transform:uppercase}
    h1{max-width:18ch;margin-top:.55rem;font-family:Georgia,"Times New Roman",serif;font-size:clamp(2rem,7vw,3.6rem);line-height:1.05;letter-spacing:-.03em}
    .lead{max-width:64ch;margin-top:1rem;color:#574d45;font-size:1.05rem}
    .social-proof{display:flex;flex-wrap:wrap;gap:.35rem .65rem;align-items:center;margin-top:1.15rem;color:#4e453d;font-size:.87rem;font-weight:700}
    .social-proof span+span::before{content:'·';margin-right:.65rem;color:#b9a99a}
    .social-proof a{color:#8f4436;text-underline-offset:.18em}
    .cta-row{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.35rem}
    .cta{display:inline-flex;min-height:48px;align-items:center;justify-content:center;padding:.75rem 1.1rem;border-radius:.7rem;text-decoration:none;font-weight:800}
    .cta-primary{background:#25d366;color:#102516}
    .cta-secondary{border:1px solid #d2c7bb;background:#f8f5ef}
    .truth{padding:1rem;border-left:4px solid #e49982;background:#fff8f4;color:#6b4b3f;font-size:.9rem}
    .quick-form{padding:1.25rem;background:#f8f5ef;border:1px solid #e2dbd0;border-radius:1rem}
    .quick-form h2{font-family:Inter,system-ui,sans-serif;font-size:1.1rem;line-height:1.3}
    .quick-form>p{margin:.3rem 0 .9rem;color:#6b6157;font-size:.88rem}
    .quick-form label{display:block;margin:.7rem 0 .2rem;font-size:.82rem;font-weight:800}
    .quick-form input{display:block;width:100%;min-height:44px;padding:.65rem .75rem;border:1px solid #bfb3a6;border-radius:.55rem;background:#fff;color:#18120e;font:inherit}
    .quick-form input:focus-visible{outline:3px solid #d3a18e;outline-offset:1px}
    .quick-form button{width:100%;margin-top:1rem;border:0;cursor:pointer;font:inherit}
    .quick-form small{display:block;margin-top:.6rem;color:#6b6157;font-size:.75rem;line-height:1.4}
    .hero-aside{display:grid;align-content:start;gap:1rem}
    .reviewed{margin-top:.85rem;color:#756a61;font-size:.78rem}.reviewed a{color:#8f4436;font-weight:700;text-underline-offset:.15em}
    .section{padding:2.5rem 0 0}
    h2{font-family:Georgia,"Times New Roman",serif;font-size:clamp(1.45rem,4vw,2rem);line-height:1.2}
    .steps,.types{display:grid;gap:1rem;margin-top:1.25rem}
    .card{padding:1.2rem;background:#fff;border:1px solid #e2dbd0;border-radius:.85rem}
    .step-number{display:inline-grid;width:2rem;height:2rem;place-items:center;margin-bottom:.65rem;border-radius:50%;background:#18120e;color:#fff;font-weight:800}
    .card h3{font-size:1rem;margin-bottom:.35rem}
    .card p{color:#6b6157;font-size:.92rem}
    .closing{margin-top:2.5rem;padding:1.5rem;background:#18120e;color:#fff;border-radius:1rem}
    .closing p{margin:.5rem 0 1rem;color:rgba(255,255,255,.72)}
    .specialties{display:flex;flex-wrap:wrap;gap:.55rem;margin-top:1.25rem}.specialties a{padding:.55rem .75rem;border:1px solid #e2dbd0;border-radius:999px;background:#fff;text-decoration:none;font-size:.82rem}
    .guide-link{margin-top:1rem;color:#6b6157}.guide-link a{color:#8f4436;font-weight:700;text-underline-offset:.15em}
    .faq-list{display:grid;gap:.7rem;margin-top:1.25rem}
    .faq-list details{padding:1rem 1.15rem;background:#fff;border:1px solid #e2dbd0;border-radius:.8rem}
    .faq-list summary{cursor:pointer;font-weight:800;line-height:1.4}
    .faq-list details p{margin-top:.65rem;color:#574d45;font-size:.94rem}
    @media(min-width:720px){.hero{grid-template-columns:1.45fr .75fr;align-items:center}.steps{grid-template-columns:repeat(3,1fr)}.types{grid-template-columns:repeat(2,1fr)}}
    ${FOOTER_STYLES}
    ${WA_FLOAT_STYLES}
  </style>
</head>
<body>
  <header class="site-header">
    <div class="header-inner">
      <a class="brand-link" href="/" aria-label="Amado Libros — inicio">
        <img src="${BRAND.logo}" alt="${BRAND.logoAlt}" width="58" height="57">
        <span>Amado Libros</span>
      </a>
    </div>
  </header>
  <nav class="crumbs" aria-label="Migas de pan"><a href="/">Inicio</a> › Libros agotados e importados</nav>
  <main>
    <section class="hero">
      <div>
        <p class="eyebrow">Búsqueda por encargo desde Uruguay</p>
        <h1>Conseguimos libros agotados, importados y difíciles de encontrar</h1>
        <p class="lead">Si no aparece en el catálogo local, lo buscamos por título, autor, ISBN o foto de la tapa. Consultamos opciones en Europa y otros mercados y te confirmamos edición, precio y plazo antes de avanzar.</p>
        <p class="social-proof" aria-label="Confianza y trayectoria de Amado Libros">
          <span>4,9 en Google · 74 reseñas</span>
          <span><a href="https://www.mercadolibre.com.uy/tienda/amado-libros-libreria-en-linea" target="_blank" rel="noopener noreferrer">Tienda Oficial en Mercado Libre Uruguay</a></span>
        </p>
        <div class="cta-row">
          <a class="cta cta-primary" href="${requestHref}" target="_blank" rel="noopener noreferrer">Pedir búsqueda por WhatsApp</a>
          <a class="cta cta-secondary" href="/pedir-libro/?tipo=agotado">Formulario completo</a>
        </div>
        <p class="guide-link"><a href="/catalogo">¿Querés ver primero los libros disponibles? Buscá en el catálogo.</a></p>
      </div>
      <div class="hero-aside">
        <form id="encargo-quick-form" class="quick-form" action="/pedir-libro/" method="get">
          <h2>Contanos qué libro buscás</h2>
          <p>Con el título o lo que recuerdes alcanza para empezar.</p>
          <input type="hidden" name="tipo" value="agotado">
          <label for="encargo-titulo">Título o tema del libro</label>
          <input id="encargo-titulo" name="q" type="text" minlength="2" maxlength="200" required autocomplete="off" placeholder="Ej.: un libro de psicología agotado">
          <label for="encargo-autor">Autor, editorial o ISBN (opcional)</label>
          <input id="encargo-autor" name="autor" type="text" maxlength="150" autocomplete="off" placeholder="Cualquier dato que tengas">
          <button class="cta cta-primary" type="submit">Enviar consulta por WhatsApp</button>
          <small>La web no guarda estos datos. Se abre WhatsApp con tu consulta lista para enviar. Si no se abre, podés usar el formulario completo.</small>
        </form>
        <p class="truth"><strong>Respuesta directa:</strong> sí, en muchos casos un libro agotado o fuera de plaza puede conseguirse por encargo desde Uruguay. No podemos asegurar disponibilidad antes de buscar: verificamos título o ISBN, edición, proveedor, precio y plazo para cada consulta.</p>
        <p class="reviewed">Contenido revisado el 5 de noviembre de 2026 por el <a href="/quienes-somos/">equipo de Amado Libros</a>.</p>
      </div>
    </section>

    <section class="section">
      <h2>Cómo pedir un libro por encargo</h2>
      <div class="steps">
        <article class="card"><span class="step-number">1</span><h3>Mandanos los datos</h3><p>Título, autor, ISBN, editorial o una foto. Cuanta más precisión tengamos, mejor podemos buscar la edición correcta.</p></article>
        <article class="card"><span class="step-number">2</span><h3>Buscamos y verificamos</h3><p>Revisamos disponibilidad en proveedores del exterior y comparamos edición, idioma, formato y estado.</p></article>
        <article class="card"><span class="step-number">3</span><h3>Vos decidís</h3><p>Te informamos precio, seña y plazo estimado. La gestión empieza únicamente después de tu confirmación.</p></article>
      </div>
      <p class="guide-link">¿No sabés si una publicación corresponde a la que necesitás? Consultá la <a href="/como-identificar-edicion-correcta-isbn/">guía para identificar la edición correcta por ISBN</a>.</p>
      <p class="guide-link">Conocé también <a href="/quienes-somos/">quién revisa las búsquedas y cómo verificamos cada edición</a>.</p>
    </section>

    <section class="section">
      <h2>Qué podemos buscar</h2>
      <div class="types">
        <article class="card"><h3>Ediciones agotadas o fuera de plaza</h3><p>Buscamos ejemplares que ya no aparecen en librerías uruguayas, siempre sujetos a disponibilidad real.</p></article>
        <article class="card"><h3>Libros importados de Europa y otros mercados</h3><p>Consultamos ediciones de España, Argentina, Estados Unidos y otros orígenes según el título.</p></article>
        <article class="card"><h3>Textos académicos y profesionales</h3><p>Material especializado, manuales, libros universitarios y ediciones concretas identificadas por ISBN.</p></article>
        <article class="card"><h3>Idiomas, formatos y ediciones específicas</h3><p>Tapa dura o blanda, idioma original, editorial determinada o una edición que querés volver a encontrar.</p></article>
      </div>
    </section>

    <section class="section">
      <h2>Preguntas frecuentes sobre libros por encargo</h2>
      <div class="faq-list">
        <details><summary>¿Cuánto demora en llegar un libro importado?</summary><p>Depende de la edición y del proveedor. Muchos encargos tienen un plazo estimado de 12 a 17 días, pero puede variar. Antes de confirmar te informamos el plazo estimado para ese libro.</p></details>
        <details><summary>¿La búsqueda tiene costo o tengo que reservar antes?</summary><p>Consultarnos no tiene costo ni compromiso. Si encontramos una opción, te pasamos edición, estado, precio y demora estimada. La reserva se coordina después de que aceptes la propuesta.</p></details>
        <details><summary>¿Puedo pedir una edición específica, otro idioma o un libro usado?</summary><p>Sí. Pasanos el ISBN, editorial, año o una foto si los tenés. También podemos buscar ejemplares usados, sujetos a disponibilidad y verificación del estado.</p></details>
        <details><summary>¿Hacen envíos al interior de Uruguay?</summary><p>Sí, coordinamos envíos a todo el país. Te confirmamos las condiciones de entrega con la cotización del libro.</p></details>
      </div>
    </section>

    <section class="section">
      <h2>Libros técnicos importados por especialidad</h2>
      <p class="lead">Explorá catálogo disponible y pedí búsquedas manuales de ediciones publicadas en España, Argentina y otros mercados.</p>
      <nav class="specialties" aria-label="Especialidades profesionales">
        ${SEO_SPECIALTIES.map(item => `<a href="${specialtyPath(item.id)}">${item.name}</a>`).join('')}
      </nav>
    </section>

    <section class="closing">
      <h2>¿Cuál libro estás buscando?</h2>
      <p>Mandanos los datos que tengas. Te respondemos con una búsqueda concreta, sin compromiso.</p>
      <a class="cta cta-primary" href="${requestHref}" target="_blank" rel="noopener noreferrer">Consultar por WhatsApp</a>
    </section>
  </main>
  ${footerHtml(undefined, canonical)}
  ${waFloatHtml(REQUEST_MESSAGE, canonical)}
  <script>
    (function () {
      const form = document.getElementById('encargo-quick-form');
      if (!form) return;
      form.addEventListener('submit', function (event) {
        const title = form.elements.namedItem('q').value.trim();
        if (title.length < 2) return;
        event.preventDefault();
        const author = form.elements.namedItem('autor').value.trim();
        const message = [
          '¡Hola! Quiero consultar por un libro en Amado Libros.',
          'Título o tema: ' + title,
          author ? 'Autor, editorial o ISBN: ' + author : '',
          'Vi el servicio de búsqueda por encargo en su web. ¿Me pueden pasar opciones, precio y plazo estimado?'
        ].filter(Boolean).join('\\n');
        const url = 'https://wa.me/59899841325?text=' + encodeURIComponent(message);
        window.location.assign(url);
      });
    }());
  </script>
</body>
</html>`;

    return new Response(html, {
        headers: {
            'Content-Type': 'text/html;charset=UTF-8',
            'Cache-Control': 'public, max-age=3600',
        },
    });
}
