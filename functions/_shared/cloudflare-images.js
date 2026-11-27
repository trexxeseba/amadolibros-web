import { BASE } from './catalog.js';
import { permanentImageUrl } from '../../shared/image-variants.js';

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
  permanent = false,
} = {}) {
  if (permanent && fit === 'scale-down' && Number(quality) === 85 && [240, 360, 480].includes(Number(width)))
    return permanentImageUrl(source, { width: Number(width), quality: 85, fit });
  if (!source || !sameProductionZone(source)) return String(source || '');
  const targetWidth = positiveInteger(width);
  if (!targetWidth) return String(source);
  // Variante WebP permanente guardada en R2 (?variant=v1-<ancho>-q<calidad>).
  // Si todavía no existe, /book-cover sirve el original: lo mismo que hacía
  // /cdn-cgi/image/ con las transformaciones apagadas, sin la redirección
  // extra y sin transformaciones pagas. Anchos sin receta usan el original.
  return permanentImageUrl(source, { width: targetWidth, quality: positiveInteger(quality) || 85, fit });
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
  permanent = false,
} = {}) {
  const normalizedWidths = [...new Set(widths.map(positiveInteger).filter(Boolean))]
    .sort((a, b) => a - b);
  const fallbackWidth = positiveInteger(defaultWidth) || normalizedWidths.at(-1) || 480;
  const options = { quality, fit, permanent };
  const src = cloudflareImageUrl(source, { width: fallbackWidth, ...options });
  if ((!sameProductionZone(source) && !permanent) || normalizedWidths.length === 0) {
    return { src, srcset: '', sizes: '' };
  }
  const srcset = normalizedWidths
    .map(width => `${cloudflareImageUrl(source, { width, ...options })} ${width}w`)
    .join(', ');
  return { src, srcset, sizes };
}

export const CARD_IMAGE_SIZES = '(max-width: 639px) calc(50vw - 24px), (max-width: 1023px) calc(33vw - 24px), 280px';
export const PRODUCT_IMAGE_SIZES = '(max-width: 759px) calc(100vw - 48px), 360px';
