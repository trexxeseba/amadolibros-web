/**
 * Landing comercial para búsquedas por encargo. La consulta rápida se arma
 * en el navegador y solo se comparte al continuar hacia WhatsApp.
 */
import { BASE } from './_shared/catalog.js';
import { BRAND, CONTACT, FOOTER_LINKS, faviconHeadHtml } from './_shared/brand.js';
import { SEO_SPECIALTIES, specialtyPath } from './_shared/seo-specialties.js';
import { WHATSAPP_NUMBER } from '../shared/whatsapp-messages.js';

const PATH = '/libros-agotados-importados-uruguay';
const TITLE = 'Libros agotados e importados en Uruguay | Amado Libros';
const DESCRIPTION = 'Buscamos libros agotados, importados y difíciles de conseguir en Europa y otros mercados. Consultá por título, autor, ISBN o foto desde Uruguay.';
const LAST_REVIEWED_ISO = '2026-11-05';
const LAST_REVIEWED_LABEL = new Intl.DateTimeFormat('es-UY', {
    dateStyle: 'long',
    timeZone: 'UTC',
}).format(new Date(LAST_REVIEWED_ISO));
const CHAT_PATH = `${PATH}?chat=whatsapp`;
const WHATSAPP_CHAT = `https://wa.me/${WHATSAPP_NUMBER}`;

export async function onRequest({ request } = {}) {
    // Una URL interna fija evita que la medición automática de enlaces
    // salientes capture el número o el mensaje de WhatsApp.
    if (request && new URL(request.url).searchParams.get('chat') === 'whatsapp') {
        return new Response(null, {
            status: 302,
            headers: {
                Location: WHATSAPP_CHAT,
                'Cache-Control': 'no-store',
                'X-Robots-Tag': 'noindex, nofollow',
            },
        });
    }

    const canonical = `${BASE}${PATH}`;
    const schema = {
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'OnlineStore',
                '@id': `${BASE}/#bookstore`,
                'name': BRAND.name,
                'url': `${BASE}/`,
                'logo': `${BASE}/images/logo-amado.webp`,
                'telephone': `+${WHATSAPP_NUMBER}`,
                'email': CONTACT.email,
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
<html lang="es-UY">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="strict-origin">
  <meta name="theme-color" content="#f8f3e9">
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
    :root {
      color-scheme: light;
      --paper: #f8f3e9;
      --sheet: #fffcf6;
      --ink: #221c18;
      --muted: #5d5047;
      --faint: #6e5c50;
      --rule: #d3c4b2;
      --rust: #9c3d2b;
      --green: #154936;
      --green-hover: #103c2b;
      --serif: Georgia, "Times New Roman", serif;
      --sans: system-ui, -apple-system, "Segoe UI", sans-serif;
      --gutter: clamp(1.125rem, 5vw, 4rem);
    }

    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; background: var(--paper); color: var(--ink); font: 1rem/1.55 var(--sans); }
    h1, h2, h3, p, figure { margin: 0; }
    a { color: inherit; text-underline-offset: .2em; }
    a:hover { color: var(--rust); }
    :focus-visible { outline: 3px solid var(--rust); outline-offset: 4px; }
    [hidden] { display: none !important; }
    .wrap { width: min(100% - var(--gutter) * 2, 73rem); margin-inline: auto; }
    .kicker { color: var(--rust); font-size: .72rem; font-weight: 750; letter-spacing: .14em; text-transform: uppercase; }
    .skip { position: absolute; left: 1rem; top: .75rem; z-index: 2; transform: translateY(-200%); background: var(--sheet); padding: .6rem .9rem; }
    .skip:focus { transform: none; }

    .masthead { border-top: 4px solid var(--ink); border-bottom: 1px solid var(--rule); }
    .masthead-inner { display: flex; min-height: 4.5rem; align-items: center; justify-content: space-between; gap: 1rem; }
    .brand { display: inline-flex; min-height: 44px; align-items: center; gap: .625rem; text-decoration: none; line-height: 1.05; }
    .brand img { width: 3rem; height: 3rem; object-fit: contain; mix-blend-mode: multiply; }
    .brand-name { display: block; color: var(--ink); font: 700 1.32rem/1.1 var(--serif); }
    .brand-note { display: block; margin-top: .22rem; color: var(--muted); font-size: .68rem; letter-spacing: .075em; }
    .top-nav { display: flex; align-items: center; gap: clamp(.8rem, 2.5vw, 2.2rem); font-size: .86rem; font-weight: 650; }
    .top-nav a, .crumb a, .inline-link { display: inline-flex; align-items: center; min-height: 44px; }
    .top-nav .top-request { display: none; }
    .top-nav a { text-decoration-thickness: 1px; text-decoration-color: var(--rule); }
    .crumb { color: var(--faint); font-size: .76rem; }
    .crumb span { padding-inline: .45rem; color: var(--rust); }

    .hero { display: grid; grid-template-columns: minmax(0, 1.12fr) minmax(0, .88fr); gap: clamp(2.25rem, 6vw, 5.75rem); align-items: center; padding: 1.9rem 0 3rem; }
    .hero-kicker { display: flex; align-items: center; gap: .6rem; }
    .hero-kicker::before { content: ""; width: 1.55rem; height: 1px; background: currentColor; }
    h1 { margin: .95rem 0 1.05rem; font: 400 clamp(3.6rem, 6.15vw, 5.6rem)/.97 var(--serif); letter-spacing: -.052em; }
    h1 em { color: var(--rust); font-weight: 400; }
    .hero-lead { max-width: 36ch; color: var(--muted); font-size: clamp(1rem, 1.4vw, 1.17rem); }
    .commitment { display: flex; align-items: baseline; gap: .52rem; margin-top: .95rem; color: var(--green); font-size: .88rem; font-weight: 690; }
    .commitment span { font-size: 1rem; }
    .bookplate { display: flex; align-items: center; gap: 1.05rem; margin-top: 1.85rem; color: var(--faint); }
    .bookplate svg { flex: 0 0 auto; width: 8.25rem; height: 3.05rem; color: var(--rust); }
    .bookplate figcaption { border-left: 1px solid var(--rule); padding-left: 1.05rem; font: italic 1rem/1.4 var(--serif); }
    .bookplate figcaption span { display: block; color: var(--ink); font-style: normal; font-size: .9rem; }

    .request { position: relative; background: var(--sheet); border: 1px solid var(--rule); border-top: 3px solid var(--rust); border-radius: 3px; padding: clamp(1.2rem, 3vw, 2.15rem); box-shadow: 0 8px 24px #392e2110; }
    .request .kicker { display: flex; justify-content: space-between; align-items: baseline; gap: .6rem; }
    .request .kicker span { color: var(--faint); font-size: .66rem; letter-spacing: .09em; }
    .request h2 { margin: .4rem 0 .4rem; font: 400 clamp(1.55rem, 3.3vw, 2.2rem)/1.08 var(--serif); letter-spacing: -.029em; }
    .request-intro { color: var(--muted); font-size: .91rem; }
    .request form { margin-top: 1.05rem; }
    .field + .field { margin-top: .8rem; }
    label { display: block; margin: 0 0 .25rem; font-size: .83rem; font-weight: 720; }
    label span { color: var(--faint); font-weight: 400; }
    input { display: block; width: 100%; min-height: 46px; border: 1px solid #907e6d; border-radius: 3px; background: white; color: var(--ink); font: inherit; padding: .6rem .7rem; }
    input::placeholder { color: #6a5c51; opacity: 1; }
    .primary { display: inline-flex; min-height: 48px; align-items: center; justify-content: center; gap: .55rem; border: 0; border-radius: 3px; background: var(--green); color: #fffdf7; padding: .65rem 1rem; text-align: center; text-decoration: none; font: 700 .95rem/1.35 var(--sans); cursor: pointer; }
    .primary:hover { background: var(--green-hover); color: #fffdf7; }
    .request .primary { width: 100%; margin-top: 1rem; }
    .primary svg { width: 1.15rem; height: 1.15rem; flex: 0 0 auto; }
    .handoff { margin-top: .55rem; color: var(--muted); font-size: .79rem; }
    .request-alternatives { display: flex; flex-wrap: wrap; align-items: center; column-gap: 1rem; margin-top: .48rem; border-top: 1px solid var(--rule); color: var(--green); font-size: .8rem; font-weight: 660; }
    .request-alternatives a { min-height: 44px; }
    #consulta, #como-funciona { scroll-margin-top: 1rem; }

    .trust { border-block: 1px solid var(--rule); background: #f1e8db; }
    .trust ul { margin-block: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); padding: 0; list-style: none; }
    .trust li + li { border-left: 1px solid var(--rule); }
    .trust a { display: flex; min-height: 66px; align-items: center; justify-content: center; gap: .65rem; padding: .65rem; text-align: center; text-decoration-thickness: 1px; font-size: .85rem; font-weight: 690; }
    .trust a span { color: var(--rust); font-size: .95rem; text-decoration: none; }

    .section { padding-block: clamp(2.25rem, 5.3vw, 4.8rem); border-bottom: 1px solid var(--rule); }
    .section h2, .closing h2 { margin-top: .42rem; font: 400 clamp(2rem, 4.1vw, 3.38rem)/1.05 var(--serif); letter-spacing: -.036em; }
    .steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: clamp(1rem, 4vw, 3.3rem); margin: 1.7rem 0 0; padding: 0; list-style: none; }
    .steps li { border-top: 1px solid var(--rule); padding-top: 1rem; }
    .step-number { color: var(--rust); font: italic 1.45rem/1.2 var(--serif); }
    .steps h3 { margin: .42rem 0; font: 700 1.24rem/1.2 var(--serif); }
    .steps p, .genres p, .faq details p { color: var(--muted); font-size: .95rem; }
    .related { display: flex; flex-wrap: wrap; gap: 0 1.45rem; margin-top: 1rem; font-size: .88rem; color: var(--green); font-weight: 650; }
    .split { display: grid; grid-template-columns: minmax(0, .76fr) minmax(0, 1.24fr); gap: 1.25rem clamp(1.5rem, 6vw, 5.25rem); }
    .genres { margin: 0; padding: 0; list-style: none; }
    .genres li { border-top: 1px solid var(--rule); padding: .82rem 0; }
    .genres li:last-child { border-bottom: 1px solid var(--rule); }
    .genres h3 { margin-bottom: .1rem; font: 700 1.15rem/1.25 var(--serif); }
    .specialties { margin-top: 1.25rem; }
    .specialties h3 { font-size: .9rem; font-weight: 690; }
    .specialties nav { display: flex; flex-wrap: wrap; column-gap: 1.15rem; }
    .specialties a { font-size: .85rem; color: var(--green); }

    .faq details { border-top: 1px solid var(--rule); }
    .faq details:last-child { border-bottom: 1px solid var(--rule); }
    .faq summary { display: flex; min-height: 3.2rem; justify-content: space-between; align-items: center; gap: .75rem; padding: .7rem .1rem; cursor: pointer; font-weight: 675; list-style: none; }
    .faq summary::-webkit-details-marker { display: none; }
    .faq summary span { color: var(--rust); font-size: 1.25rem; line-height: 1; }
    .faq details[open] summary span { transform: rotate(45deg); }
    .faq details p { padding: .05rem 1.5rem .95rem .1rem; }

    .closing { margin-top: clamp(2.25rem, 5vw, 4.25rem); padding: clamp(1.35rem, 4vw, 3rem); border-radius: 3px; background: #29211c; color: #fff9ef; }
    .closing .kicker { color: #f1ab92; }
    .closing p:not(.kicker) { margin: .65rem 0 1rem; color: #eadacb; }
    .closing .primary { background: #f4e1cf; color: #29211c; }
    .closing .primary:hover { background: #fff4e6; }
    .closing a:focus-visible { outline-color: #f1ab92; }
    footer { padding: 2.15rem 0; color: var(--muted); font-size: .85rem; }
    .footer-inner { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1rem 2rem; }
    .footer-title { color: var(--ink); font: 700 1.25rem/1.2 var(--serif); margin-bottom: .35rem; }
    .footer-links { display: flex; flex-wrap: wrap; gap: 0 1rem; align-content: start; }
    .footer-more { grid-column: 1 / -1; }
    .footer-more summary { display: list-item; width: fit-content; min-height: 44px; padding-block: .7rem; cursor: pointer; color: var(--ink); font-weight: 650; }
    .footer-more ul { display: flex; flex-wrap: wrap; gap: 0 1rem; margin: 0; padding: 0; list-style: none; }
    .footer-meta { grid-column: 1 / -1; font-size: .78rem; color: var(--faint); }

    @media (max-width: 800px) {
      .hero { grid-template-columns: minmax(0, 1fr); gap: 1.25rem; padding: .55rem 0 2rem; }
      h1 { font-size: clamp(2.35rem, 10vw, 4.4rem); margin: .63rem 0 .75rem; }
      .hero-lead { max-width: 48ch; }
      .commitment { margin-top: .65rem; }
      .bookplate { display: none; }
      .footer-inner { grid-template-columns: minmax(0, 1fr); gap: .45rem; }
    }

    @media (max-width: 540px) {
      .masthead-inner { min-height: 3.75rem; }
      .brand img { width: 2.35rem; height: 2.35rem; }
      .brand-name { font-size: 1.12rem; }
      .brand-note { font-size: .62rem; letter-spacing: .045em; }
      .top-nav { flex: 0 0 auto; gap: .65rem; font-size: .75rem; }
      .top-nav a, .brand-note { white-space: nowrap; }
      .top-process { display: none !important; }
      .top-nav .top-request { display: inline-flex; color: var(--green); }
      h1 { font-size: clamp(2.2rem, 9.6vw, 4.4rem); }
      .hero { gap: 1rem; }
      .hero-lead { font-size: .96rem; }
      .request { padding: .95rem; }
      .request form { margin-top: .75rem; }
      .field + .field { margin-top: .55rem; }
      .trust ul { grid-template-columns: minmax(0, 1fr); }
      .trust li + li { border-left: 0; border-top: 1px solid var(--rule); }
      .trust a { min-height: 46px; justify-content: flex-start; padding-inline: 0; text-align: left; }
      .steps, .split { grid-template-columns: minmax(0, 1fr); }
      .steps { margin-top: 1.25rem; }
    }
    @media (max-width: 360px) {
      .masthead-inner { gap: .65rem; }
      .brand { gap: .4rem; }
      .brand img { width: 2rem; height: 2rem; }
      .brand-note { display: none; }
      .request h2 { font-size: 1.43rem; }
      .request .primary { font-size: .86rem; padding-inline: .55rem; gap: .35rem; }
    }
  </style>
</head>
<body>
  <a class="skip" href="#contenido">Saltar al contenido</a>
  <header class="masthead">
    <div class="wrap masthead-inner">
      <a class="brand" href="/">
        <img src="${BRAND.logo}" alt="" width="48" height="48">
        <span><span class="brand-name">${BRAND.name}</span><span class="brand-note">Librería en línea · Uruguay</span></span>
      </a>
      <nav class="top-nav" aria-label="Navegación principal">
        <a class="top-process" href="#como-funciona">Cómo funciona</a>
        <a class="top-request" href="#consulta">Pedir libro</a>
        <a href="/catalogo">Catálogo</a>
      </nav>
    </div>
  </header>
  <div class="wrap">
    <nav class="crumb" aria-label="Ruta de navegación">
      <a href="/">Inicio</a><span aria-hidden="true">/</span>Libros agotados e importados
    </nav>
  </div>

  <main id="contenido" tabindex="-1">
    <section class="wrap hero" aria-labelledby="titulo">
      <div>
        <p class="kicker hero-kicker">Búsqueda por encargo</p>
        <h1 id="titulo">Buscamos libros<br><em>agotados</em> e<br>importados.</h1>
        <p class="hero-lead">¿Buscás un libro difícil de encontrar en Uruguay? Contanos lo que sabés. Nuestro equipo revisa tu consulta y busca opciones para vos.</p>
        <p class="commitment"><span aria-hidden="true">✓</span> Consultá sin costo ni compromiso.</p>
        <figure class="bookplate">
          <svg aria-hidden="true" viewBox="0 0 156 60" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 54h151M11 51h100a6 6 0 0 0 0-12H11v3h98a3 3 0 0 1 0 6H11v3Zm2-6h93m-89-9h106V24H17v12Zm6-10v8m5-5h53m-53 3h40m38-5v6m9-6v6M25 21h91a5 5 0 0 0 0-10H25v3h90a2 2 0 0 1 0 4H25v3Zm1-5h84M130 14l9-2 7 37-9 2-7-37Zm1 4 9-2m-3 30 8-2M8 56h138"/>
            <path d="M101 8h9m-80 0h60m38 46 5 2" opacity=".55"/>
          </svg>
          <figcaption>Pistas para identificar la edición<span>Título, autor, ISBN o foto de la tapa.</span></figcaption>
        </figure>
      </div>

      <div class="request" id="consulta" tabindex="-1">
        <p class="kicker">Consulta rápida <span>Atención humana</span></p>
        <h2 id="consulta-titulo">Contanos qué libro buscás</h2>
        <p class="request-intro">Con un dato alcanza para empezar.</p>
        <form id="encargo-quick-form" aria-labelledby="consulta-titulo" hidden>
          <div class="field">
            <label for="encargo-titulo">Título, tema o ISBN del libro</label>
            <input id="encargo-titulo" type="text" maxlength="200" required autocomplete="off" placeholder="Ej.: La tregua">
          </div>
          <div class="field">
            <label for="encargo-autor">Autor o editorial <span>(opcional)</span></label>
            <input id="encargo-autor" type="text" maxlength="150" autocomplete="off" placeholder="Ej.: Mario Benedetti">
          </div>
          <button class="primary" type="submit" aria-describedby="envio-por-whatsapp">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="M20.2 11.8a8.3 8.3 0 0 1-12.1 7.4l-4.6 1.2 1.2-4.4a8.3 8.3 0 1 1 15.5-4.2Z"/><path d="M8.4 8.2c.3-.4.8-.3 1.1.1l1 1.8c.2.4.1.6-.2.9l-.5.6c.6 1.3 1.6 2.3 3 2.9l.5-.6c.3-.3.6-.4 1-.2l1.7.9c.5.3.5.7.2 1.1-.5.7-1.3 1-2.2.8-3.3-.9-5.5-3.1-6.3-6.1-.2-.8 0-1.6.7-2.2Z"/></svg>
            Continuar en WhatsApp <span aria-hidden="true">↗</span>
          </button>
          <p class="handoff" id="envio-por-whatsapp">Se abre WhatsApp con el mensaje listo. Lo podés revisar antes de enviarlo.</p>
        </form>
        <noscript><p class="handoff">Escribinos por WhatsApp con el dato que tengas. El equipo de Amado recibe tu mensaje ahí.</p></noscript>
        <div class="request-alternatives">
          <a class="inline-link" href="/pedir-libro/?tipo=agotado">Usar el formulario completo</a>
          <a class="inline-link" href="${CHAT_PATH}" data-whatsapp-cta="encargo_chat_directo" rel="noreferrer">Abrir chat directo</a>
        </div>
      </div>
    </section>

    <div class="trust">
      <ul class="wrap">
        <li><a href="/quienes-somos/"><span aria-hidden="true">✦</span> Librería familiar de Montevideo</a></li>
        <li><a href="/envios/"><span aria-hidden="true">✦</span> Envíos a todo Uruguay</a></li>
        <li><a href="/contacto/"><span aria-hidden="true">✦</span> Retiro coordinado en Ciudad Vieja</a></li>
      </ul>
    </div>

    <section class="wrap section" id="como-funciona" aria-labelledby="pasos">
      <p class="kicker">Cómo funciona</p>
      <h2 id="pasos">Así buscamos tu libro</h2>
      <ol class="steps">
        <li>
          <span class="step-number" aria-hidden="true">01</span>
          <h3>Mandanos los datos</h3>
          <p>El título, un tema o una foto de la tapa nos dan un punto de partida. Si tenés el ISBN, también ayuda.</p>
        </li>
        <li>
          <span class="step-number" aria-hidden="true">02</span>
          <h3>Buscamos y verificamos</h3>
          <p>Consultamos disponibilidad y revisamos que la edición, el idioma, el formato y el estado coincidan con lo que pediste.</p>
        </li>
        <li>
          <span class="step-number" aria-hidden="true">03</span>
          <h3>Vos decidís</h3>
          <p>Si encontramos una opción, te pasamos edición, estado, precio y plazo estimado. Si te sirve, coordinamos la reserva.</p>
        </li>
      </ol>
      <div class="related">
        <a class="inline-link" href="/como-identificar-edicion-correcta-isbn/">Guía para identificar una edición por ISBN</a>
        <a class="inline-link" href="/quienes-somos/">Quién hace la búsqueda</a>
      </div>
    </section>

    <section class="wrap section split" aria-labelledby="busquedas">
      <div>
        <p class="kicker">Tipos de búsqueda</p>
        <h2 id="busquedas">Qué podemos buscar</h2>
      </div>
      <div>
        <ul class="genres">
          <li><h3>Agotados o descatalogados</h3><p>Ejemplares que dejaron de aparecer en las librerías habituales.</p></li>
          <li><h3>Libros importados</h3><p>Consultamos opciones de España, Argentina, Estados Unidos y otros mercados, según el título.</p></li>
          <li><h3>Textos técnicos y universitarios</h3><p>Manuales, bibliografía profesional y ediciones pedidas para estudio.</p></li>
          <li><h3>Ediciones específicas y ejemplares usados</h3><p>Una editorial, un año, un idioma o el formato que querés encontrar.</p></li>
        </ul>
        <div class="specialties">
          <h3>Libros técnicos por especialidad</h3>
          <nav aria-label="Especialidades profesionales">
            ${SEO_SPECIALTIES.map(item => `<a class="inline-link" href="${specialtyPath(item.id)}">${item.name}</a>`).join('')}
          </nav>
        </div>
      </div>
    </section>

    <section class="wrap section split" aria-labelledby="preguntas">
      <div>
        <p class="kicker">Antes de encargar</p>
        <h2 id="preguntas">Preguntas frecuentes</h2>
      </div>
      <div class="faq">
        <details>
          <summary>¿Cuánto demora un libro importado? <span aria-hidden="true">+</span></summary>
          <p>Muchos encargos tienen un plazo estimado de 12 a 17 días. Puede variar según la edición y el proveedor. Te confirmamos el estimado para tu libro antes de reservar.</p>
        </details>
        <details>
          <summary>¿La consulta tiene costo? <span aria-hidden="true">+</span></summary>
          <p>La consulta es gratuita. Si encontramos una opción y te sirve, coordinamos la reserva contigo.</p>
        </details>
        <details>
          <summary>¿Pueden buscar una edición específica o un ejemplar usado? <span aria-hidden="true">+</span></summary>
          <p>Sí. Si tenés el ISBN, el año, la editorial o una foto, pasanos ese dato. Si aparece un ejemplar usado, revisamos su estado antes de ofrecerlo.</p>
        </details>
        <details>
          <summary>¿Qué pasa si no encuentran el libro? <span aria-hidden="true">+</span></summary>
          <p>Te contamos qué pudimos verificar. Si encontramos una alternativa, te explicamos en qué se diferencia para que puedas decidir.</p>
        </details>
        <details>
          <summary>¿Hacen envíos al interior? <span aria-hidden="true">+</span></summary>
          <p>Sí, enviamos a todo Uruguay. Te confirmamos las condiciones de entrega junto con la cotización.</p>
        </details>
      </div>
    </section>

    <section class="wrap closing" aria-labelledby="cierre">
      <p class="kicker">Amado Libros</p>
      <h2 id="cierre">¿Tenés una foto de la tapa?</h2>
      <p>Mandánosla por WhatsApp. Gracias por confiar en nosotros para buscar tu libro.</p>
      <a class="primary" href="${CHAT_PATH}" data-whatsapp-cta="encargo_foto" rel="noreferrer">Escribir por WhatsApp <span aria-hidden="true">↗</span></a>
    </section>
  </main>

  <footer class="site-footer">
    <div class="wrap footer-inner">
      <div><p class="footer-title">Amado Libros</p><p>Librería familiar, atendida por sus dueños.</p></div>
      <nav class="footer-links" aria-label="Información de Amado Libros">
        <a class="inline-link" href="/catalogo">Catálogo</a>
        <a class="inline-link" href="/contacto/">Contacto</a>
        <a class="inline-link" href="/envios/">Envíos y retiro</a>
        <a class="inline-link" href="/privacidad/">Privacidad</a>
      </nav>
      <details class="footer-more">
        <summary>Más información de Amado Libros</summary>
        <ul class="footer-list">
          ${FOOTER_LINKS.filter(link => !['/envios/', '/privacidad/', PATH].includes(link.href))
              .map(link => `<li><a class="inline-link" href="${link.href}">${link.label}</a></li>`).join('')}
        </ul>
        <div class="footer-links">
          <a class="inline-link" href="${CHAT_PATH}" data-whatsapp-cta="encargo_footer" rel="noreferrer">WhatsApp · ${CONTACT.whatsappDisplay}</a>
          <a class="inline-link" href="mailto:${CONTACT.email}">${CONTACT.email}</a>
        </div>
        <p>${CONTACT.pickupHours}</p>
      </details>
      <p class="footer-meta">Contenido revisado el <time datetime="${LAST_REVIEWED_ISO}">${LAST_REVIEWED_LABEL}</time> por el <a href="/quienes-somos/">equipo de Amado Libros</a>.</p>
    </div>
  </footer>

  <script>
    (() => {
      const form = document.getElementById('encargo-quick-form');
      const title = document.getElementById('encargo-titulo');
      const author = document.getElementById('encargo-autor');

      function trackOpening(location) {
        window.AmadoAnalytics?.trackWhatsApp({ ctaLocation: location, topic: 'agotado' });
      }

      for (const link of document.querySelectorAll('[data-whatsapp-cta]')) {
        link.addEventListener('click', () => {
          trackOpening(link.dataset.whatsappCta);
          window.AmadoMeta?.track('Contact');
        });
      }

      title.addEventListener('input', () => title.setCustomValidity(''));
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const query = title.value.trim();
        if (!query) {
          title.setCustomValidity('Escribí el título, el tema o un dato del libro.');
          title.reportValidity();
          return;
        }

        const lines = [
          '¡Hola, Amado Libros! Quisiera consultar por un libro por encargo.',
          '',
          'Libro o tema: ' + query,
        ];
        const extra = author.value.trim();
        if (extra) lines.push('Autor o editorial: ' + extra);
        lines.push('', '¿Me pueden confirmar si lo encuentran, el precio y la demora estimada? Gracias.');
        const url = '${WHATSAPP_CHAT}?text=' + encodeURIComponent(lines.join('\\n'));

        try {
          trackOpening('encargo_rapido');
        } finally {
          window.location.assign(url);
        }
      });
      form.hidden = false;
    })();
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
