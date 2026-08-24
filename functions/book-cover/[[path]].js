import { fetchCatalog, fetchPausedItem } from '../_shared/catalog.js';
import { findPreviewCover } from '../_shared/preview-cover.js';
import { overrideImageForProduct } from '../_shared/catalog-image-overrides.js';

const PRODUCT_ID_RE = /^MLU\d+$/;
const COVER_FILE_RE = /^cover(?:-([2-9]|1[0-6]))?\.jpg$/;
const MAX_GALLERY_IMAGES = 16;

function largeMlImage(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const url = new URL(raw.trim());
    const hostname = url.hostname.toLowerCase();
    if (!(hostname === 'mlstatic.com' || hostname.endsWith('.mlstatic.com')) ||
        !['http:', 'https:'].includes(url.protocol)) return '';
    url.protocol = 'https:';
    url.hash = '';
    url.pathname = url.pathname.replace(/-I\.(jpg|jpeg|png|webp)$/i, '-O.$1');
    return url.toString();
  } catch {
    return '';
  }
}

export function primaryCoverSource(item) {
  return coverSource(item, 0);
}

export function coverSource(item, position = 0) {
  if (!Number.isInteger(position) || position < 0 || position >= MAX_GALLERY_IMAGES) return '';
  // CATALOG-IMAGE-QUALITY-1: sólo la posición 0 (portada) puede tener un
  // override explícito y verificado — nunca el resto de la galería. Sólo
  // los IDs listados en catalog-image-overrides.js reciben esto; cualquier
  // otro producto sigue su resolución normal por pictures[]/thumbnail.
  if (position === 0) {
    const override = overrideImageForProduct(item?.id);
    if (override) return largeMlImage(override.imageUrl);
  }
  const pictures = Array.isArray(item?.pictures)
    ? item.pictures.filter(value => typeof value === 'string')
    : [];
  const picture = pictures[position] || (position === 0 ? item?.thumbnail : '');
  return largeMlImage(picture || '');
}

function responseHeaders(source, contentType, etag = null) {
  return {
    'content-type': contentType?.startsWith('image/') ? contentType : 'image/jpeg',
    'cache-control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000',
    'x-content-type-options': 'nosniff',
    'access-control-allow-origin': '*',
    ...(etag ? { etag } : {}),
    'x-cover-source': source,
  };
}

async function r2CoverResponse(ctx, cover) {
  const bucket = ctx.env?.COVER_R2;
  if (!cover || !bucket || typeof bucket.get !== 'function') return null;
  const object = await bucket.get(cover.objectKey);
  if (!object?.body) return null;
  return new Response(object.body, {
    status: 200,
    headers: responseHeaders(
      ctx.env?.APP_ENV === 'production' ? 'r2-production' : 'r2-preview',
      cover.mime,
      `"${cover.sha256}"`,
    ),
  });
}

export async function onRequest(ctx) {
  if (!['GET', 'HEAD'].includes(ctx.request.method)) {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const parts = Array.isArray(ctx.params.path) ? ctx.params.path : [ctx.params.path].filter(Boolean);
  const id = String(parts[0] || '').toUpperCase();
  const coverMatch = COVER_FILE_RE.exec(String(parts[1] || ''));
  const position = coverMatch ? Math.max(0, Number(coverMatch[1] || 1) - 1) : -1;
  if (!PRODUCT_ID_RE.test(id) || parts.length !== 2 || position < 0) {
    return new Response('Not Found', { status: 404, headers: { 'cache-control': 'public,max-age=300' } });
  }

  const cache = caches.default;
  const filename = position === 0 ? 'cover.jpg' : `cover-${position + 1}.jpg`;
  const cacheKey = new Request(new URL(ctx.request.url).origin + `/book-cover/${id}/${filename}`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    return ctx.request.method === 'HEAD'
      ? new Response(null, { status: cached.status, headers: cached.headers })
      : cached;
  }

  const catalog = await fetchCatalog(ctx);
  let item = Array.isArray(catalog?.items) ? catalog.items.find(candidate => candidate.id === id) : null;
  if (!item && ['preview', 'production'].includes(ctx.env?.APP_ENV)) item = await fetchPausedItem(ctx, id);
  const source = coverSource(item, position);
  const storedCover = await findPreviewCover(ctx, id, position, source || null);
  let response = await r2CoverResponse(ctx, storedCover);

  if (!response && source) {
    const imageResponse = await fetch(source, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; AmadoLibrosCover/1.0)' },
    }).catch(() => null);
    if (imageResponse?.ok && String(imageResponse.headers.get('content-type') || '').startsWith('image/')) {
      response = new Response(imageResponse.body, {
        status: 200,
        headers: responseHeaders('mercadolibre', imageResponse.headers.get('content-type')),
      });
    }
  }

  // No se disfraza una portada rota con el logo: Merchant y el auditor deben
  // poder detectar la falla real y reintentarla desde el mirror.
  if (!response) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'cache-control': 'public, max-age=300', 'x-cover-source': 'missing' },
    });
  }
  if (typeof ctx.waitUntil === 'function') ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return ctx.request.method === 'HEAD'
    ? new Response(null, { status: 200, headers: response.headers })
    : response;
}
