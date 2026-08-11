/**
 * functions/_shared/brand.js — GLOBAL-SHELL-1
 *
 * Fuente única de verdad del "shell" global del sitio: marca, links
 * institucionales, contacto, favicon, footer y burbuja de WhatsApp.
 *
 * POR QUÉ EXISTE
 *   El sitio se renderiza por dos caminos distintos: Astro (home, carrito,
 *   páginas de confianza) y Pages Functions SSR (ficha de libro, catálogo).
 *   Astro no puede importar sus componentes .astro dentro de una Function, así
 *   que el shell se venía copiando a mano y divergió: la ficha quedó sin
 *   favicon, sin WhatsApp flotante y con un footer reducido a
 *   "Catálogo · Políticas", mientras la home tenía el footer completo.
 *
 *   Este módulo es JS plano justamente para que lo puedan importar los dos
 *   lados. Los componentes .astro siguen siendo la presentación de Astro; lo
 *   que se comparte acá son los DATOS y el marcado del shell SSR. La paridad
 *   entre ambos la sostienen los tests de
 *   functions/__tests__/global-shell-parity.test.js: si alguien cambia un
 *   texto o un link en Footer.astro y no acá (o al revés), fallan.
 *
 * ALCANCE
 *   Este lote NO cambia el copy existente: lo traslada tal cual está hoy en
 *   Footer.astro. En particular la línea del punto de retiro se mantiene
 *   textual — su reescritura es responsabilidad de PICKUP-CX-1, que gracias a
 *   este módulo pasa a ser un cambio en un solo lugar.
 */

export const BRAND = {
    name: 'Amado Libros',
    tagline: 'Una librería familiar, atendida por sus dueños. Nos importa ' +
             'recomendarte bien y que disfrutes tu experiencia en Amado Libros.',
    logo: '/images/logo-amado.webp',
    logoAlt: 'Amado Libros',
};

/** Copy canónico del punto de retiro. Única fuente para Astro y SSR. */
export const PICKUP = {
    name:  'Pick up a pasos de Plaza Matriz',
    hours: 'Lunes a viernes, de 8 a 17 h',
    notice: 'Para evitar que vengas en vano, esperá nuestra confirmación por ' +
            'WhatsApp antes de venir. Te avisaremos apenas tu pedido esté ' +
            'pronto para retirar.',
    checkbox: 'Entiendo que debo esperar la confirmación por WhatsApp antes ' +
              'de ir a retirar.',
    confirmation: 'Tu compra quedó confirmada y ya estamos preparando tu ' +
                  'pedido. Esperá nuestro mensaje por WhatsApp: te avisaremos ' +
                  'apenas esté pronto para retirar.',
    internalNotice: 'PICK UP — ACCIÓN PENDIENTE: avisar al cliente por ' +
                    'WhatsApp cuando el pedido esté pronto. El cliente fue ' +
                    'informado de que no debe concurrir antes de recibir la ' +
                    'confirmación.',
};

export const CONTACT = {
    whatsappNumber: '59899841325',
    whatsappDisplay: '099 841 325',
    email: 'adm@amadolibros.com',
    // PICKUP-CX-1: el contenido público ya no expone la dirección exacta del
    // punto de retiro. Un comprador que la veía podía presentarse antes de que
    // el pedido estuviera pronto y volverse con las manos vacías. La dirección
    // se entrega recién en la confirmación por WhatsApp, cuando ya está listo.
    // El domicilio legal/comercial es otra cosa y vive en /contacto.
    pickupLine: PICKUP.name,
    pickupHours: PICKUP.hours,
};


export const FOOTER_LINKS = [
    { href: '/pedir-libro', label: '¿No encontraste el libro?' },
    { href: '/libros-agotados-importados-uruguay', label: 'Libros por encargo' },
    { href: '/envios',       label: 'Envíos y retiro' },
    { href: '/devoluciones', label: 'Devoluciones y reembolsos' },
    { href: '/terminos',     label: 'Términos y cancelaciones' },
    { href: '/privacidad',   label: 'Privacidad' },
];

/** Enlace de WhatsApp con mensaje propio, siempre codificado. */
export function waHref(message) {
    return `https://wa.me/${CONTACT.whatsappNumber}?text=${encodeURIComponent(message)}`;
}

const WA_ICON_PATH = 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347zM12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.663 1.437 5.17L2.057 22.5l5.373-1.408A9.953 9.953 0 0 0 12 22c5.523 0 10-4.477 10-10S17.523 2 12 2z';

/**
 * Links de favicon/manifest para el <head>.
 *
 * Los archivos existen de verdad en astro-front/public/ (antes /favicon.ico
 * caía en el fallback de la SPA y devolvía text/html). El parámetro ?v= vence
 * la caché agresiva que el navegador aplica a los iconos.
 */
export const ICON_VERSION = 'v2';

export function faviconHeadHtml() {
    const v = ICON_VERSION;
    return [
        `<link rel="icon" href="/favicon.ico?${v}" sizes="any">`,
        `<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png?${v}">`,
        `<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png?${v}">`,
        `<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?${v}">`,
        `<link rel="manifest" href="/site.webmanifest?${v}">`,
    ].join('\n  ');
}

/**
 * Burbuja flotante de WhatsApp, equivalente a WAFloat.astro.
 *
 * `message` permite el mensaje contextual de la ficha ("consulta sobre
 * [título]"); sin él usa el genérico de la home. Los estilos van embebidos
 * porque las Functions no participan del pipeline de estilos de Astro.
 */
export function waFloatHtml(message) {
    const href = waHref(message || '¡Hola! Quisiera consultar sobre un libro');
    return `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer" class="wa-float" aria-label="Consultar por WhatsApp">
  <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${WA_ICON_PATH}"/></svg>
  <span class="wa-float-label">WhatsApp</span>
</a>`;
}

export const WA_FLOAT_STYLES = `
    .wa-float{position:fixed;right:1rem;z-index:50;
        bottom:calc(1rem + env(safe-area-inset-bottom,0px));
        display:flex;align-items:center;justify-content:center;gap:.5rem;
        width:56px;height:56px;padding:0;border-radius:999px;
        background:#25d366;color:#fff;text-decoration:none;
        box-shadow:0 4px 12px rgba(37,211,102,.35),0 2px 4px rgba(0,0,0,.12);
        transition:background .15s,transform .15s}
    .wa-float:hover{background:#1ebe5b;transform:translateY(-2px)}
    .wa-float:focus-visible{outline:2px solid #18120e;outline-offset:3px}
    .wa-float-label{display:none}
    @media(min-width:900px){
        .wa-float{width:auto;height:auto;padding:.7rem 1.1rem}
        .wa-float-label{display:inline;font-weight:700;font-size:.95rem}
    }`;

/**
 * Footer completo, con el mismo contenido estructural que Footer.astro:
 * marca, tagline, links institucionales, contacto y copyright dinámico.
 */
export function footerHtml(year = new Date().getFullYear()) {
    const links = FOOTER_LINKS
        .map(l => `<li><a href="${l.href}">${l.label}</a></li>`)
        .join('');
    const wa = waHref('Hola Amado Libros, quisiera consultar');
    return `<footer class="site-footer">
  <div class="footer-inner">
    <div class="footer-brand">
      <p class="footer-name">${BRAND.name}</p>
      <p class="footer-tagline">${BRAND.tagline}</p>
      <p class="footer-copy">&copy; ${year} ${BRAND.name}</p>
    </div>
    <div class="footer-info">
      <p class="footer-info-title">Cómo comprás</p>
      <ul class="footer-list">${links}</ul>
    </div>
    <div class="footer-contact">
      <p class="footer-info-title">Contacto</p>
      <a class="footer-wa-link" href="${escapeAttr(wa)}" target="_blank" rel="noopener noreferrer">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${WA_ICON_PATH}"/></svg>
        WhatsApp · ${CONTACT.whatsappDisplay}
      </a>
      <a class="footer-text-link" href="mailto:${CONTACT.email}">${CONTACT.email}</a>
      <a class="footer-text-link" href="/contacto">${CONTACT.pickupLine}</a>
      <p class="footer-hours">${CONTACT.pickupHours}</p>
    </div>
  </div>
</footer>`;
}

export const FOOTER_STYLES = `
    .site-footer{background:#18120e;color:rgba(248,245,239,.55);
        margin-top:2.5rem;font-size:.85rem;line-height:1.55}
    /* El padding inferior reserva el alto de la burbuja flotante (56px) mas
       su separacion, para que no tape la ultima linea del footer. */
    .footer-inner{max-width:1100px;margin:0 auto;
        padding:2rem 1rem calc(5.5rem + env(safe-area-inset-bottom,0px));
        display:grid;gap:1.75rem;grid-template-columns:minmax(0,1fr)}
    @media(min-width:760px){
        .footer-inner{grid-template-columns:2fr 1fr 1fr;gap:2rem;
            padding-bottom:calc(3rem + env(safe-area-inset-bottom,0px))}
    }
    .site-footer a{color:rgba(248,245,239,.8);text-decoration:none}
    .site-footer a:hover{text-decoration:underline}
    .site-footer a:focus-visible{outline:2px solid #f8f5ef;outline-offset:2px}
    .footer-name{font-weight:800;font-size:1rem;color:#f8f5ef;margin-bottom:.4rem}
    .footer-tagline{margin-bottom:.75rem;max-width:46ch}
    .footer-copy{font-size:.78rem;color:rgba(248,245,239,.45)}
    .footer-info-title{font-weight:700;color:#f8f5ef;margin-bottom:.5rem}
    .footer-list{list-style:none;padding:0;margin:0;display:grid;gap:.35rem}
    .footer-contact{display:grid;gap:.4rem;justify-items:start}
    .footer-wa-link{display:inline-flex;align-items:center;gap:.4rem;
        min-height:44px}
    .footer-text-link{min-height:44px;display:inline-flex;align-items:center}`;

function escapeAttr(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
