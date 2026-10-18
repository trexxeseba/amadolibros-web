import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker, { previewFacade, sourceFacade, PILOT_MAX_NEW_ATTEMPTS, PREVIEW_BUCKET, SOURCE_BUCKET } from '../card-generation-preview.js';
import { USAGE_SOURCE, ledgerKey, periodOf } from '../card-generation.js';
import { variantObjectKey } from '../../shared/image-variants.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function png(width, height) {
  const bytes = new Uint8Array(64);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer); view.setUint32(16, width); view.setUint32(20, height); return bytes;
}
function webp(width, height) {
  const bytes = new Uint8Array(40);
  bytes.set([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 88]);
  const w = width - 1, h = height - 1; bytes.set([w & 255, (w >> 8) & 255, 0, h & 255, (h >> 8) & 255, 0], 24); return bytes;
}
function bucket() {
  const store = new Map(); const log = []; let n = 0;
  const wrap = (key, e) => e && { key, etag: e.etag, size: e.bytes.length, customMetadata: e.customMetadata, httpMetadata: e.httpMetadata,
    body: new Blob([e.bytes]).stream(), text: async () => new TextDecoder().decode(e.bytes) };
  return { store, log,
    async get(key) { log.push(['get', key]); return wrap(key, store.get(key)) || null; },
    async head(key) { log.push(['head', key]); const e = store.get(key); return e ? { ...wrap(key, e), body: undefined } : null; },
    async put(key, value, o = {}) { log.push(['put', key]); const ex = store.get(key);
      if (o.onlyIf?.etagDoesNotMatch === '*' && ex) return null;
      if (o.onlyIf?.etagMatches && ex?.etag !== o.onlyIf.etagMatches) return null;
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
      store.set(key, { bytes, etag: 'e' + (++n), customMetadata: o.customMetadata, httpMetadata: o.httpMetadata }); return { etag: 'e' + n }; },
    async delete() { throw new Error('delete must never be reachable'); }, async list() { throw new Error('list must never be reachable'); } };
}
const images = { calls: 0, input(stream) { images.calls++; const read = new Response(stream).arrayBuffer().then(b => new DataView(b));
  return { transform: t => ({ output: async () => { const v = await read; const w = Math.min(v.getUint32(16), t.width), h = Math.round(v.getUint32(20) * w / v.getUint32(16));
    return { response: () => new Response(webp(w, h), { headers: { 'content-type': 'image/webp' } }) }; } }) }; } };

function setup() {
  const preview = bucket(), production = bucket();
  const bytes = png(800, 1200), hash = sha(bytes);
  production.store.set(`covers/v1/objects/${hash}.png`, { bytes, etag: 'm' });
  const items = [{ file: `${hash}.png`, size: bytes.length, width: 800, height: 1200, recipes: ['v2-240-q85', 'v2-360-q85', 'v2-480-q85'] }];
  const plan = { schema: 'card-generation-plan-v2', recipes: ['v2-240-q85', 'v2-360-q85', 'v2-480-q85'], items, items_sha256: sha(JSON.stringify(items)) };
  const env = { PILOT_TOKEN: 'tok', PILOT_MODE: 'preview-card-generation', PREVIEW_BUCKET_NAME: PREVIEW_BUCKET, SOURCE_BUCKET_NAME: SOURCE_BUCKET,
    COVER_R2: preview, PRODUCTION_COVERS_READONLY: production, IMAGES: images, PILOT_BUILD_SHA: 'abc' };
  const usage = { source: USAGE_SOURCE, period: periodOf(Date.now()), billed_transformations: 0, observed_at: new Date(Date.now() - 1000).toISOString(), raw_sha256: 'f'.repeat(64) };
  const call = (path, init = {}, e = env) => worker.fetch(new Request('https://pilot.example' + path, { ...init, headers: { authorization: 'Bearer tok', ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body), method: init.method || 'GET' }), e);
  return { preview, production, plan, env, usage, call, hash };
}

test('auth and configuration guards: no token, wrong token, wrong mode/bucket names or missing bindings never reach R2', async () => {
  const f = setup();
  assert.equal((await worker.fetch(new Request('https://pilot.example/ready'), f.env)).status, 403);
  assert.equal((await worker.fetch(new Request('https://pilot.example/ready', { headers: { authorization: 'Bearer nope' } }), f.env)).status, 403);
  for (const change of [e => { e.PILOT_MODE = 'production'; }, e => { e.PREVIEW_BUCKET_NAME = SOURCE_BUCKET; }, e => { e.SOURCE_BUCKET_NAME = PREVIEW_BUCKET; },
    e => { delete e.IMAGES; }, e => { delete e.PRODUCTION_COVERS_READONLY; }, e => { delete e.COVER_R2; }]) {
    const e = { ...f.env }; change(e);
    assert.equal((await f.call('/ready', {}, e)).status, 503);
  }
  assert.equal((await f.call('/ready')).status, 200);
  assert.deepEqual([...f.preview.log, ...f.production.log], []);
});

test('facades enforce the exact allow-list: previews write only ledger + v2; production is get/head of masters and v1 only', async () => {
  const f = setup(); const p = previewFacade(f.preview), s = sourceFacade(f.production);
  const h = 'a'.repeat(64);
  await p.put(ledgerKey('2026-10'), '{}'); await p.put(variantObjectKey(h, 'v2-240-q85'), new Uint8Array([1]));
  for (const key of ['covers/v1/manifest.json', `covers/v1/objects/${h}.jpg`, variantObjectKey(h, 'v1-240-q85'), 'covers/card-readiness/v1/x.json',
    `covers/variants/v2/${h}/v2-1024-q85.webp`, `covers/variants/v2/${h}/../v2-240-q85.webp`, 'covers/generation-ledger/v2/x/ledger.json', ''])
    assert.throws(() => p.put(key, 'x'), /pilot-operation-denied/, key);
  for (const key of ['covers/v1/manifest.json', `covers/variants/v2/${h}/v2-240-q85.webp`, 'covers/card-readiness/v1/x.json', `covers/v1/objects/../${h}.jpg`])
    assert.throws(() => s.get(key), /pilot-operation-denied/, key);
  assert.equal(s.put, undefined); assert.equal(s.delete, undefined); assert.equal(s.list, undefined);
  assert.equal(p.delete, undefined); assert.equal(p.list, undefined);
  assert.doesNotThrow(() => s.get(`covers/v1/objects/${h}.jpg`)); assert.doesNotThrow(() => s.head(variantObjectKey(h, 'v1-360-q85')));
});

test('pilot ledger and plan sizes are capped inside the Worker itself', async () => {
  const f = setup();
  assert.equal(PILOT_MAX_NEW_ATTEMPTS, 32);
  for (const cap of [PILOT_MAX_NEW_ATTEMPTS + 1, 100, 0, 1.5, '32', 30_000, undefined]) assert.equal((await f.call('/init', { method: 'POST', body: { maxNewAttempts: cap, usage: f.usage } })).status, 400, String(cap));
  assert.equal((await f.call('/init', { method: 'POST', body: { maxNewAttempts: 32, usage: { ...f.usage, source: 'typed' } } })).status, 400);
  assert.equal((await f.call('/init', { method: 'POST', body: { maxNewAttempts: 32 } })).status, 400);
  assert.deepEqual([...f.preview.store.keys()], [], 'nothing written by rejected requests');
  const big = { ...f.plan, items: Array.from({ length: 11 }, () => f.plan.items[0]) };
  assert.equal((await f.call('/run', { method: 'POST', body: { plan: big, approval: 'x', usage: f.usage, limit: 5 } })).status, 400);
  assert.equal((await f.call('/run', { method: 'POST', body: { plan: f.plan, approval: f.plan.items_sha256, usage: f.usage, limit: 33 } })).status, 400);
  assert.equal(images.calls, 0);
});

test('end to end in Preview shape: init, run, resume; only ledger and v2 keys are written; production is never written', async () => {
  const f = setup(); images.calls = 0;
  const init = await f.call('/init', { method: 'POST', body: { maxNewAttempts: 4, usage: { ...f.usage, billed_transformations: 4_000 } } });
  assert.equal(init.status, 200); const initialized = await init.json();
  assert.equal(initialized.max_new_attempts, 4); assert.equal(initialized.cap_attempts, 30_000, 'absolute ceiling is not caller controlled'); assert.equal(initialized.prior_consumed, 4_000);
  assert.equal((await f.call('/init', { method: 'POST', body: { maxNewAttempts: 99, usage: f.usage } })).status, 400, 'ledger can never be re-initialised');
  const run = await (await f.call('/run', { method: 'POST', body: { plan: f.plan, approval: f.plan.items_sha256, usage: f.usage, limit: 10 } })).json();
  assert.equal(run.created, 3); assert.equal(run.attempts, 3); assert.equal(run.complete, true); assert.equal(images.calls, 3);
  const again = await (await f.call('/run', { method: 'POST', body: { plan: f.plan, approval: f.plan.items_sha256, usage: f.usage, limit: 10 } })).json();
  assert.equal(again.attempts, 0); assert.equal(images.calls, 3);
  const status = await (await f.call('/status')).json();
  assert.equal(status.ledger.consumed, 3); assert.equal(status.ledger.lease, null);
  const fetched = await f.call(`/object/${f.hash}/v2-240-q85`);
  assert.equal(fetched.status, 200); assert.equal(fetched.headers.get('content-type'), 'image/webp');
  assert.equal(JSON.parse(fetched.headers.get('x-variant-metadata')).encoder, 'cloudflare-images');
  assert.equal((await f.call(`/object/${f.hash}/v1-240-q85`)).status, 404, 'only v2 objects are exposed');
  const writes = f.preview.log.filter(([op]) => op === 'put').map(([, k]) => k);
  assert.ok(writes.every(k => /^covers\/generation-ledger\/v2\//.test(k) || /^covers\/variants\/v2\//.test(k)));
  assert.equal(f.production.log.filter(([op]) => !['get', 'head'].includes(op)).length, 0);
  assert.ok(f.production.log.every(([, k]) => /^covers\/(v1\/objects|variants\/v1)\//.test(k)), 'production reads limited to masters and v1');
  assert.equal((await f.call('/delete', { method: 'POST', body: {} })).status, 404);
  assert.equal((await f.call('/ready', { method: 'POST', body: {} })).status, 404);
});

test('read-only helpers: v1 probe and master download expose nothing else and never write', async () => {
  const f = setup(); const h = f.hash;
  f.production.store.set(`covers/variants/v1/${h}/v1-360-q85.webp`, { bytes: new Uint8Array([1]), etag: 'x', customMetadata: { master_sha256: h, recipe: 'v1-360-q85' } });
  f.production.store.set(`covers/variants/v1/${h}/v1-240-q85.webp`, { bytes: new Uint8Array([1]), etag: 'y', customMetadata: { master_sha256: 'e'.repeat(64), recipe: 'v1-240-q85' } });
  const probe = await (await f.call(`/probe-v1/${h}`)).json();
  assert.deepEqual(probe, { hash: h, present: ['v1-360-q85'] }, 'metadata must match the master and recipe');
  const master = await f.call(`/master/${h}.png`);
  assert.equal(master.status, 200); assert.equal(sha(new Uint8Array(await master.arrayBuffer())), h);
  assert.equal((await f.call(`/master/${h}.gif`)).status, 404); assert.equal((await f.call('/master/../manifest.json')).status, 404);
  assert.equal((await f.call(`/probe-v1/${h}`, { method: 'POST', body: {} })).status, 404);
  assert.equal(f.production.log.filter(([op]) => !['get', 'head'].includes(op)).length, 0);
  assert.deepEqual(f.preview.log, []);
});

test('production manifest can only be HEADed (never read) to prove nothing changed', async () => {
  const f = setup(); f.production.store.set('covers/v1/manifest.json', { bytes: new Uint8Array([1, 2, 3]), etag: 'etag-1' });
  assert.deepEqual(await (await f.call('/production-etag')).json(), { etag: 'etag-1', size: 3 });
  assert.throws(() => sourceFacade(f.production).get('covers/v1/manifest.json'), /pilot-operation-denied/);
  assert.deepEqual(f.production.log, [['head', 'covers/v1/manifest.json']]);
  assert.equal((await f.call('/production-etag', { method: 'POST', body: {} })).status, 404);
});
