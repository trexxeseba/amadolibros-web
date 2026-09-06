import { BASE } from './catalog.js';

const PRODUCT_ID_RE = /^MLU\d+$/;
const MAX_GALLERY_IMAGES = 16;
const DEFAULT_WIDTHS = [240, 360, 480];

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function sameProductionZone(source) {
  try {
    const url = new URL(source, BASE);
    return url.origin === BASE && !url.pathname.startsWith('/cdn-cgi/image/');
  } catch {
    return false;
  }
}

/**
 * Imagen de galería controlada por Amado Libros. El endpoint prioriza R2 y
 * conserva Mercado Libre únicamente como fallback mientras termina el mirror.
 */
export function bookCoverUrl(productId, position = 0) {
  const id = String(productId || '').toUpperCase();
  if (!PRODUCT_ID_RE.test(id)) return '';
  const normalizedPosition = Number.isInteger(position) && position >= 0 && position < MAX_GALLERY_IMAGES
    ? position
    : 0;
  const filename = normalizedPosition === 0 ? 'cover.jpg' : `cover-${normalizedPosition + 1}.jpg`;
  return `${BASE}/book-cover/${encodeURIComponent(id)}/${filename}`;
}

/**
 * URL de Cloudflare Images para una fuente de la propia zona. No transforma
 * hosts externos ni previews: esos conservan su URL original para no romper
 * entornos donde la zona no está habilitada.
 */
export function cloudflareImageUrl(source, {
  width,
  quality = 85,
  fit = 'scale-down',
} = {}) {
  if (!source || !sameProductionZone(source)) return String(source || '');
  const targetWidth = positiveInteger(width);
  if (!targetWidth) return String(source);
  const targetQuality = Math.min(100, Math.max(1, positiveInteger(quality) || 85));
  const sourceUrl = new URL(source, BASE);
  const options = [
    'format=auto',
    `fit=${fit}`,
    `width=${targetWidth}`,
    `quality=${targetQuality}`,
    'onerror=redirect',
  ].join(',');
  return `${BASE}/cdn-cgi/image/${options}${sourceUrl.pathname}${sourceUrl.search}`;
}

/**
 * Devuelve src/srcset/sizes listos para HTML responsivo. Cada ancho produce
 * una única variante cacheable; el navegador descarga solamente la adecuada.
 */
export function responsiveImage(source, {
  widths = DEFAULT_WIDTHS,
  defaultWidth,
  sizes = '100vw',
  quality = 85,
  fit = 'scale-down',
} = {}) {
  const requestedWidths = widths.map(positiveInteger).filter(Boolean);
  // La ficha pide [320, 480, 768, 1024]. En un móvil retina la portada de
  // 260 CSS px necesita ~520 px físicos: 640 evita saltar directamente a 768.
  const candidateWidths = requestedWidths.includes(480) && requestedWidths.includes(768)
    ? [...requestedWidths, 640]
    : requestedWidths;
  const normalizedWidths = [...new Set(candidateWidths)].sort((a, b) => a - b);
  const fallbackWidth = positiveInteger(defaultWidth) || normalizedWidths.at(-1) || 480;
  const src = cloudflareImageUrl(source, { width: fallbackWidth, quality, fit });
  if (!sameProductionZone(source) || normalizedWidths.length === 0) {
    return { src, srcset: '', sizes: '' };
  }
  const srcset = normalizedWidths
    .map(width => `${cloudflareImageUrl(source, { width, quality, fit })} ${width}w`)
    .join(', ');
  return { src, srcset, sizes };
}

export const CARD_IMAGE_SIZES = '(max-width: 639px) calc(50vw - 24px), (max-width: 1023px) calc(33vw - 24px), 280px';
// La portada de la ficha tiene max-width:260px. Declarar 360px hacía que
// Chrome eligiera variantes 768px en mobile y descargara bytes innecesarios.
export const PRODUCT_IMAGE_SIZES = '(max-width: 291px) calc(100vw - 32px), 260px';
