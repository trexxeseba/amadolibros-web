import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { onRequest as cover } from '../preview-cover/[[path]].js';
import { handleImageVariants } from '../../worker-sync/image-variants-api.js';
import {
  readyCardVariantSelection, readyCardVariantSource, PRODUCTION_IMAGE_BUCKET, CARD_RECIPES,
  READINESS_V2_SCHEMA, MAX_CARD_READINESS_V2_ENTRIES, recipesForSelection,
} from '../_shared/card-variant-delivery.js';
import {
  IMAGE_VARIANTS, CF_CARD_VARIANTS, imageVariant, variantObjectKey, readImageVariant, permanentImageUrl,
} from '../../shared/image-variants.js';
import { responsiveImage } from '../_shared/cloudflare-images.js';
import { buildMixedCardReadiness } from '../../scripts/images/build-mixed-card-readiness.mjs';

const hash = 'a'.repeat(64), sum = 'b'.repeat(64), source = 'https://http2.mlstatic.com/D_TEST-O.jpg';
const coverUrl = `https://www.amadolibros.com/preview-cover/MLU1/0/${hash}.jpg`;
const sha = text => createHash('sha256').update(text).digest('hex');

function indexFixture(masterCode = '121', overrides = {}) {
  const index = { schema: READINESS_V2_SCHEMA, bucket: PRODUCTION_IMAGE_BUCKET, widths: [240, 360, 480],
    cards: { MLU1: { sha256: hash, extension: 'jpg', source_url: source } }, masters: { [hash]: masterCode }, ...overrides };
  const text = JSON.stringify(index), digest = sha(text);
  let gets = 0;
  const bucket = { async get(key) { gets++; assert.equal(key, `covers/card-readiness/v1/${digest}.json`);
    return { size: Buffer.byteLength(text), text: async () => text }; } };
  const ctx = { request: new Request('https://www.amadolibros.com/catalogo?_card_variants=1'), data: {},
    env: { APP_ENV: 'production', IMAGE_VARIANTS_READ_ENABLED: 'true', CARD_VARIANTS_CANARY_IDS: 'MLU1',
      CARD_VARIANTS_INDEX_SHA256: digest, COVER_R2: bucket, COVER_R2_BUCKET_NAME: PRODUCTION_IMAGE_BUCKET } };
  return { ctx, item: { id: 'MLU1', status: 'active', available_quantity: 1, pictures: [source] }, get gets() { return gets; } };
}

test('v1 and v2 recipes are distinct, versioned and keyed apart', () => {
  assert.equal(IMAGE_VARIANTS.length, 12);
  assert.ok(IMAGE_VARIANTS.every(r => r.id.startsWith('v1-')));
  assert.deepEqual(CF_CARD_VARIANTS.map(r => r.id), ['v2-240-q85', 'v2-360-q85', 'v2-480-q85']);
  assert.equal(variantObjectKey(hash, 'v1-240-q85'), `covers/variants/v1/${hash}/v1-240-q85.webp`);
  assert.equal(variantObjectKey(hash, 'v2-240-q85'), `covers/variants/v2/${hash}/v2-240-q85.webp`);
  assert.equal(variantObjectKey(hash, 'v3-240-q85'), null);
  assert.equal(imageVariant('v2-1024-q85'), null);
});

function r2With(key, customMetadata, contentType = 'image/webp') {
  return { async get(requested) { return requested === key
    ? { body: new Uint8Array([1]), size: 1, httpMetadata: { contentType }, customMetadata } : null; } };
}
test('v2 bytes require the Cloudflare encoder stamp and never validate as v1', async () => {
  const v2key = variantObjectKey(hash, 'v2-240-q85');
  const meta = { master_sha256: hash, recipe: 'v2-240-q85', sha256: sum };
  assert.equal(await readImageVariant(r2With(v2key, meta), hash, 'v2-240-q85'), null);
  assert.equal(await readImageVariant(r2With(v2key, { ...meta, encoder: 'sharp' }), hash, 'v2-240-q85'), null);
  assert.ok(await readImageVariant(r2With(v2key, { ...meta, encoder: 'cloudflare-images' }), hash, 'v2-240-q85'));
  const v1key = variantObjectKey(hash, 'v1-240-q85');
  const v1meta = { master_sha256: hash, recipe: 'v1-240-q85', sha256: sum };
  assert.ok(await readImageVariant(r2With(v1key, v1meta), hash, 'v1-240-q85'), 'existing v1 objects have no encoder metadata');
  assert.ok(await readImageVariant(r2With(v1key, { ...v1meta, encoder: 'sharp' }), hash, 'v1-240-q85'));
  assert.equal(await readImageVariant(r2With(v1key, { ...v1meta, encoder: 'cloudflare-images' }), hash, 'v1-240-q85'), null);
  // A v2 object copied under the v1 key can only be addressed with the v1 recipe id and is rejected above.
  assert.equal(await readImageVariant(r2With(v1key, { ...v1meta, recipe: 'v2-240-q85' }), hash, 'v1-240-q85'), null);
});

test('permanentImageUrl: default unchanged, explicit mixed recipes honoured, anything else falls back to original', () => {
  const base = `https://www.amadolibros.com/preview-cover/MLU1/0/${hash}.jpg`;
  assert.equal(permanentImageUrl(base, { width: 360 }), `${base}?variant=v1-360-q85`);
  const recipes = { 240: 'v1-240-q85', 360: 'v2-360-q85', 480: 'v1-480-q85' };
  assert.equal(permanentImageUrl(base, { width: 360, recipes }), `${base}?variant=v2-360-q85`);
  assert.equal(permanentImageUrl(base, { width: 240, recipes }), `${base}?variant=v1-240-q85`);
  for (const bad of [{ 360: 'v2-240-q85' }, { 360: 'v9-360-q85' }, { 240: 'v2-240-q85' }, {}]) {
    assert.equal(permanentImageUrl(base, { width: 360, recipes: bad }), base);
  }
  const image = responsiveImage(base, { widths: [240, 360, 480], defaultWidth: 360, permanent: true, recipes });
  assert.match(image.srcset, /variant=v1-240-q85 240w, .*variant=v2-360-q85 360w, .*variant=v1-480-q85 480w/);
  assert.match(image.src, /variant=v2-360-q85$/);
});

test('v2 index selects recipe by master and width; one GET, no HEAD', async () => {
  const f = indexFixture('121');
  const selection = await readyCardVariantSelection(f.ctx, f.item, coverUrl);
  assert.deepEqual(selection.recipes, { 240: 'v1-240-q85', 360: 'v2-360-q85', 480: 'v1-480-q85' });
  assert.equal(selection.url, coverUrl);
  assert.equal(await readyCardVariantSource(f.ctx, f.item, coverUrl), coverUrl);
  assert.equal(f.gets, 1);
});

test('v2 index fails closed on incomplete or malformed selection and structure', async () => {
  for (const code of ['102', '000', '12', '1234', '3 1', '131']) {
    const f = indexFixture(code);
    assert.equal(await readyCardVariantSelection(f.ctx, f.item, coverUrl), null, code);
  }
  const absent = indexFixture('121', { masters: {} });
  assert.equal(await readyCardVariantSelection(absent.ctx, absent.item, coverUrl), null, 'master missing from selection map');
  for (const overrides of [{ widths: [240, 360] }, { bucket: 'other' }, { schema: 'verified-card-readiness-v3' },
    { masters: [] }, { masters: null }]) {
    const f = indexFixture('121', overrides);
    assert.equal(await readyCardVariantSelection(f.ctx, f.item, coverUrl), null, JSON.stringify(overrides));
  }
  assert.equal(recipesForSelection('111').constructor, Object);
  assert.equal(recipesForSelection('110'), null);
});

test('v2 index enforces its own entry budget; hash drift and source drift still fail closed', async () => {
  const many = Object.fromEntries(Array.from({ length: MAX_CARD_READINESS_V2_ENTRIES + 1 }, (_, i) => [`MLU${i + 2}`,
    { sha256: hash, extension: 'jpg', source_url: source }]));
  const f = indexFixture('121', { cards: { MLU1: { sha256: hash, extension: 'jpg', source_url: source }, ...many } });
  assert.equal(await readyCardVariantSelection(f.ctx, f.item, coverUrl), null);
  const g = indexFixture('121');
  assert.equal(await readyCardVariantSelection(g.ctx, g.item, `https://www.amadolibros.com/preview-cover/MLU1/0/${'c'.repeat(64)}.jpg`), null);
  g.item.pictures = ['https://http2.mlstatic.com/changed-O.jpg'];
  assert.equal(await readyCardVariantSelection(g.ctx, g.item, coverUrl), null);
});

test('legacy v1 index keeps selecting v1 recipes for all three widths', async () => {
  const index = { schema: 'verified-card-readiness-v1', bucket: PRODUCTION_IMAGE_BUCKET, recipes: CARD_RECIPES,
    cards: { MLU1: { sha256: hash, extension: 'jpg', source_url: source } } };
  const text = JSON.stringify(index), digest = sha(text);
  const f = indexFixture();
  f.ctx.env.CARD_VARIANTS_INDEX_SHA256 = digest;
  f.ctx.env.COVER_R2 = { async get() { return { size: Buffer.byteLength(text), text: async () => text }; } };
  const selection = await readyCardVariantSelection(f.ctx, f.item, coverUrl);
  assert.deepEqual(selection.recipes, { 240: 'v1-240-q85', 360: 'v1-360-q85', 480: 'v1-480-q85' });
});

// ---- Publication-time builder -------------------------------------------------
function build({ prefer, mutate } = {}) {
  const masters = { [hash]: { extension: 'jpg', width: 800, height: 1200 }, ['d'.repeat(64)]: { extension: 'png', width: 300, height: 450 } };
  const cards = { MLU1: { sha256: hash, extension: 'jpg', source_url: source }, MLU2: { sha256: hash, extension: 'jpg', source_url: source },
    MLU3: { sha256: 'd'.repeat(64), extension: 'png', source_url: 'https://http2.mlstatic.com/D_OTHER-O.jpg' } };
  const evidence = {};
  const add = (master, version, width, encoder, height) => { const id = `${version}-${width}-q85`; evidence[`${master}/${id}`] = {
    recipe: id, master_sha256: master, format: 'webp', bytes: 100, sha256: sum, width: Math.min(master === hash ? 800 : 300, width),
    height, encoder }; };
  add(hash, 'v1', 240, undefined, 360); add(hash, 'v1', 360, 'sharp', 540);
  add(hash, 'v2', 360, 'cloudflare-images', 540); add(hash, 'v2', 480, 'cloudflare-images', 720);
  add('d'.repeat(64), 'v1', 240, 'sharp', 360); // 300px master: 240 ok; 360/480 missing
  const input = { cards, masters, evidence, prefer }; mutate?.(input);
  return buildMixedCardReadiness(input);
}

test('builder mixes versions per width, reuses v1 first, and shares one master across aliases', () => {
  const out = build();
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.masters[hash], '112');
  assert.deepEqual(Object.keys(parsed.cards), ['MLU1', 'MLU2'], 'incomplete-coverage card is not published');
  assert.equal(out.excludedCards, 1);
  assert.equal(out.masters, 1);
  assert.equal(JSON.parse(build({ prefer: ['v2', 'v1'] }).text).masters[hash], '122', 'v2 preferred where it exists, v1 where it is the only one');
  assert.equal(out.digest, sha(out.text));
  assert.equal(build().digest, out.digest, 'deterministic');
});

test('builder rejects invalid evidence instead of publishing it', () => {
  const key = `${hash}/v2-360-q85`;
  const cases = {
    'wrong encoder': i => { i.evidence[key].encoder = 'sharp'; },
    'v1 stamped as cloudflare': i => { i.evidence[`${hash}/v1-360-q85`].encoder = 'cloudflare-images'; },
    'wrong master': i => { i.evidence[key].master_sha256 = 'e'.repeat(64); },
    'wrong recipe': i => { i.evidence[key].recipe = 'v2-240-q85'; },
    'wrong width': i => { i.evidence[key].width = 361; },
    'enlarged small master': i => { i.evidence[`${'d'.repeat(64)}/v1-240-q85`].width = 360; },
    'distorted aspect': i => { i.evidence[key].height = 600; },
    'bad object hash': i => { i.evidence[key].sha256 = 'zz'; },
    'zero bytes': i => { i.evidence[key].bytes = 0; },
    'not webp': i => { i.evidence[key].format = 'jpeg'; },
    'unknown master': i => { delete i.masters[hash]; },
    'extension mismatch': i => { i.cards.MLU1.extension = 'png'; },
    'untrusted source': i => { i.cards.MLU1.source_url = 'https://evil.example/a.jpg'; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const prefer = name.startsWith('v1') || name === 'enlarged small master' ? undefined : ['v2', 'v1'];
    assert.throws(() => build({ prefer, mutate }), /readiness-/, name);
  }
});

test('catalog-scale index stays within byte budget and parses fast', async () => {
  const cards = {}, masters = {};
  for (let i = 0; i < 6985; i++) {
    const h = sha('m' + i); masters[h] = '112';
    cards['MLU' + (600000000 + i)] = { sha256: h, extension: 'jpg', source_url: `https://http2.mlstatic.com/D_NQ_NP_${100000 + i}-MLU${700000000 + i}_102026-O.jpg` };
  }
  const text = JSON.stringify({ schema: READINESS_V2_SCHEMA, bucket: PRODUCTION_IMAGE_BUCKET, widths: [240, 360, 480], cards, masters });
  assert.ok(Buffer.byteLength(text) < 4_000_000, `size ${Buffer.byteLength(text)}`);
  const start = performance.now();
  const bytes = new TextEncoder().encode(text);
  await crypto.subtle.digest('SHA-256', bytes);
  JSON.parse(text);
  const ms = performance.now() - start;
  assert.ok(ms < 250, `digest+parse ${ms}ms`);
  console.log(JSON.stringify({ scale_cards: 6985, bytes: Buffer.byteLength(text), digest_parse_ms: Math.round(ms) }));
});

// ---- Serving and write paths ----------------------------------------------------
test('serving: existing v2 object is served under its own v2 URL; missing v2 falls back to the original', async () => {
  const entries = new Map();
  globalThis.caches = { default: { async match(k) { return entries.get(k.url)?.clone(); }, async put(k, v) { entries.set(k.url, v.clone()); } } };
  try {
    const v2key = variantObjectKey(hash, 'v2-360-q85');
    const body = new Uint8Array([82, 73, 70, 70]);
    const env = { APP_ENV: 'production', COVER_R2_BUCKET_NAME: PRODUCTION_IMAGE_BUCKET, IMAGE_VARIANTS_READ_ENABLED: 'false',
      COVER_R2: { async get(key) { return key === v2key ? { body, size: 4, httpMetadata: { contentType: 'image/webp' },
        customMetadata: { master_sha256: hash, recipe: 'v2-360-q85', sha256: sum, encoder: 'cloudflare-images' } } : null; } } };
    const ctx = variant => ({ env, params: { path: ['MLU1', '0', `${hash}.jpg`] },
      request: new Request(`https://www.amadolibros.com/preview-cover/MLU1/0/${hash}.jpg?variant=${variant}`) });
    const hit = await cover(ctx('v2-360-q85'));
    assert.equal(hit.status, 200); assert.equal(hit.headers.get('x-cover-variant'), 'v2-360-q85');
    const missing = await cover(ctx('v2-240-q85'));
    assert.equal(missing.status, 302);
    assert.doesNotMatch(missing.headers.get('location'), /variant=|cdn-cgi/);
    assert.equal(missing.headers.get('x-cover-variant'), 'original-fallback');
  } finally { delete globalThis.caches; }
});

test('generic image-variants API cannot HEAD or PUT v2 recipes', async () => {
  const env = { IMAGE_VARIANTS_WRITE_ENABLED: 'true', COVER_R2: { head() { throw new Error('must not touch R2'); }, put() { throw new Error('must not write'); } } };
  for (const method of ['HEAD', 'PUT']) {
    const response = await handleImageVariants(new Request(`https://worker.example/image-variants/${hash}/v2-240-q85`, { method, body: method === 'PUT' ? new Uint8Array([1]) : undefined }), env);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'recipe-version-not-writable');
  }
});
