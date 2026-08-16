const BASE = 'https://www.amadolibros.com';
const PRODUCT_ID_RE = /^MLU\d+$/;

export function bookCoverUrl(productId, position = 0) {
  const id = String(productId || '').toUpperCase();
  if (!PRODUCT_ID_RE.test(id)) return '';
  const normalizedPosition = Number.isInteger(position) && position >= 0 && position < 6
    ? position
    : 0;
  const filename = normalizedPosition === 0 ? 'cover.jpg' : `cover-${normalizedPosition + 1}.jpg`;
  return `${BASE}/book-cover/${encodeURIComponent(id)}/${filename}`;
}

export function cloudflareImageUrl(source, width, quality = 85) {
  const targetWidth = Number(width);
  if (!source || !Number.isInteger(targetWidth) || targetWidth <= 0) return String(source || '');
  const sourceUrl = new URL(source, BASE);
  if (sourceUrl.origin !== BASE || sourceUrl.pathname.startsWith('/cdn-cgi/image/')) {
    return String(source);
  }
  const options = `format=auto,fit=scale-down,width=${targetWidth},quality=${quality},onerror=redirect`;
  return `${BASE}/cdn-cgi/image/${options}${sourceUrl.pathname}${sourceUrl.search}`;
}

export function responsiveBookCover(productId) {
  const source = bookCoverUrl(productId);
  const widths = [240, 360, 480];
  return {
    source,
    src: cloudflareImageUrl(source, 360),
    srcset: widths.map(width => `${cloudflareImageUrl(source, width)} ${width}w`).join(', '),
    sizes: '(max-width: 639px) calc(50vw - 24px), (max-width: 1023px) calc(33vw - 24px), 280px',
  };
}
