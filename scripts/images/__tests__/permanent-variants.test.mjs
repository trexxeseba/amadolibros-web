import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { IMAGE_VARIANTS, permanentImageUrl, variantObjectKey } from '../../../shared/image-variants.js';
import { handleImageVariants } from '../../../worker-sync/image-variants-api.js';
import { buildPermanentVariants, createVariant } from '../build-permanent-variants.mjs';
import { onRequest as publicCover } from '../../../functions/preview-cover/[[path]].js';
import worker from '../../../worker-sync/index.js';

class Bucket {
  constructor() { this.objects = new Map(); this.writes = []; }
  async get(key) {
    const object = this.objects.get(key); if (!object) return null;
    return { body: object.bytes.slice(), size: object.bytes.length, ...object.options,
      text: async () => Buffer.from(object.bytes).toString() };
  }
  async head(key) {
    const object = this.objects.get(key);
    return object ? { size: object.bytes.length, ...object.options } : null;
  }
  async put(key, body, options = {}) {
    if (options.onlyIf?.etagDoesNotMatch === '*' && this.objects.has(key)) return null;
    const bytes = typeof body === 'string' ? Buffer.from(body) : new Uint8Array(body);
    this.objects.set(key, { bytes, options }); this.writes.push(key); return { etag: key };
  }
  async list({ prefix, limit, cursor }) {
    const keys = [...this.objects.keys()].filter(k => k.startsWith(prefix)).sort();
    const offset = Number(cursor || 0); const selected = keys.slice(offset, offset + limit);
    return { objects: selected.map(key => ({ key, size: this.objects.get(key).bytes.length })),
      truncated: offset + limit < keys.length, cursor: String(offset + limit) };
  }
}

async function fixture(width = 1200, height = 1800) {
  const source = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#fee9d0"/><text x="20" y="60" font-size="32" fill="#172c44">Tapa: letras y proporciones</text><path d="M20 100L${width-20} ${height-20}" stroke="#c82060" stroke-width="5"/></svg>`);
  const bytes = await sharp(source).png().toBuffer();
  const hash = createHash('sha256').update(bytes).digest('hex');
  return { bytes, hash, file: `${hash}.png` };
}

test('encoder real conserva proporción y no amplía fuentes pequeñas en ninguna receta', async () => {
  for (const [width, height] of [[1200,1800], [1600,900], [140,210]]) {
    const { bytes } = await fixture(width, height);
    for (const recipe of IMAGE_VARIANTS) {
      const output = await createVariant(bytes, recipe, sharp);
      const metadata = await sharp(output).metadata();
      assert.equal(metadata.format, 'webp');
      assert.equal(metadata.width, Math.min(width, recipe.width));
      assert.ok(Math.abs(metadata.height - Math.round(height * metadata.width / width)) <= 1);
      assert.ok(output.length > 0);
    }
  }
});

test('pipeline publica una vez por hash/receta, sirve bytes exactos y no genera en visitas ni cambio de mes', async () => {
  const bucket = new Bucket(); const master = await fixture();
  await bucket.put(`covers/v1/objects/${master.file}`, master.bytes);
  const env = { COVER_R2: bucket, IMAGE_VARIANTS_WRITE_ENABLED: 'true', APP_ENV: 'preview', SYNC_SECRET: 'test-only' };
  const fetchFn = async (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer test-only');
    return handleImageVariants(new Request(url, options), env);
  };
  const first = await buildPermanentVariants({ baseUrl: 'https://test.example/trigger', token: 'test-only', sharp, fetchFn });
  assert.equal(first.created, IMAGE_VARIANTS.length); assert.deepEqual(first.failures, []);
  const keysBefore = bucket.writes.filter(k => k.endsWith('.webp'));
  const second = await buildPermanentVariants({ baseUrl: 'https://test.example/trigger', token: 'test-only', sharp, fetchFn });
  assert.equal(second.created, 0); assert.equal(second.sourcesDownloaded, 0);
  assert.equal(second.existing, IMAGE_VARIANTS.length);
  assert.deepEqual(bucket.writes.filter(k => k.endsWith('.webp')), keysBefore);
  for (const date of ['2026-10-31','2026-11-01']) {
    const request = new Request(`https://pr-400.amadolibros-web.pages.dev/preview-cover/MLU1/0/${master.file}?variant=v1-1024-q88&test-date=${date}`);
    const response = await publicCover({ request, params: { path: ['MLU1','0',master.file] }, env });
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.match(response.headers.get('cache-control'), /immutable/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(bucket.objects.get(variantObjectKey(master.hash,'v1-1024-q88')).bytes));
  }
  assert.deepEqual(bucket.writes.filter(k => k.endsWith('.webp')), keysBefore);
  const newMaster = await fixture(1600,900);
  await bucket.put(`covers/v1/objects/${newMaster.file}`, newMaster.bytes);
  const changed = await buildPermanentVariants({ baseUrl:'https://test.example/trigger', token:'test-only', sharp, fetchFn });
  assert.equal(changed.created, IMAGE_VARIANTS.length);
  assert.ok(bucket.objects.has(variantObjectKey(master.hash,'v1-1024-q88')), 'prior master remains intact');
});

test('variante ausente/inaccesible entrega el original, con caché breve y sin escritura', async () => {
  const bucket = new Bucket(); const master = await fixture(); await bucket.put(`covers/v1/objects/${master.file}`, master.bytes);
  const count = bucket.writes.length;
  const response = await publicCover({ request: new Request(`https://pr-400.amadolibros-web.pages.dev/preview-cover/MLU1/0/${master.file}?variant=v1-240-q85`),
    params: { path:['MLU1','0',master.file] }, env:{ COVER_R2:bucket, APP_ENV:'preview' } });
  assert.equal(response.status,200); assert.equal(response.headers.get('x-cover-variant'),'original-fallback');
  assert.equal(response.headers.get('content-type'),'image/png');
  assert.doesNotMatch(response.headers.get('cache-control'),/immutable/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), master.bytes);
  assert.equal(bucket.writes.length,count);
});

test('autenticación, recetas arbitrarias, masters corruptos y cambios de proporción se rechazan', async () => {
  const bucket = new Bucket(); const master = await fixture(); await bucket.put(`covers/v1/objects/${master.file}`,master.bytes);
  const env={ COVER_R2:bucket, IMAGE_VARIANTS_WRITE_ENABLED:'true', SYNC_SECRET:'test-only' };
  const unauthorized=await worker.fetch(new Request('https://test.example/image-variants/masters'),env,{});
  assert.equal(unauthorized.status,401);
  const invalid=await handleImageVariants(new Request(`https://test.example/image-variants/${master.hash}/v1-999999-q1`,{method:'PUT',body:'junk'}),env);
  assert.equal(invalid.status,400);
  const wrongShape=await sharp({create:{width:240,height:240,channels:3,background:'#fff'}}).webp().toBuffer();
  const upload=(bytes)=>new Request(`https://test.example/image-variants/${master.hash}/v1-240-q85`,{method:'PUT',headers:{'x-master-file':master.file},body:bytes});
  assert.equal((await handleImageVariants(upload(wrongShape),env)).status,400);
  bucket.objects.get(`covers/v1/objects/${master.file}`).bytes = Buffer.from('corrupted');
  assert.equal((await handleImageVariants(upload(wrongShape),env)).status,409);
  assert.equal(bucket.writes.filter(k=>k.endsWith('.webp')).length,0);
});

test('URLs de catálogo, miniaturas y zoom usan sólo recetas fijas; externos conservan su origen', () => {
  const source='https://www.amadolibros.com/book-cover/MLU1/cover.jpg';
  for(const recipe of IMAGE_VARIANTS) {
    const url=permanentImageUrl(source,recipe);
    assert.doesNotMatch(url,/cdn-cgi/);assert.equal(new URL(url).searchParams.get('variant'),recipe.id);
  }
  assert.equal(permanentImageUrl(source,{width:999999}),source);
  assert.equal(permanentImageUrl('https://other.example/cover.jpg',{width:240}),'https://other.example/cover.jpg');
});

test('Preview lee el master productivo y escribe únicamente derivados en su bucket separado', async () => {
  const source = new Bucket(), target = new Bucket(); const master = await fixture();
  await source.put(`covers/v1/objects/${master.file}`, master.bytes);
  await source.put('covers/v1/manifest.json', JSON.stringify({schema_version:1,entries:{'MLU1:0':{current:{object_key:`covers/v1/objects/${master.file}`}}}}));
  const before = source.writes.slice();
  const env={COVER_R2:target, IMAGE_VARIANTS_SOURCE_R2:source, IMAGE_VARIANTS_WRITE_ENABLED:'true'};
  const result=await buildPermanentVariants({baseUrl:'https://test.example',token:'test-only',sharp,productId:'MLU1',resume:false,
    fetchFn:(url,options)=>handleImageVariants(new Request(url,options),env)});
  assert.deepEqual(result.failures,[]);assert.equal(result.created,IMAGE_VARIANTS.length);
  assert.deepEqual(source.writes,before);
  assert.ok(target.writes.every(key=>key.startsWith('covers/variants/')));
});
