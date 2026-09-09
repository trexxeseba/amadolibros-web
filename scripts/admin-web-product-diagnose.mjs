// Lectura puntual solicitada por Seba. Sin credenciales, escrituras de negocio ni despliegues.
import { pathToFileURL } from 'node:url';
import { inspectCoverBytes } from '../worker-sync/cover-mirror.js';

const TARGET = 'https://www.amadolibros.com/libro/MLU651526046/big-english-1-british-pupil-s-book-pearson';
const PRODUCT_ID = 'MLU651526046';
const MAX_BYTES = 8 * 1024 * 1024;
const decode = value => String(value || '').replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
const attr = (tag, name) => decode(tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1]);

export function inspectProductDocument(html) {
  const products = []; let invalidJson = 0;
  const walk = value => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    if (types.includes('Product')) products.push(value);
    Object.values(value).forEach(walk);
  };
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (attr(match[1], 'type').toLowerCase() !== 'application/ld+json') continue;
    try { walk(JSON.parse(match[2])); } catch { invalidJson++; }
  }
  const imageUrls = value => (Array.isArray(value) ? value : [value]).flatMap(image => {
    const url = typeof image === 'string' ? image : image?.contentUrl || image?.url;
    return typeof url === 'string' && url.trim() ? [url.trim()] : [];
  });
  const cover = [...html.matchAll(/<img\b[^>]*>/gi)].map(m => m[0]).find(tag => attr(tag, 'id') === 'gMainImg');
  const og = [...html.matchAll(/<meta\b[^>]*>/gi)].map(m => m[0]).find(tag => attr(tag, 'property') === 'og:image');
  return { invalidJson, productCount: products.length,
    products: products.map(p => ({ sku: p.sku || null, name: p.name || null,
      hasImageField: Object.hasOwn(p, 'image'), images: imageUrls(p.image), hasOffer: !!p.offers })),
    visibleCover: cover ? attr(cover, 'src') : null, socialImage: og ? attr(og, 'content') : null };
}

function permitted(raw) {
  const url = new URL(raw, TARGET);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['www.amadolibros.com', 'amadolibros.com'].includes(url.hostname)) throw new Error('UNEXPECTED_IMAGE_OR_REDIRECT_ORIGIN');
  return url;
}

async function read(raw, accept = 'text/html') {
  const started = Date.now(); let url = permitted(raw);
  const signal = AbortSignal.timeout(25000);
  for (let redirect = 0; redirect < 4; redirect++) {
    const response = await fetch(url, { redirect: 'manual', signal,
      headers: { 'user-agent': 'Amado-Readonly-Product-Diagnostic/1.0', accept } });
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('REDIRECT_WITHOUT_LOCATION');
      url = permitted(new URL(location, url)); continue;
    }
    const parts = []; let length = 0;
    for await (const chunk of response.body || []) {
      length += chunk.byteLength;
      if (length > MAX_BYTES) throw new Error('BODY_TOO_LARGE');
      parts.push(chunk);
    }
    return { url: url.toString(), httpStatus: response.status, elapsedMs: Date.now() - started,
      mime: response.headers.get('content-type'), coverSource: response.headers.get('x-cover-source'),
      bytes: Buffer.concat(parts) };
  }
  throw new Error('TOO_MANY_REDIRECTS');
}

const errorCode = error => /timeout|abort/i.test(`${error.name} ${error.message}`) ? 'TIMEOUT' :
  /^[A-Z_]+$/.test(error.message) ? error.message : 'NETWORK_OR_RESPONSE_ERROR';

export async function diagnose() {
  const checkedAt = new Date().toISOString();
  let page;
  try { page = await read(TARGET); }
  catch (error) { console.log(JSON.stringify({ status: 'product_diagnosis_inconclusive', checkedAt, target: TARGET, error: errorCode(error) })); process.exitCode = 1; return; }
  const { bytes, ...meta } = page;
  const document = inspectProductDocument(bytes.toString('utf8'));
  console.log(JSON.stringify({ status: 'product_document_diagnostic', checkedAt, ...meta, ...document }));
  if (page.httpStatus !== 200 || !document.productCount) { process.exitCode = 1; return; }
  const urls = [...new Set([document.visibleCover, document.socialImage,
    ...document.products.flatMap(p => p.images), `/book-cover/${PRODUCT_ID}/cover.jpg`].filter(Boolean))].slice(0, 6);
  for (const url of urls) {
    try {
      const response = await read(url, 'image/*');
      const { bytes: imageBytes, ...imageMeta } = response;
      let dimensions = null; let invalidImage = false;
      try { dimensions = inspectCoverBytes(new Uint8Array(imageBytes), response.mime); } catch { invalidImage = true; }
      console.log(JSON.stringify({ status: 'product_image_diagnostic', checkedAt: new Date().toISOString(), ...imageMeta,
        validImage: response.httpStatus === 200 && !invalidImage,
        width: dimensions?.width || null, height: dimensions?.height || null, bytes: imageBytes.length }));
    } catch (error) { console.log(JSON.stringify({ status: 'product_image_inconclusive', url, error: errorCode(error) })); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await diagnose();
