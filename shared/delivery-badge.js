// Mensaje comercial solicitado por Seba el 12/09/2026.
// Se muestra para productos con stock; la cobertura se explicita en el sello.
// No modifica stock, plazos del checkout ni datos estructurados de envío.
export function deliveryBadgeHtml(available) {
    if (!available) return '';
    return '<span class="delivery-today" aria-label="Te llega hoy en Montevideo"><strong>Te llega hoy</strong><span>Montevideo</span></span>';
}

export const DELIVERY_BADGE_STYLES = `
.delivery-today{display:inline-flex;flex-direction:column;align-items:flex-start;align-self:flex-start;gap:.08rem;max-width:100%;padding:.4rem .65rem;border-radius:.5rem;background:#126339;color:#fff;line-height:1.2;margin:0 0 .25rem}
.delivery-today strong{color:inherit;font-family:inherit;font-size:.78rem;font-weight:800;letter-spacing:.015em}
.delivery-today>span{color:inherit;font-family:inherit;font-size:.64rem;font-weight:500}
`;
