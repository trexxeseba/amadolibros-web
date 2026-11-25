// Señales respaldadas por el checkout real y las políticas de Amado.
// Fuentes verificadas el 24/11/2026:
// /devoluciones/ y /terminos/; MEF, derecho de retracto en compras a distancia.
// Mercado Pago Checkout Pro: el comprador paga en el entorno de Mercado Pago.
// No equivale al programa Compra Protegida de Mercado Libre ni a un sello de CA.

const icons = {
  card: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h3"/>',
  returns: '<path d="m7 5-4 4 4 4M3 9h12a6 6 0 0 1 0 12h-4"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>',
  people: '<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 4v2"/>',
};

function signal(icon, title, text, href, label, extra = '') {
  return '<li class="pt-item"><span class="pt-icon" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + icons[icon] + '</svg></span><div><strong class="pt-title">' + title + '</strong>' + extra + '<p class="pt-copy">' + text + '</p><a class="pt-link" href="' + href + '">' + label + '</a></div></li>';
}

export function purchaseTrustHtml({ compact = false } = {}) {
  return '<style>' + PURCHASE_TRUST_CSS + '</style><section class="purchase-trust' + (compact ? ' pt-compact' : '') + '" aria-label="Comprá con confianza"><h2>Comprá con tranquilidad</h2><ul class="pt-grid">' +
    signal('card', 'Pago seguro', 'Los datos de tu tarjeta se ingresan en Mercado Pago.', '/terminos/', 'Cómo pagás', '<span class="pt-provider">Mercado Pago</span>') +
    signal('returns', 'Si no te convence, podés devolverlo', 'Avisanos dentro de los 5 días hábiles desde que lo recibís.', '/devoluciones/', 'Ver devoluciones y reembolsos') +
    signal('lock', 'Conexión segura HTTPS', 'La información viaja cifrada entre tu navegador y esta web.', '/privacidad/', 'Cómo cuidamos tus datos') +
    signal('people', 'Personas que te responden', 'Librería familiar de Montevideo. Te acompañamos por WhatsApp.', '/contacto/', 'Contactar a Amado') +
    '</ul><p class="pt-conditions">Devolución por arrepentimiento: libro sin uso y en el mismo estado; gastos de retorno a cargo del comprador. Si llegó incorrecto o dañado, consultá cómo lo resolvemos en nuestra <a href="/devoluciones/">política de devoluciones</a>.</p></section>';
}

export const PURCHASE_TRUST_CSS = String.raw`
.purchase-trust{max-width:1100px;margin:1.5rem auto;padding:1.25rem;background:#f6f2e9;border:1px solid #dcd2c3;border-radius:.8rem;color:#29211c;font:400 .9rem/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.purchase-trust h2{margin:0 0 1rem;font-size:1.1rem;line-height:1.3;color:#29211c}
.purchase-trust .pt-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:1rem;margin:0;padding:0;list-style:none}
.purchase-trust .pt-item{display:flex;align-items:flex-start;gap:.7rem;padding:.9rem;background:#fffcf6;border:1px solid #e4dacc;border-radius:.55rem;min-width:0}
.purchase-trust .pt-icon{display:flex;align-items:center;justify-content:center;width:38px;height:38px;flex:0 0 38px;border-radius:50%;background:#e5efea;color:#155b43}
.purchase-trust .pt-title{display:block;font-size:.9rem;line-height:1.3;font-weight:750}
.purchase-trust .pt-provider{display:block;color:#007ca5;font-size:1.1rem;font-weight:800;line-height:1.4;margin-top:.15rem}
.purchase-trust .pt-copy{margin:.35rem 0 .4rem;font-size:.8rem;line-height:1.5;color:#554b42}
.purchase-trust .pt-link,.purchase-trust .pt-conditions a{color:#86422a;text-decoration:underline;text-underline-offset:3px;font-weight:650;font-size:.78rem}
.purchase-trust a:focus-visible{outline:3px solid #86422a;outline-offset:3px}
.purchase-trust .pt-conditions{margin:1rem 0 0;font-size:.74rem;line-height:1.5;color:#63574c}
.purchase-trust.pt-compact{padding:1rem;margin:1rem 0}
.purchase-trust.pt-compact .pt-grid{grid-template-columns:1fr;gap:.6rem}
.purchase-trust.pt-compact .pt-item{padding:.65rem .75rem}
`;
