import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { IMAGE_VARIANTS } from '../../shared/image-variants.js';

const MAX_BYTES = 8 * 1024 * 1024;
export async function createVariant(bytes, recipe, sharp) {
  const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' });
  const metadata = await image.metadata();
  // Una fuente con rotación EXIF necesita una receta explícita; mientras
  // tanto conserva el original en la web en vez de alterar la orientación.
  if (metadata.orientation && metadata.orientation !== 1) throw new Error('orientation-requires-review');
  if (!metadata.width || !metadata.height || (metadata.pages || 1) > 1) throw new Error('unsupported-source');
  return image.resize({ width: recipe.width, withoutEnlargement: true })
    .webp({ quality: recipe.quality, effort: 4 }).toBuffer();
}

async function readBounded(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('source-too-large');
  const reader = response.body.getReader(); const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.length;
      if (total > MAX_BYTES) { await reader.cancel(); throw new Error('source-too-large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export async function buildPermanentVariants({ baseUrl, token, limit = 100,
  fetchFn = fetch, sharp, resume = true, productId = null } = {}) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || !token) throw new Error('invalid-builder-config');
  base.pathname = '/image-variants/'; base.search = ''; base.hash = '';
  const boundedLimit = Math.min(500, Math.max(1, Number(limit) || 100));
  async function call(path, options = {}, allowed = [200]) {
    const response = await fetchFn(new URL(path, base), { ...options, redirect: 'manual',
      signal: AbortSignal.timeout(60_000), headers: { authorization: `Bearer ${token}`, ...options.headers } });
    if (!allowed.includes(response.status)) {
      const body = await response.json().catch(() => ({}));
      const code = /^[a-z-]{1,80}$/.test(body.error || '') ? `-${body.error}` : '';
      throw new Error(`image-api-http-${response.status}${code}`);
    }
    return response;
  }
  const progress = resume ? await (await call('progress')).json() : { cursor: null };
  const query = new URLSearchParams({ limit: String(boundedLimit) });
  if (progress.cursor) query.set('cursor', progress.cursor);
  if (productId) query.set('product_id', productId);
  const listing = await (await call(`masters?${query}`)).json();
  const result = { examined: listing.objects.length, sourcesDownloaded: 0, created: 0, existing: 0, failures: [], nextCursor: listing.cursor };
  async function processMaster(master) {
    const hash = master.file.split('.')[0]; let bytes = null;
    try {
      for (const recipe of IMAGE_VARIANTS) {
        const path = `${hash}/${recipe.id}`;
        const head = await call(path, { method: 'HEAD' }, [200, 404]);
        if (head.status === 200) { result.existing++; continue; }
        if (!bytes) {
          if (master.size > MAX_BYTES) throw new Error('source-too-large');
          bytes = await readBounded(await call(`master/${master.file}`));
          if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('master-hash-mismatch');
          result.sourcesDownloaded++;
        }
        const variant = await createVariant(bytes, recipe, sharp);
        const upload = await call(path, { method: 'PUT', headers: { 'content-type': 'image/webp', 'x-master-file': master.file }, body: variant });
        const stored = await upload.json();
        if (stored.status === 'created') result.created++; else result.existing++;
      }
    } catch (error) {
      result.failures.push({ hash, reason: String(error.message).replace(/https?:\/\/\S+/g, '[redacted]').slice(0, 120) });
    }
  }
  let nextMaster = 0;
  await Promise.all(Array.from({ length: Math.min(4, listing.objects.length) }, async () => {
    while (nextMaster < listing.objects.length) await processMaster(listing.objects[nextMaster++]);
  }));
  // No avanzar el lote si falla una fuente: el próximo intento reutiliza los
  // objetos completados. Una fuente inválida persistente requiere revisión.
  if (resume && result.failures.length === 0) await call('progress', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cursor: listing.cursor }) });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: sharp } = await import('sharp');
  const result = await buildPermanentVariants({
    baseUrl: process.env.WORKER_SYNC_TRIGGER_URL, token: process.env.SYNC_SECRET,
    limit: process.env.IMAGE_VARIANT_MASTER_LIMIT, sharp,
    productId: process.env.IMAGE_VARIANT_SAMPLE_PRODUCT_ID || null,
    resume: !process.env.IMAGE_VARIANT_SAMPLE_PRODUCT_ID,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.failures.length) process.exitCode = 1;
}
