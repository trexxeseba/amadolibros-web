import { IMAGE_VARIANTS, imageVariant, variantObjectKey, variantVersion, VARIANT_VERSION } from '../shared/image-variants.js';
import { inspectCoverBytes } from './cover-mirror.js';
import { streamCoverManifest } from '../functions/_shared/cover-manifest-stream.js';
import { prepareCoverIndex, COVER_INDEX_METADATA } from '../functions/_shared/cover-public-index.js';

const MASTER_RE = /^([a-f0-9]{64})\.(jpg|png|webp)$/;
const PROGRESS_KEY = `covers/variants/${VARIANT_VERSION}/progress.json`;
const MAX_BYTES = 8 * 1024 * 1024;
const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

async function boundedBytes(request) {
  if (Number(request.headers.get('content-length')) > MAX_BYTES) throw new Error('body-too-large');
  const chunks = []; let size = 0;
  const reader = request.body?.getReader();
  if (!reader) throw new Error('empty-body');
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('body-too-large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export function webpDimensions(bytes) {
  if (bytes.length < 30 || String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF' ||
      String.fromCharCode(...bytes.slice(8, 12)) !== 'WEBP') throw new Error('invalid-webp');
  const u24 = offset => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
  const type = String.fromCharCode(...bytes.slice(12, 16));
  if (type === 'VP8X') return { width: u24(24) + 1, height: u24(27) + 1 };
  if (type === 'VP8L' && bytes[20] === 47) return {
    width: 1 + (bytes[21] | ((bytes[22] & 63) << 8)),
    height: 1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 15) << 10)),
  };
  if (type === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) return {
    width: (bytes[26] | bytes[27] << 8) & 16383,
    height: (bytes[28] | bytes[29] << 8) & 16383,
  };
  throw new Error('invalid-webp');
}

// Invocado sólo DESPUÉS de la autenticación SYNC_SECRET del Worker.
// No usa el binding IMAGES: el encoder se ejecuta en el job de Node.
export async function handleImageVariants(request, env) {
  if (env.IMAGE_VARIANTS_WRITE_ENABLED !== 'true' || !env.COVER_R2) return json({ error: 'disabled' }, 404);
  const url = new URL(request.url); const bucket = env.COVER_R2;
  // Preview puede leer masters productivos mediante un binding separado.
  // Todos los PUT siguen dirigidos exclusivamente a COVER_R2 (Preview).
  const masters = env.IMAGE_VARIANTS_SOURCE_R2 || bucket;
  const path = url.pathname.slice('/image-variants'.length).split('/').filter(Boolean);
  try {
    if (path[0] === 'seed' && path.length === 1 && request.method === 'POST') {
      // Sólo el Worker de Preview tiene un origen separado. El Worker
      // productivo no puede activar esta operación mediante parámetros HTTP.
      if (!env.IMAGE_VARIANTS_SOURCE_R2 || masters === bucket) return json({ error: 'preview-only' }, 404);
      const { productIds } = JSON.parse(new TextDecoder().decode(await boundedBytes(request)));
      if (!Array.isArray(productIds) || !productIds.length || productIds.length > 8 || productIds.some(id => !/^MLU\d+$/.test(id))) return json({ error: 'invalid-products' }, 400);
      const sourceObject = await masters.get('covers/v1/manifest.json');
      if (!sourceObject) return json({ error: 'manifest-unavailable' }, 404);
      const selected = await streamCoverManifest(sourceObject, { productIds });
      const entries = Object.fromEntries(Object.entries(selected.entries).filter(([,entry]) =>
        /^covers\/v1\/objects\/[a-f0-9]{64}\.(jpg|png|webp)$/.test(entry.current?.object_key || '')));
      for (const entry of Object.values(entries)) {
        const key = entry.current.object_key;
        if (await bucket.head(key)) continue;
        const object = await masters.get(key);
        if (!object?.body || object.size > MAX_BYTES) return json({ error: 'master-unavailable' }, 404);
        const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
        if (hash !== entry.current.sha256) return json({ error:'master-hash-mismatch' },409);
        await bucket.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:entry.current.mime,cacheControl:'public, max-age=31536000, immutable'}});
      }
      // Semilla pequeña, CAS y unión: conserva muestras de otros trabajos.
      for (let attempt=0;attempt<3;attempt++) {
        const previous=await bucket.get('covers/v1/manifest.json');
        if (previous?.size>MAX_BYTES) return json({error:'preview-manifest-too-large'},409);
        const old=previous?JSON.parse(await previous.text()):{schema_version:1,entries:{}};
        if(old.schema_version!==1 || !old.entries) return json({error:'invalid-preview-manifest'},409);
        const next={...old,updated_at:new Date().toISOString(),entries:{...old.entries,...entries}};
        const index=await prepareCoverIndex(bucket,next,null);
        const stored=await bucket.put('covers/v1/manifest.json',JSON.stringify(next),{
          onlyIf:previous?{etagMatches:previous.etag}:{etagDoesNotMatch:'*'},
          httpMetadata:{contentType:'application/json',cacheControl:'no-store'},
          customMetadata:{...(previous?.customMetadata||{}),[COVER_INDEX_METADATA]:index.hash},
        });
        if(stored!==null)return json({seeded:Object.keys(entries).length,productIds});
      }
      return json({error:'preview-seed-conflict'},409);
    }
    if (path[0] === 'progress' && path.length === 1) {
      if (request.method === 'GET') {
        const object = await bucket.get(PROGRESS_KEY);
        return json(object ? JSON.parse(await object.text()) : { cursor: null, version: VARIANT_VERSION });
      }
      if (request.method === 'PUT') {
        const body = JSON.parse(new TextDecoder().decode(await boundedBytes(request)));
        if (body.cursor !== null && (typeof body.cursor !== 'string' || body.cursor.length > 2048)) return json({ error: 'invalid-cursor' }, 400);
        const progress = { cursor: body.cursor, version: VARIANT_VERSION, updated_at: new Date().toISOString() };
        await bucket.put(PROGRESS_KEY, JSON.stringify(progress), { httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } });
        return json(progress);
      }
    }
    if (path[0] === 'masters' && path.length === 1 && request.method === 'GET') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      const productId = url.searchParams.get('product_id');
      if (productId) {
        if (!/^MLU\d+$/.test(productId)) return json({ error: 'invalid-product' }, 400);
        const object = await masters.get('covers/v1/manifest.json');
        if (!object) return json({ error: 'manifest-unavailable' }, 404);
        const manifest = await streamCoverManifest(object, { productIds: [productId] });
        const files = [...new Set(Object.values(manifest.entries).map(entry => entry.current?.object_key)
          .filter(key => typeof key === 'string' && key.startsWith('covers/v1/objects/') && MASTER_RE.test(key.slice('covers/v1/objects/'.length))))].slice(0, limit);
        const objects = await Promise.all(files.map(async key => ({ file: key.slice('covers/v1/objects/'.length), size: (await masters.head(key))?.size || 0 })));
        return json({ objects, cursor: null, recipes: IMAGE_VARIANTS });
      }
      const cursor = url.searchParams.get('cursor') || undefined;
      if (cursor && cursor.length > 2048) return json({ error: 'invalid-cursor' }, 400);
      const listing = await masters.list({ prefix: 'covers/v1/objects/', limit, cursor });
      return json({ objects: listing.objects.filter(object => MASTER_RE.test(object.key.slice('covers/v1/objects/'.length)))
        .map(object => ({ file: object.key.slice('covers/v1/objects/'.length), size: object.size })),
        cursor: listing.truncated ? listing.cursor : null, recipes: IMAGE_VARIANTS });
    }
    if (path[0] === 'master' && path.length === 2 && MASTER_RE.test(path[1]) && request.method === 'GET') {
      const object = await masters.get(`covers/v1/objects/${path[1]}`);
      if (!object?.body || object.size > MAX_BYTES) return json({ error: 'master-unavailable' }, 404);
      return new Response(object.body, { headers: { 'cache-control': 'no-store', 'content-type': 'application/octet-stream' } });
    }
    if (path.length !== 2 || !/^[a-f0-9]{64}$/.test(path[0]) || !imageVariant(path[1])) return json({ error: 'invalid-path' }, 400);
    // Esta vía escribe sólo v1 (Sharp). v2 (Cloudflare Images) únicamente lo
    // escribe el generador con cupo persistente; nunca un PUT genérico.
    if (variantVersion(path[1]) !== VARIANT_VERSION) return json({ error: 'recipe-version-not-writable' }, 400);
    const [hash, id] = path; const key = variantObjectKey(hash, id);
    const existing = await bucket.head(key);
    const validExisting = existing?.customMetadata?.master_sha256 === hash && existing.customMetadata.recipe === id && /^[a-f0-9]{64}$/.test(existing.customMetadata.sha256 || '');
    if (request.method === 'HEAD') return new Response(null, { status: validExisting ? 200 : 404, headers: { 'cache-control': 'no-store' } });
    if (request.method !== 'PUT') return json({ error: 'method-not-allowed' }, 405);
    if (validExisting) return json({ status: 'existing' });
    if (existing) return json({ error: 'invalid-existing-object' }, 409);
    const masterFile = request.headers.get('x-master-file') || '';
    if (MASTER_RE.exec(masterFile)?.[1] !== hash) return json({ error: 'invalid-master' }, 400);
    const master = await masters.get(`covers/v1/objects/${masterFile}`);
    if (!master?.body || master.size > MAX_BYTES) return json({ error: 'master-unavailable' }, 404);
    const original = new Uint8Array(await new Response(master.body).arrayBuffer());
    const sourceHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', original))].map(v => v.toString(16).padStart(2, '0')).join('');
    if (sourceHash !== hash) return json({ error: 'master-hash-mismatch' }, 409);
    const source = inspectCoverBytes(original, `image/${masterFile.endsWith('.jpg') ? 'jpeg' : masterFile.split('.').at(-1)}`);
    const bytes = await boundedBytes(request); const dimensions = webpDimensions(bytes);
    const recipe = imageVariant(id);
    const expectedWidth = Math.min(source.width, recipe.width);
    const expectedHeight = Math.max(1, Math.round(source.height * expectedWidth / source.width));
    if (dimensions.width !== expectedWidth || Math.abs(dimensions.height - expectedHeight) > 1) return json({ error: 'dimensions-or-aspect-ratio-mismatch' }, 400);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
    const result = await bucket.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' },
      customMetadata: { master_sha256: hash, recipe: id, sha256: digest,
        width: String(dimensions.width), height: String(dimensions.height) },
    });
    return json({ status: result === null ? 'concurrent-existing' : 'created', sha256: digest });
  } catch {
    return json({ error: 'variant-operation-failed' }, 500);
  }
}
