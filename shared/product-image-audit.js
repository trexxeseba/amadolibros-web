// Función autónoma compartida por la auditoría HTTP y el monitor externo.
// Inspecciona el HTML recibido del servidor; no confunde og:image con Product.image.
export function inspectProductImages(html, { allowBookOnly = false } = {}) {
  const products = []; const issues = new Set(); let hasBook = false;
  const visit = value => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    if (types.includes('Book')) hasBook = true;
    if (types.includes('Product')) {
      const raw = Array.isArray(value.image) ? value.image : [value.image];
      const urls = raw.map(image => typeof image === 'string' ? image : image?.contentUrl || image?.url);
      const present = urls.filter(url => typeof url === 'string' && url.trim());
      const valid = present.filter(url => {
        try {
          const u = new URL(url);
          return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password &&
            !/^\/images\/logo-amado\.(webp|svg|png|jpe?g)$/i.test(u.pathname);
        } catch { return false; }
      });
      if (!present.length) issues.add('PRODUCT_IMAGE_MISSING');
      else if (valid.length !== urls.length) issues.add('PRODUCT_IMAGE_INVALID');
      products.push({ sku: typeof value.sku === 'string' ? value.sku : null, images: valid });
    }
    Object.values(value).forEach(visit);
  };
  for (const match of String(html || '').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/(?:^|\s)type\s*=\s*["']application\/ld\+json["']/i.test(match[1])) continue;
    try { visit(JSON.parse(match[2])); } catch { issues.add('PRODUCT_JSONLD_INVALID'); }
  }
  if (!products.length && !(allowBookOnly && hasBook)) issues.add('PRODUCT_SCHEMA_MISSING');
  return { products, hasBook, issues: [...issues] };
}
