import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { IMAGE_VARIANTS } from '../../shared/image-variants.js';

const MAX_BYTES = 8 * 1024 * 1024;
export const CARD_RECIPES = Object.freeze(['v1-240-q85', 'v1-360-q85', 'v1-480-q85']);
export function validateCardPlan(plan, expectedMasters = 2788) {
  if (plan?.schema !== 'active-card-variants-v1' || plan.bucket !== 'amadolibros-images-production' ||
      plan.baseline !== '29c5dce82ce807fdcd58d3c49c21fc64dc2b5cea' ||
      JSON.stringify(plan.recipes) !== JSON.stringify(CARD_RECIPES) ||
      !Array.isArray(plan.masters) || plan.masters.length !== expectedMasters) throw new Error('invalid-card-plan');
  const hashes = new Set();
  for (const master of plan.masters) {
    const match = /^([a-f0-9]{64})\.(jpg|png|webp)$/.exec(master.file || '');
    if (!match || hashes.has(match[1]) || !Number.isSafeInteger(master.size) || master.size <= 0 || master.size > MAX_BYTES)
      throw new Error('invalid-card-master');
    hashes.add(match[1]);
  }
  const digest = createHash('sha256').update(JSON.stringify(plan.masters)).digest('hex');
  if (digest !== plan.masters_sha256) throw new Error('card-plan-digest-mismatch');
  return plan.masters;
}
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
  fetchFn = fetch, sharp, resume = true, productId = null, cardPlan = null,
  cardStart = 0, cardCount = 2788, stopOnFailure = false } = {}) {
  // Validate before any remote request. A scoped run never reads the global
  // master listing or its cursor, and cannot expand into galleries/history.
  const plannedMasters = cardPlan ? validateCardPlan(cardPlan) : null;
  if (plannedMasters && (!Number.isSafeInteger(cardStart) || !Number.isSafeInteger(cardCount) ||
      cardStart < 0 || cardCount < 1 || cardStart + cardCount > plannedMasters.length)) throw new Error('invalid-card-range');
  if (plannedMasters && productId) throw new Error('conflicting-master-selection');
  const recipes = plannedMasters ? CARD_RECIPES.map(id => IMAGE_VARIANTS.find(r => r.id === id)) : IMAGE_VARIANTS;
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
  const progress = !plannedMasters && resume ? await (await call('progress')).json() : { cursor: null };
  const query = new URLSearchParams({ limit: String(boundedLimit) });
  if (progress.cursor) query.set('cursor', progress.cursor);
  if (productId) query.set('product_id', productId);
  const listing = plannedMasters ? { objects: plannedMasters.slice(cardStart, cardStart + cardCount), cursor: null } : await (await call(`masters?${query}`)).json();
  const result = { examined: listing.objects.length, sourcesDownloaded: 0, created: 0, existing: 0, failures: [], nextCursor: listing.cursor };
  async function processMaster(master) {
    const hash = master.file.split('.')[0]; let bytes = null;
    try {
      for (const recipe of recipes) {
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
    while (nextMaster < listing.objects.length && !(stopOnFailure && result.failures.length)) await processMaster(listing.objects[nextMaster++]);
  }));
  // No avanzar el lote si falla una fuente: el próximo intento reutiliza los
  // objetos completados. Una fuente inválida persistente requiere revisión.
  if (!plannedMasters && resume && result.failures.length === 0) await call('progress', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cursor: listing.cursor }) });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: sharp } = await import('sharp');
  const cardPlan = process.env.IMAGE_VARIANT_CARD_PLAN
    ? JSON.parse(await readFile(process.env.IMAGE_VARIANT_CARD_PLAN, 'utf8')) : null;
  if (!cardPlan && !process.env.IMAGE_VARIANT_SAMPLE_PRODUCT_ID)
    throw new Error('approved-card-plan-required');
  if (cardPlan && process.env.IMAGE_VARIANT_WRITE_APPROVAL !== cardPlan.masters_sha256)
    throw new Error('explicit-card-plan-write-approval-required');
  const result = await buildPermanentVariants({
    baseUrl: process.env.WORKER_SYNC_TRIGGER_URL, token: process.env.SYNC_SECRET,
    limit: process.env.IMAGE_VARIANT_MASTER_LIMIT, sharp,
    productId: process.env.IMAGE_VARIANT_SAMPLE_PRODUCT_ID || null,
    resume: !process.env.IMAGE_VARIANT_SAMPLE_PRODUCT_ID,
    cardPlan,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.failures.length) process.exitCode = 1;
}
