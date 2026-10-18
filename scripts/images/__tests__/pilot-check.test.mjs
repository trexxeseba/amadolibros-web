import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import worker, { PREVIEW_BUCKET, SOURCE_BUCKET } from '../../../worker-sync/card-generation-preview.js';
import { USAGE_SOURCE, periodOf } from '../../../worker-sync/card-generation.js';
import { bucket, fakeImages, png, sha } from '../../../worker-sync/__tests__/pilot-fakes.mjs';
import { selectPilotMasters } from '../select-pilot-masters.mjs';
import { runPilotCheck } from '../card-generation-pilot-check.mjs';
import { compareRecipe, contactSheet, psnr, ssim, REVIEW_THRESHOLDS } from '../compare-sharp-pilot.mjs';
import { pilotClient } from '../pilot-client.mjs';

// ---- Verifier against the real Preview Worker handler (simulated R2 / Images) -------------
function manifestFor(masters) {
  const entries = {};
  masters.forEach(({ width, height, ext = 'png', bytes }, i) => {
    const hash = sha(bytes); entries[`MLU${i + 1}:0`] = { current: { object_key: `covers/v1/objects/${hash}.${ext}`, sha256: hash, bytes: bytes.length, width, height } };
  });
  return { updated_at: '2026-10-17T03:10:32.644Z', entries };
}
function environment() {
  const preview = bucket(), production = bucket(), images = fakeImages();
  const specs = [[800, 1200], [800, 1200], [700, 1000], [640, 900], [900, 600], [500, 900], [1800, 2600], [300, 450], [200, 300], [420, 600], [810, 1210]]
    .map(([width, height], i) => ({ width, height, bytes: png(width, height, i + 1) }));
  production.store.set('covers/v1/manifest.json', { bytes: new Uint8Array([1, 2, 3]), etag: 'manifest-etag' });
  for (const spec of specs) production.store.set(`covers/v1/objects/${sha(spec.bytes)}.png`, { bytes: spec.bytes, etag: 'm' });
  const selection = selectPilotMasters({ manifest: manifestFor(specs), v1Inventory: new Set() });
  const env = { PILOT_TOKEN: 'tok', PILOT_MODE: 'preview-card-generation', PREVIEW_BUCKET_NAME: PREVIEW_BUCKET, SOURCE_BUCKET_NAME: SOURCE_BUCKET,
    COVER_R2: preview, PRODUCTION_COVERS_READONLY: production, IMAGES: images, PILOT_BUILD_SHA: 'abc123' };
  const usage = { source: USAGE_SOURCE, period: periodOf(Date.now()), billed_transformations: 4321, observed_at: new Date(Date.now() - 1000).toISOString(), raw_sha256: 'f'.repeat(64) };
  const fetchFn = (url, init) => worker.fetch(new Request(url, init), env);
  const call = pilotClient({ baseUrl: 'https://pilot.example', token: 'tok', fetchFn });
  return { preview, production, images, selection, usage, call, env };
}

test('the full pilot check passes against the Worker, spends exactly 30 + 2, and writes nothing to production', async () => {
  const f = environment();
  const result = await runPilotCheck({ call: f.call, selection: f.selection, usage: f.usage, expectedHead: 'abc123' });
  assert.equal(result.ok, true, JSON.stringify(result.steps.filter(s => !s.ok)));
  assert.equal(result.consumed, 32); assert.equal(f.images.calls, 32);
  const names = result.steps.map(s => s.name);
  for (const required of ['ready', 'init', 'init-cannot-be-repeated', 'pilot-run', 'objects-verified', 'resume-spends-nothing', 'budget-exhausted-stops', 'exhausted-ledger-spends-nothing-more', 'production-manifest-unchanged', 'never-above-32'])
    assert.ok(names.includes(required), required);
  assert.equal(names.filter(n => n.startsWith('object:')).length, 30);
  const exhaustion = result.steps.find(s => s.name === 'budget-exhausted-stops');
  assert.equal(exhaustion.attempts, 2); assert.equal(exhaustion.stopped, 'budget-exhausted');
  assert.equal(f.production.log.filter(([op]) => !['get', 'head'].includes(op)).length, 0, 'production never written');
  assert.ok(f.preview.log.filter(([op]) => op === 'put').every(([, key]) => /^covers\/(generation-ledger\/v2|variants\/v2)\//.test(key)));
});

test('the verifier stops at the first failed step: wrong build, tampered bytes, wrong dimensions, missing object', async () => {
  const wrongHead = environment();
  const r1 = await runPilotCheck({ call: wrongHead.call, selection: wrongHead.selection, usage: wrongHead.usage, expectedHead: 'other' });
  assert.equal(r1.ok, false); assert.equal(r1.failed_step, 'ready'); assert.equal(wrongHead.images.calls, 0, 'nothing generated after a failed first step');

  for (const [name, tamper] of [['tampered bytes', bytes => { const copy = bytes.slice(); copy[35] ^= 255; return copy; }],
    ['wrong dimensions', bytes => { const copy = bytes.slice(); copy[24] = (copy[24] + 7) & 255; return copy; }]]) {
    const f = environment();
    const call = async (path, init) => {
      const response = await f.call(path, init);
      return /^\/object\//.test(path) && response.ok ? { ...response, bytes: tamper(response.bytes) } : response;
    };
    const r = await runPilotCheck({ call, selection: f.selection, usage: f.usage });
    assert.equal(r.ok, false, name); assert.match(r.failed_step, /^object:/, name);
  }
  const missing = environment();
  const call = async (path, init) => /^\/object\//.test(path) ? { status: 404, ok: false, headers: new Headers(), bytes: new Uint8Array(), json: null } : missing.call(path, init);
  assert.match((await runPilotCheck({ call, selection: missing.selection, usage: missing.usage })).failed_step, /^object:/);
});

test('an unavailable usage report stops the pilot before any generation (no exception, no zero)', async () => {
  for (const usage of [undefined, { ...environment().usage, source: 'typed-by-hand' }, { ...environment().usage, billed_transformations: -1 },
    { ...environment().usage, observed_at: new Date(Date.now() - 48 * 3600e3).toISOString() }]) {
    const f = environment();
    const r = await runPilotCheck({ call: f.call, selection: f.selection, usage });
    assert.equal(r.ok, false); assert.equal(r.failed_step, 'init'); assert.equal(f.images.calls, 0); assert.deepEqual([...f.preview.store.keys()], []);
  }
});

// ---- Sharp comparison with real images ---------------------------------------------------
async function photoLike(width, height) {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3, n = ((x * 7 + y * 13) % 17) * 3;
    raw[i] = (x * 255 / width + n) % 256; raw[i + 1] = (y * 255 / height + n) % 256; raw[i + 2] = ((x + y) * 128 / (width + height) + 60 + n) % 256;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

test('comparison: metrics, advisory flags and contact sheets from the same master bytes', async () => {
  const master = await photoLike(600, 900);
  const similar = await sharp(master).resize({ width: 360, withoutEnlargement: true }).webp({ quality: 85, effort: 4 }).toBuffer();
  const ok = await compareRecipe({ sharp, masterBytes: master, cloudflareBytes: similar, width: 360 });
  assert.equal(ok.result.dims_equal, true); assert.equal(ok.result.width, 360);
  assert.ok(ok.result.psnr_sharp > 20 && Math.abs(ok.result.psnr_sharp - ok.result.psnr_cloudflare) < 0.5, JSON.stringify(ok.result));
  assert.ok(ok.result.ssim_cloudflare > 0.5 && ok.result.ssim_cloudflare <= 1); assert.deepEqual(ok.result.review, []);
  assert.ok(Math.abs(ok.result.bytes_ratio - 1) < 0.05);

  const blurry = await sharp(master).resize({ width: 360 }).webp({ quality: 5, effort: 4 }).toBuffer();
  const worse = await compareRecipe({ sharp, masterBytes: master, cloudflareBytes: blurry, width: 360 });
  assert.ok(worse.result.review.includes('cloudflare-psnr-lower') || worse.result.review.includes('cloudflare-ssim-lower'), JSON.stringify(worse.result));

  const heavy = await sharp(master).resize({ width: 360 }).webp({ lossless: true }).toBuffer();
  assert.ok((await compareRecipe({ sharp, masterBytes: master, cloudflareBytes: heavy, width: 360 })).result.review.includes('cloudflare-heavier'));

  const wrongSize = await sharp(master).resize({ width: 300 }).webp({ quality: 85 }).toBuffer();
  const bad = await compareRecipe({ sharp, masterBytes: master, cloudflareBytes: wrongSize, width: 360 });
  assert.equal(bad.result.dims_equal, false); assert.deepEqual(bad.result.review, ['dimensions-differ']); assert.equal(bad.result.psnr_cloudflare, undefined);

  const sheet = await contactSheet({ sharp, masterBytes: master, sharpBytes: ok.sharpBytes, cloudflareBytes: ok.cloudflareBytes, width: 360, label: 'test 360px' });
  const meta = await sharp(sheet).metadata();
  assert.equal(meta.format, 'png'); assert.ok(meta.width >= 3 * 360 && meta.height >= 540);
});

test('small masters are never enlarged in the comparison either, and metric helpers behave', async () => {
  const small = await photoLike(300, 450);
  const cf = await sharp(small).webp({ quality: 85 }).toBuffer(); // 300 px: what a non-enlarging encoder returns for a 480 recipe
  const r = await compareRecipe({ sharp, masterBytes: small, cloudflareBytes: cf, width: 480 });
  assert.equal(r.result.width, 300); assert.equal(r.result.dims_equal, true);
  const a = { width: 8, height: 8, data: Buffer.alloc(8 * 8 * 3, 100) };
  assert.equal(psnr(a, a), 100); assert.equal(Number(ssim(a, a).toFixed(6)), 1);
  assert.ok(REVIEW_THRESHOLDS.psnrDropDb > 0);
});

test('the verifier fails if the production manifest ETag changes during the pilot', async () => {
  const f = environment(); let reads = 0;
  const call = async (path, init) => {
    const response = await f.call(path, init);
    if (path === '/production-etag' && ++reads === 2) return { ...response, json: { etag: 'changed', size: 3 } };
    return response;
  };
  const r = await runPilotCheck({ call, selection: f.selection, usage: f.usage });
  assert.equal(r.ok, false); assert.equal(r.failed_step, 'production-manifest-unchanged');
});
