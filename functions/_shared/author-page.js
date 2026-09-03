import { BASE, fetchCatalog } from './catalog.js';
import {
  faviconHeadHtml,
  footerHtml,
  FOOTER_STYLES,
  waFloatHtml,
  WA_FLOAT_STYLES,
} from './brand.js';
import { slugify } from './slug.js';
import { authorPageById, matchesAuthor } from './seo-authors.js';
import {
  bookCoverUrl,
  CARD_IMAGE_SIZES,
  responsiveImage,
} from './cloudflare-images.js';
import {
  buildWhatsAppMessage,
  whatsappHref,
} from '../../shared/whatsapp-messages.js';

const MONTESSORI_ID = 'maria-montessori';
const MONTESSORI_PORTRAIT = 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/51/Dr._Maria_Montessori.jpg/500px-Dr._Maria_Montessori.jpg';
const MONTESSORI_PORTRAIT_SOURCE = 'https://commons.wikimedia.org/wiki/File:Dr._Maria_Montessori.jpg';

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

function coverUrl(item) {
  const source = Array.isArray(item?.pictures) && item.pictures[0]
    ? item.pictures[0]
    : item?.thumbnail || '';
  return String(source)
    .replace('http://', 'https://')
    .replace(/-I\.(jpg|jpeg|png|webp)(?=($|\?))/i, '-O.$1');
}

function unavailable(message, status = 503) {
  return new Response(message, {
    status,
    headers: {
      'content-type': 'text/plain;charset=UTF-8',
      'cache-control': 'no-store',
    },
  });
}

function isMontessoriHub(author) {
  return author?.id === MONTESSORI_ID;
}

function montessoriQuickNav() {
  const links = [
    ['#libros', 'Libros disponibles', 'Comprar o consultar títulos'],
    ['#quien-fue', 'Quién fue', 'Biografía breve y rigurosa'],
    ['#metodo-montessori', 'El método', 'Principios centrales'],
    ['#que-desarrolla', 'Qué busca desarrollar', 'Autonomía y aprendizaje'],
    ['#materiales-montessori', 'Materiales y muebles', 'Cómo se prepara el ambiente'],
    ['#montessori-uruguay', 'Montessori en Uruguay', 'Centros y formación'],
  ];
  return `<nav class="hub-nav" aria-label="Explorar guía Montessori">
    ${links.map(([href, title, description]) => `<a href="${href}">
      <strong>${title}</strong>
      <span>${description}</span>
      <b aria-hidden="true">→</b>
    </a>`).join('\n    ')}
  </nav>`;
}

function montessoriEditorialHtml() {
  return `
  <section class="hub-content" aria-label="Guía sobre María Montessori y su método">
    <article class="hub-panel" id="quien-fue">
      <p class="eyebrow">Historia y educación</p>
      <h2>¿Quién fue María Montessori?</h2>
      <p>María Montessori (1870–1952) fue una médica y educadora italiana. Se graduó en Medicina en la Universidad de Roma en 1896, en una época en la que muy pocas mujeres accedían a esa profesión en Italia. En 1907 abrió la primera <em>Casa dei Bambini</em> en San Lorenzo, Roma.</p>
      <p>A partir de la observación sistemática del desarrollo infantil elaboró una pedagogía que dio un lugar central a la autonomía, el ambiente preparado, la actividad con propósito y materiales concretos. En 1929 fundó la Association Montessori Internationale (AMI) para preservar y desarrollar su trabajo.</p>
    </article>

    <article class="hub-panel" id="metodo-montessori">
      <p class="eyebrow">Pedagogía Montessori</p>
      <h2>¿En qué consiste el método Montessori?</h2>
      <p>El enfoque organiza el aprendizaje alrededor de un <strong>ambiente preparado</strong>: ordenado, accesible y pensado para que el niño pueda elegir y completar actividades con creciente independencia. El adulto observa, presenta los materiales y acompaña sin sustituir innecesariamente la iniciativa del niño.</p>
      <div class="principles-grid">
        <div><strong>Ambiente preparado</strong><span>Espacios claros, accesibles y proporcionados a la edad.</span></div>
        <div><strong>Autonomía</strong><span>Oportunidades reales para hacer por sí mismo.</span></div>
        <div><strong>Materiales concretos</strong><span>Actividades manipulativas, progresivas y con propósito definido.</span></div>
        <div><strong>Observación</strong><span>El adulto ajusta su intervención a lo que observa en cada etapa.</span></div>
        <div><strong>Ritmo individual</strong><span>Tiempo para repetir, concentrarse y consolidar aprendizajes.</span></div>
        <div><strong>Comunidad</strong><span>Convivencia, cooperación, cuidado del ambiente y respeto.</span></div>
      </div>
    </article>

    <article class="hub-panel" id="que-desarrolla">
      <p class="eyebrow">Desarrollo infantil</p>
      <h2>¿Qué busca favorecer en el niño?</h2>
      <p>La propuesta Montessori busca acompañar el desarrollo integral. No promete resultados idénticos en todos los niños: crea condiciones para ejercitar capacidades mediante la actividad cotidiana y el uso intencional del ambiente.</p>
      <ul class="development-list">
        <li><strong>Autonomía:</strong> elegir, iniciar y terminar tareas adecuadas a la edad.</li>
        <li><strong>Concentración:</strong> sostener actividades durante períodos cada vez más largos.</li>
        <li><strong>Coordinación y motricidad fina:</strong> manipular objetos y secuencias con precisión.</li>
        <li><strong>Lenguaje y pensamiento matemático:</strong> avanzar desde experiencias concretas hacia conceptos más abstractos.</li>
        <li><strong>Orden y autorregulación:</strong> anticipar secuencias, cuidar materiales y organizar el trabajo.</li>
        <li><strong>Habilidades sociales:</strong> compartir un ambiente, esperar, colaborar y respetar a otras personas.</li>
      </ul>
    </article>

    <article class="hub-panel" id="materiales-montessori">
      <p class="eyebrow">Casa y aula</p>
      <h2>Materiales, juegos y muebles Montessori</h2>
      <p>Un ambiente Montessori no depende de llenar la casa o el aula de productos. La idea principal es que los objetos necesarios estén al alcance del niño, sean funcionales y tengan un lugar claro.</p>
      <div class="materials-grid">
        <div><strong>Muebles</strong><span>Estanterías bajas y abiertas, mesa y silla a escala infantil, guardado accesible.</span></div>
        <div><strong>Vida práctica</strong><span>Jarras, pinzas, recipientes, paños y tareas reales adaptadas a la edad.</span></div>
        <div><strong>Sensorial</strong><span>Materiales para comparar tamaño, forma, textura, color, peso y sonido.</span></div>
        <div><strong>Lenguaje</strong><span>Objetos, tarjetas, letras táctiles, lectura y escritura progresiva.</span></div>
        <div><strong>Matemática</strong><span>Cantidades y operaciones representadas primero de manera concreta.</span></div>
        <div><strong>Cultura</strong><span>Naturaleza, geografía, ciencia, arte y experiencias del mundo cotidiano.</span></div>
      </div>
      <p class="commerce-note"><strong>Criterio Amado:</strong> por ahora esta guía no deriva tráfico hacia vendedores de muebles. Primero priorizamos libros, información útil y recursos educativos; cualquier recomendación comercial futura deberá tener valor claro para el lector y una relación transparente.</p>
    </article>

    <article class="hub-panel" id="montessori-uruguay">
      <p class="eyebrow">Directorio curado</p>
      <h2>Montessori en Uruguay: centros y formación</h2>
      <p>Estos son algunos proyectos e instituciones con información pública sobre trabajo, formación o propuestas inspiradas en Montessori. La selección es informativa: no implica ranking, certificación por parte de Amado Libros ni vínculo comercial.</p>
      <div class="uy-grid">
        <a href="https://scuolaitaliana.edu.uy/casa-dei-bambini/" target="_blank" rel="noopener noreferrer external">
          <strong>Scuola Italiana di Montevideo</strong>
          <span>Casa dei Bambini para niños de 2 a 5 años; la institución presenta una trayectoria de más de 90 años vinculada a la filosofía Montessori.</span>
          <b>Sitio oficial ↗</b>
        </a>
        <a href="https://damore.montessori.edu.uy/" target="_blank" rel="noopener noreferrer external">
          <strong>D’amore Montessori School</strong>
          <span>Colegio bilingüe que declara basar su propuesta en la filosofía y los principios educativos de María Montessori.</span>
          <b>Sitio oficial ↗</b>
        </a>
        <a href="https://lacolmena.org.uy/" target="_blank" rel="noopener noreferrer external">
          <strong>Escuela y Liceo Rural La Colmena</strong>
          <span>Su propuesta informa trabajo basado en Montessori en Educación Inicial y Primaria.</span>
          <b>Sitio oficial ↗</b>
        </a>
        <a href="https://www.institutomariamontessori.com/" target="_blank" rel="noopener noreferrer external">
          <strong>Instituto Maria Montessori Uruguay</strong>
          <span>Formación, actividades y recursos vinculados con la pedagogía Montessori en Uruguay.</span>
          <b>Sitio oficial ↗</b>
        </a>
      </div>
    </article>

    <article class="hub-panel hub-sources" id="fuentes">
      <p class="eyebrow">Rigor editorial</p>
      <h2>Fuentes y criterio de esta guía</h2>
      <p>La síntesis biográfica y pedagógica se apoya en fuentes institucionales Montessori y en los sitios oficiales de los centros uruguayos mencionados. La fotografía de María Montessori es una imagen de 1913 disponible en Wikimedia Commons bajo dedicación CC0.</p>
      <p class="source-links">
        <a href="https://montessori-ami.org/about-montessori" target="_blank" rel="noopener noreferrer external">Association Montessori Internationale ↗</a>
        <a href="${MONTESSORI_PORTRAIT_SOURCE}" target="_blank" rel="noopener noreferrer external">Fuente de la fotografía ↗</a>
      </p>
    </article>
  </section>`;
}

function montessoriFaqSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    'mainEntity': [
      {
        '@type': 'Question',
        'name': '¿Qué es el método Montessori?',
        'acceptedAnswer': {
          '@type': 'Answer',
          'text': 'Es un enfoque educativo basado en la observación del desarrollo infantil, el ambiente preparado, la autonomía, la actividad con propósito y el uso de materiales concretos.',
        },
      },
      {
        '@type': 'Question',
        'name': '¿Qué busca desarrollar Montessori en el niño?',
        'acceptedAnswer': {
          '@type': 'Answer',
          'text': 'Busca favorecer capacidades como autonomía, concentración, coordinación, lenguaje, pensamiento matemático, orden, autorregulación y habilidades sociales.',
        },
      },
      {
        '@type': 'Question',
        'name': '¿Hay centros Montessori en Uruguay?',
        'acceptedAnswer': {
          '@type': 'Answer',
          'text': 'Sí. Existen centros educativos, proyectos y espacios de formación en Uruguay que trabajan con Montessori o declaran inspirarse en sus principios.',
        },
      },
    ],
  };
}

export function selectAuthorBooks(items, author) {
  if (!Array.isArray(items) || !author) return [];
  const seen = new Set();
  return items.filter(item => {
    if (!item?.id || !item?.title || item.status !== 'active') return false;
    if ((Number(item.available_quantity) || 0) <= 0) return false;
    if (!matchesAuthor(item, author) || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function renderAuthorPage(author, items, useCloudflareImages = true) {
  const canonicalUrl = `${BASE}${author.path}`;
  const pageTitle = `Libros de ${author.name} en Uruguay`;
  const montessoriHub = isMontessoriHub(author);
  const metaDescription = montessoriHub
    ? 'Libros de María Montessori en Uruguay y guía sobre su vida, método, desarrollo infantil, materiales y centros Montessori. Comprá online en Amado Libros.'
    : `Libros de ${author.name} disponibles en Uruguay: ${author.focus}. Comprá online o consultá por encargos en Amado Libros.`;
  const waMessage = buildWhatsAppMessage({
    greeting: 'Hola, estoy buscando un libro en Amado Libros y quisiera que me ayudaran 😊',
    motive: 'Consultar por otro libro del autor',
    book: `Otro título de ${author.name}`,
    author: author.name,
    situation: 'Todavía no identifiqué la edición exacta',
    page: canonicalUrl,
    closing: 'Quisiera contarles qué título necesito y saber si pueden conseguirlo. Gracias.',
  });

  const itemListElements = items.slice(0, 50).map((item, index) => ({
    '@type': 'ListItem',
    'position': index + 1,
    'url': `${BASE}/libro/${item.id}/${slugify(item.title)}`,
    'name': item.title,
  }));
  const breadcrumbItems = montessoriHub
    ? [
        { '@type': 'ListItem', 'position': 1, 'name': 'Inicio', 'item': `${BASE}/` },
        { '@type': 'ListItem', 'position': 2, 'name': 'Educación', 'item': `${BASE}/catalogo?categoria=educacion` },
        { '@type': 'ListItem', 'position': 3, 'name': 'María Montessori' },
      ]
    : [
        { '@type': 'ListItem', 'position': 1, 'name': 'Inicio', 'item': `${BASE}/` },
        { '@type': 'ListItem', 'position': 2, 'name': 'Catálogo', 'item': `${BASE}/catalogo` },
        { '@type': 'ListItem', 'position': 3, 'name': `Libros de ${author.name}` },
      ];

  const schemas = [
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      '@id': `${canonicalUrl}#page`,
      'name': pageTitle,
      'url': canonicalUrl,
      'description': metaDescription,
      'isPartOf': { '@id': `${BASE}/#website` },
      'publisher': { '@id': `${BASE}/#bookstore` },
      'about': { '@type': 'Person', 'name': author.name },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      'name': `${pageTitle} — Amado Libros`,
      'numberOfItems': items.length,
      'itemListElement': itemListElements,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      'itemListElement': breadcrumbItems,
    },
  ];

  if (montessoriHub) {
    schemas.push(
      {
        '@context': 'https://schema.org',
        '@type': 'Person',
        '@id': `${canonicalUrl}#maria-montessori`,
        'name': 'María Montessori',
        'birthDate': '1870-08-31',
        'deathDate': '1952-05-06',
        'jobTitle': 'Médica y educadora',
        'description': 'Médica y educadora italiana, creadora del enfoque educativo Montessori.',
        'sameAs': ['https://montessori-ami.org/about-montessori'],
      },
      montessoriFaqSchema(),
    );
  }

  const cards = items.map(item => {
    const href = `/libro/${encodeURIComponent(item.id)}/${slugify(item.title)}`;
    const source = useCloudflareImages ? bookCoverUrl(item.id) : coverUrl(item);
    const image = responsiveImage(source, {
      widths: [240, 360, 480],
      defaultWidth: 360,
      sizes: CARD_IMAGE_SIZES,
    });
    const price = Number(item.price) || 0;
    const responsiveAttrs = image.srcset
      ? ` srcset="${escapeHtml(image.srcset)}" sizes="${escapeHtml(image.sizes)}"`
      : '';
    return `<article class="book-card">
      <a class="cover-link" href="${escapeHtml(href)}">
        ${image.src ? `<img src="${escapeHtml(image.src)}"${responsiveAttrs} alt="Portada de ${escapeHtml(item.title)}" loading="lazy" decoding="async" width="180" height="270">` : '<span class="cover-fallback" aria-hidden="true">📚</span>'}
      </a>
      <div class="book-info">
        <h2><a href="${escapeHtml(href)}">${escapeHtml(item.title)}</a></h2>
        <p class="book-author">${escapeHtml(item.author)}</p>
        ${price > 0 ? `<p class="book-price">$${escapeHtml(price.toLocaleString('es-UY'))} UYU</p>` : ''}
        <a class="book-cta" href="${escapeHtml(href)}">Ver ficha</a>
      </div>
    </article>`;
  }).join('\n');

  const breadcrumbsHtml = montessoriHub
    ? `<a href="/">Inicio</a> › <a href="/catalogo?categoria=educacion">Educación</a> › María Montessori`
    : `<a href="/">Inicio</a> › <a href="/catalogo">Catálogo</a> › Libros de ${escapeHtml(author.name)}`;

  const introHtml = montessoriHub
    ? `<section class="intro montessori-hero">
      <div class="hero-copy">
        <a class="education-badge" href="/catalogo?categoria=educacion">Educación · Pedagogía Montessori</a>
        <h1>${escapeHtml(pageTitle)}</h1>
        <p>${escapeHtml(author.intro)}</p>
        <p>Además de los títulos disponibles, esta página reúne una guía clara sobre María Montessori, los principios de su método, materiales y referencias en Uruguay.</p>
        <div class="hero-actions">
          <a class="primary-action" href="#libros">Ver libros disponibles</a>
          <a class="secondary-action" href="#metodo-montessori">Entender el método</a>
        </div>
      </div>
      <figure class="montessori-portrait">
        <img src="${MONTESSORI_PORTRAIT}" alt="Retrato histórico de María Montessori" width="500" height="887" decoding="async" fetchpriority="high">
        <figcaption>María Montessori, 1913 · Imagen de dominio público (CC0). <a href="${MONTESSORI_PORTRAIT_SOURCE}" target="_blank" rel="noopener noreferrer external">Fuente</a></figcaption>
      </figure>
    </section>
    ${montessoriQuickNav()}`
    : `<section class="intro">
      <h1>${escapeHtml(pageTitle)}</h1>
      <p>${escapeHtml(author.intro)}</p>
      <p>Podés comprar online, consultar stock o pedirnos una edición difícil de ubicar. Enviamos a Montevideo y al interior de Uruguay.</p>
    </section>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(pageTitle)} | Amado Libros</title>
  <meta name="description" content="${escapeHtml(metaDescription)}">
  <meta name="robots" content="index,follow">
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  ${faviconHeadHtml()}
  <meta property="og:type" content="website">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  <meta property="og:title" content="${escapeHtml(pageTitle)} | Amado Libros">
  <meta property="og:description" content="${escapeHtml(metaDescription)}">
  <meta property="og:image" content="${montessoriHub ? MONTESSORI_PORTRAIT : `${BASE}/images/logo-amado.png`}">
  <meta property="og:locale" content="es_UY">
  ${schemas.map(schema => `<script type="application/ld+json">${safeJson(schema)}</script>`).join('\n  ')}
  <style>
    *{box-sizing:border-box}
    html{scroll-behavior:smooth}
    body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#faf7f2;color:#1e293b;line-height:1.6}
    a{color:#1d4ed8}
    .sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
    header{background:#18120e;color:#fff;padding:1rem}
    header a{color:#fff;text-decoration:none;font-weight:800}
    .breadcrumbs{max-width:1100px;margin:0 auto;padding:.75rem 1rem;color:#64748b;font-size:.85rem}
    .breadcrumbs a{text-decoration:none}
    main{max-width:1100px;margin:0 auto;padding:1rem}
    .intro{background:#fff;border:1px solid #e2e8f0;border-radius:.75rem;padding:1.5rem;margin-bottom:1.5rem}
    .intro h1{font-size:clamp(1.55rem,4vw,2.2rem);line-height:1.2;margin:0 0 .75rem}
    .intro p{margin:.55rem 0;color:#475569}
    .count{color:#64748b;font-size:.9rem}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}
    .book-card{background:#fff;border:1px solid #e2e8f0;border-radius:.75rem;overflow:hidden;display:flex;flex-direction:column}
    .cover-link{display:flex;align-items:center;justify-content:center;aspect-ratio:2/3;background:#f8fafc}
    .cover-link img{width:100%;height:100%;object-fit:contain}
    .cover-fallback{font-size:2rem}
    .book-info{padding:.85rem;display:flex;flex:1;flex-direction:column;gap:.45rem}
    .book-info h2{font-size:.9rem;line-height:1.35;margin:0}
    .book-info h2 a{color:#1e293b;text-decoration:none}
    .book-author{font-size:.78rem;color:#64748b;margin:0}
    .book-price{font-weight:800;margin:.2rem 0;color:#6d28d9}
    .book-cta{margin-top:auto;background:#18120e;color:#fff;text-decoration:none;text-align:center;padding:.55rem;border-radius:.4rem;font-weight:700;font-size:.82rem}
    .wa-cta{display:inline-flex;margin-top:1.5rem;background:#25d366;color:#fff;text-decoration:none;padding:.8rem 1rem;border-radius:.55rem;font-weight:800}

    .montessori-hero{display:grid;gap:1.3rem;overflow:hidden;background:linear-gradient(135deg,#fff 0%,#fffaf3 100%);border-color:#eadfd0}
    .hero-copy{display:flex;flex-direction:column;align-items:flex-start;justify-content:center}
    .education-badge{display:inline-flex;margin-bottom:.7rem;border-radius:999px;background:#efe7d9;color:#6f5438;padding:.38rem .7rem;text-decoration:none;font-size:.73rem;font-weight:800}
    .hero-actions{display:flex;flex-wrap:wrap;gap:.65rem;margin-top:1rem}
    .primary-action,.secondary-action{display:inline-flex;align-items:center;justify-content:center;border-radius:.55rem;padding:.72rem .95rem;text-decoration:none;font-weight:800;font-size:.84rem}
    .primary-action{background:#18120e;color:#fff}
    .secondary-action{border:1px solid #cdbba5;color:#5e4935;background:#fff}
    .montessori-portrait{margin:0;border-radius:.7rem;overflow:hidden;background:#eee8df}
    .montessori-portrait img{display:block;width:100%;height:100%;max-height:360px;object-fit:cover;object-position:center 23%;filter:sepia(.08)}
    .montessori-portrait figcaption{padding:.5rem .65rem;color:#6b7280;background:#fff;font-size:.66rem;line-height:1.4}
    .montessori-portrait figcaption a{color:#475569}

    .hub-nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.65rem;margin:0 0 1.5rem}
    .hub-nav a{position:relative;display:flex;min-height:110px;flex-direction:column;border:1px solid #e5ddd3;border-radius:.75rem;background:#fff;padding:.85rem;text-decoration:none;box-shadow:0 5px 18px rgba(42,30,20,.04)}
    .hub-nav strong{color:#221a15;font-size:.86rem}
    .hub-nav span{margin-top:.25rem;color:#6b7280;font-size:.72rem;line-height:1.35}
    .hub-nav b{margin-top:auto;color:#a65f49;font-size:1rem}

    #libros{scroll-margin-top:1rem}
    .hub-content{display:grid;gap:1rem;margin-top:2rem}
    .hub-panel{scroll-margin-top:1rem;border:1px solid #e5ddd3;border-radius:.85rem;background:#fff;padding:1.25rem}
    .hub-panel h2{margin:.15rem 0 .65rem;color:#201815;font-size:clamp(1.25rem,3vw,1.75rem);line-height:1.2}
    .hub-panel p{color:#475569}
    .eyebrow{margin:0!important;color:#a65f49!important;text-transform:uppercase;letter-spacing:.08em;font-size:.68rem;font-weight:900}
    .principles-grid,.materials-grid,.uy-grid{display:grid;grid-template-columns:1fr;gap:.7rem;margin-top:1rem}
    .principles-grid div,.materials-grid div{display:flex;flex-direction:column;border-radius:.65rem;background:#faf7f2;padding:.85rem}
    .principles-grid strong,.materials-grid strong{color:#2f241d}
    .principles-grid span,.materials-grid span{margin-top:.2rem;color:#64748b;font-size:.82rem;line-height:1.45}
    .development-list{display:grid;gap:.55rem;margin:.9rem 0 0;padding-left:1.2rem;color:#475569}
    .commerce-note{margin-top:1rem;padding:.8rem;border-left:4px solid #d99a83;background:#fff7f2;font-size:.83rem}
    .uy-grid a{display:flex;flex-direction:column;border:1px solid #e5ddd3;border-radius:.7rem;background:#fffaf6;padding:1rem;text-decoration:none}
    .uy-grid strong{color:#221a15}
    .uy-grid span{margin:.25rem 0 .75rem;color:#64748b;font-size:.82rem;line-height:1.45}
    .uy-grid b{margin-top:auto;color:#a65f49;font-size:.75rem}
    .hub-sources{background:#f7f3ed}
    .source-links{display:flex;flex-wrap:wrap;gap:.7rem}
    .source-links a{font-size:.82rem;font-weight:700}

    @media(min-width:640px){
      .grid{grid-template-columns:repeat(3,minmax(0,1fr))}
      .hub-nav{grid-template-columns:repeat(3,minmax(0,1fr))}
      .principles-grid,.materials-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
      .uy-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
    }
    @media(min-width:800px){
      .montessori-hero{grid-template-columns:minmax(0,1.55fr) minmax(250px,.65fr);padding:1.75rem}
      .montessori-portrait img{max-height:400px}
    }
    @media(min-width:900px){
      .grid{grid-template-columns:repeat(5,minmax(0,1fr))}
      .hub-nav{grid-template-columns:repeat(6,minmax(0,1fr))}
      .hub-nav a{min-height:125px}
      .principles-grid,.materials-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
    }
    ${FOOTER_STYLES}
    ${WA_FLOAT_STYLES}
  </style>
</head>
<body>
<header><a href="/">📚 Amado Libros</a></header>
<nav class="breadcrumbs">${breadcrumbsHtml}</nav>
<main>
  ${introHtml}
  <section id="libros" aria-labelledby="books-heading">
    <h2 id="books-heading" class="sr-only">Libros disponibles de ${escapeHtml(author.name)}</h2>
    <p class="count">${items.length} título${items.length === 1 ? '' : 's'} disponible${items.length === 1 ? '' : 's'} ahora</p>
    <section class="grid" aria-label="Libros disponibles de ${escapeHtml(author.name)}">${cards}</section>
    <a class="wa-cta" href="${escapeHtml(whatsappHref(waMessage))}" target="_blank" rel="noopener noreferrer">Consultar otro título por WhatsApp</a>
  </section>
  ${montessoriHub ? montessoriEditorialHtml() : ''}
</main>
${footerHtml(undefined, canonicalUrl)}
${waFloatHtml(waMessage, canonicalUrl)}
</body>
</html>`;
}

export async function renderAuthorRoute(ctx, authorId) {
  const author = authorPageById(authorId);
  if (!author) return unavailable('Página de autor no encontrada.', 404);

  const catalog = await fetchCatalog(ctx);
  if (!catalog || !Array.isArray(catalog.items)) {
    return unavailable('No pudimos cargar el catálogo. Intentá nuevamente en unos minutos.');
  }
  const items = selectAuthorBooks(catalog.items, author);
  return new Response(renderAuthorPage(author, items, ctx.env?.APP_ENV === 'production'), {
    headers: {
      'content-type': 'text/html;charset=UTF-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}
