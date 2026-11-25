/**
 * Ficha de un libro que ya no está en el catálogo (publicación finalizada en
 * Mercado Libre: no figura ni activa ni pausada).
 *
 * Antes respondía "Libro no encontrado" a secas, aunque Google todavía
 * mostrara el libro como disponible. Ahora:
 * - si hay otra publicación activa con el mismo título (mismo slug), la ficha
 *   vieja redirige ahí (301);
 * - si no, se muestra que el libro se agotó, con encargo (/pedir-libro con el
 *   título cargado), WhatsApp y libros parecidos con stock.
 * La respuesta sigue siendo 404 y noindex: el libro no está a la venta y Google
 * deja de mostrarlo como disponible.
 */
import { slugify } from './slug.js';
import { faviconHeadHtml, footerHtml, FOOTER_STYLES } from './brand.js';
import { siteHeaderHtml, SITE_HEADER_STYLES, SITE_HEADER_SCRIPT, SITE_FONTS_HEAD } from './site-header.js';
import { bookCoverUrl, responsiveImage } from './cloudflare-images.js';
import { whatsappHref } from '../../shared/whatsapp-messages.js';

const STOPWORDS = new Set([
    'de', 'del', 'la', 'las', 'el', 'los', 'y', 'en', 'un', 'una', 'para', 'por', 'con', 'sin', 'al', 'a', 'o',
    'libro', 'libros', 'tapa', 'blanda', 'dura', 'edicion', 'nueva', 'the', 'and', 'of',
]);

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** "biblia-rvr-1960-letra-grande" → "Biblia rvr 1960 letra grande". */
export function tituloDesdeSlug(slug) {
    let raw = String(slug ?? '');
    try { raw = decodeURIComponent(raw); } catch { /* slug con % suelto */ }
    const texto = raw.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 160);
    if (!texto) return '';
    return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function palabras(texto) {
    return [...new Set(slugify(texto).split('-').filter(w => (w.length >= 3 || /^\d+$/.test(w)) && !STOPWORDS.has(w)))];
}

const conStock = item => item?.title && item.status === 'active' && (Number(item.available_quantity) || 0) > 0;

/** Otra publicación activa del mismo libro (mismo slug de título), o null. */
export function buscarReemplazo(items, slug, id) {
    const objetivo = slugify(tituloDesdeSlug(slug));
    if (!objetivo || !Array.isArray(items)) return null;
    return items.find(item => item?.id !== id && conStock(item) && slugify(item.title) === objetivo) || null;
}

/** Libros con stock que comparten más palabras con el título buscado. */
export function librosParecidos(items, slug, limit = 6) {
    const buscadas = palabras(tituloDesdeSlug(slug));
    if (!buscadas.length || !Array.isArray(items)) return [];
    const minimo = buscadas.length >= 3 ? 2 : 1;
    const puntuados = [];
    for (const item of items) {
        if (!conStock(item)) continue;
        const propias = new Set(palabras(item.title));
        let puntos = 0;
        for (const w of buscadas) if (propias.has(w)) puntos += 1;
        if (puntos >= minimo) puntuados.push({ item, puntos });
    }
    puntuados.sort((a, b) => b.puntos - a.puntos || (Number(a.item.price) || 0) - (Number(b.item.price) || 0));
    return puntuados.slice(0, limit).map(p => p.item);
}

function tarjeta(book, useCloudflareImages) {
    const href = `/libro/${encodeURIComponent(book.id)}/${slugify(book.title)}`;
    const source = useCloudflareImages ? bookCoverUrl(book.id) : (book.thumbnail || '');
    const image = responsiveImage(source, { widths: [120, 180, 240], defaultWidth: 180, sizes: '(max-width: 759px) calc(50vw - 40px), 180px' });
    const srcset = image.srcset ? ` srcset="${esc(image.srcset)}" sizes="${esc(image.sizes)}"` : '';
    const img = image.src ? `<img src="${esc(image.src)}"${srcset} alt="" loading="lazy" decoding="async" width="180" height="240">` : '<span class="rt-noimg"></span>';
    const precio = Number(book.price) > 0 ? `<span class="rt-precio">$${Math.round(Number(book.price)).toLocaleString('es-UY')} UYU</span>` : '';
    return `<a class="rt-card" href="${esc(href)}">${img}<span class="rt-titulo">${esc(book.title)}</span>${precio}</a>`;
}

export function fichaRetiradaHtml({ slug, parecidos = [], useCloudflareImages = true, year = new Date().getFullYear() }) {
    const titulo = tituloDesdeSlug(slug);
    const encargo = `/pedir-libro?tipo=agotado${titulo ? `&q=${encodeURIComponent(titulo)}` : ''}`;
    const wa = whatsappHref(titulo
        ? `Hola, busco «${titulo}». Vi que se agotó en la web. ¿Lo pueden conseguir?`
        : 'Hola, busco un libro que se agotó en la web. ¿Me ayudan a conseguirlo?');
    const buscar = titulo ? `/catalogo?q=${encodeURIComponent(titulo)}` : '/catalogo';
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${titulo ? `${esc(titulo)} — se agotó` : 'Libro agotado'} — Amado Libros</title>
  <meta name="robots" content="noindex, follow">
  ${faviconHeadHtml()}
  ${SITE_FONTS_HEAD}
  <style>
    *{box-sizing:border-box}
    body{margin:0;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#18120e;background:#faf7f2;line-height:1.5}
    ${SITE_HEADER_STYLES}
    ${FOOTER_STYLES}
    .rt{max-width:880px;margin:0 auto;padding:1.5rem 1rem 3rem}
    .rt-box{background:#fff;border:1px solid #e4dccf;border-radius:1rem;padding:1.5rem}
    .rt-eyebrow{display:inline-block;font-size:.78rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#a94e3d;background:#fdeee8;border-radius:999px;padding:.2rem .7rem}
    .rt h1{font-size:1.6rem;line-height:1.2;margin:.6rem 0 .5rem}
    .rt p{color:#5a524b;margin:.4rem 0}
    .rt-acciones{display:flex;flex-wrap:wrap;gap:.6rem;margin-top:1.1rem}
    .rt-btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:.65rem 1.15rem;border-radius:.65rem;font-weight:800;text-decoration:none}
    .rt-btn.encargo{background:#a94e3d;color:#fff}
    .rt-btn.wa{background:#1a9e4b;color:#fff}
    .rt-btn.sec{border:1px solid #d1c8be;color:#18120e;background:#fff}
    .rt h2{font-size:1.15rem;margin:2rem 0 .8rem}
    .rt-grid{display:grid;gap:.9rem;grid-template-columns:repeat(2,1fr)}
    @media(min-width:640px){.rt-grid{grid-template-columns:repeat(3,1fr)}}
    .rt-card{display:flex;flex-direction:column;gap:.35rem;background:#fff;border:1px solid #e4dccf;border-radius:.8rem;padding:.7rem;color:#18120e;text-decoration:none}
    .rt-card img,.rt-noimg{width:100%;height:auto;aspect-ratio:3/4;object-fit:contain;background:#f4efe6;border-radius:.4rem}
    .rt-titulo{font-size:.9rem;font-weight:700;line-height:1.3}
    .rt-precio{font-size:.9rem;color:#a94e3d;font-weight:800}
    @media(max-width:520px){.rt-btn{width:100%}}
  </style>
</head>
<body>
${siteHeaderHtml({ query: titulo })}
<main class="rt">
  <section class="rt-box">
    <span class="rt-eyebrow">Se agotó</span>
    <h1>${titulo ? esc(titulo) : 'Este libro se agotó'}</h1>
    <p>Este libro se agotó y ya no está en nuestro catálogo. Muchas veces lo conseguimos por encargo: dejanos el pedido y te escribimos con el precio y el plazo.</p>
    <div class="rt-acciones">
      <a class="rt-btn encargo" href="${esc(encargo)}">Pedilo por encargo</a>
      <a class="rt-btn wa" href="${esc(wa)}" target="_blank" rel="noopener noreferrer" data-cta-location="ficha_agotada">Consultar por WhatsApp</a>
      <a class="rt-btn sec" href="${esc(buscar)}">Buscar en el catálogo</a>
    </div>
  </section>
  ${parecidos.length ? `<h2>Parecidos con stock</h2><div class="rt-grid">${parecidos.map(b => tarjeta(b, useCloudflareImages)).join('')}</div>` : ''}
</main>
${footerHtml(year, '/libro')}
${SITE_HEADER_SCRIPT}
</body>
</html>`;
}

export function fichaRetiradaResponse(opts) {
    return new Response(fichaRetiradaHtml(opts), {
        status: 404,
        headers: {
            'content-type': 'text/html;charset=UTF-8',
            'cache-control': 'public, max-age=300',
            'x-robots-tag': 'noindex, follow',
        },
    });
}
