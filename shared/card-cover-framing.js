// Encuadres solicitados por Seba, 2026-09-12. Las fotos originales incluyen
// mucho fondo gris. Se amplía su presentación en tarjetas sin editar el archivo.
// Alma y Frin: 9789504645672. Deleuze y la brujería: 9789871501151.
const ENLARGED_COVER_IDS = new Set(['MLU697305757', 'MLU706573878', 'MLU693752792', 'MLU693866286', 'MLU616949061', 'MLU644725123']);

// La imagen ampliada necesita más píxeles que su caja CSS. El resto de las
// tarjetas mantiene las variantes habituales de 240/360/480 píxeles.
export function cardCoverImageOptions(productId) {
  return ENLARGED_COVER_IDS.has(productId) ? {
    widths: [480, 720, 960], defaultWidth: 720,
    sizes: '(max-width: 639px) calc(90vw - 42px), (max-width: 1023px) calc(60vw - 42px), 500px',
  } : {};
}

export const CARD_COVER_FRAMING_STYLES = `
:is(.book-image,.rc-img,.bc-img-link,.v2-book-cover)[href*="/MLU697305757/"] img:not(.v2-book-fallback){object-fit:contain!important;transform:scale(1.65)!important;transform-origin:50% 50%}
:is(.book-image,.rc-img,.bc-img-link,.v2-book-cover)[href*="/MLU706573878/"] img:not(.v2-book-fallback){object-fit:contain!important;transform:scale(1.72)!important;transform-origin:50% 50%}
:is(.book-image,.rc-img,.bc-img-link,.v2-book-cover):is([href*="/MLU693752792/"],[href*="/MLU693866286/"]) img:not(.v2-book-fallback){object-fit:contain!important;transform:scale(1.65)!important;transform-origin:50% 50%}
:is(.book-image,.rc-img,.bc-img-link,.v2-book-cover)[href*="/MLU616949061/"] img:not(.v2-book-fallback){object-fit:contain!important;transform:scale(1.7)!important;transform-origin:50% 54%}
:is(.book-image,.rc-img,.bc-img-link,.v2-book-cover)[href*="/MLU644725123/"] img:not(.v2-book-fallback){object-fit:contain!important;transform:scale(1.75)!important;transform-origin:50% 50%}
`;
