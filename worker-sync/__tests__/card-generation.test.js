import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  initLedger, readLedger, runGeneration, ledgerKey, periodOf, validateGenerationPlan,
  GENERATION_CAP_CEILING, RESERVE_ATTEMPTS, LEASE_MS, MAX_ITEM_ATTEMPTS,
} from '../card-generation.js';
import { variantObjectKey } from '../../shared/image-variants.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const T0 = Date.parse('2026-10-18T12:00:00Z');

function png(width, height, salt = 0) {
  const bytes = new Uint8Array(64);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width); view.setUint32(20, height); bytes[40] = salt;
  return bytes;
}
function webp(width, height) {
  const bytes = new Uint8Array(40);
  bytes.set([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 88]);
  const w = width - 1, h = height - 1;
  bytes.set([w & 255, (w >> 8) & 255, (w >> 16) & 255, h & 255, (h >> 8) & 255, (h >> 16) & 255], 24);
  return bytes;
}

// R2 simulado con ETag y precondiciones reales (etagMatches / etagDoesNotMatch).
function fakeBucket(name = 'preview') {
  const store = new Map(); let counter = 0; const log = []; const hooks = { failPut: null };
  const wrap = (key, entry) => entry && {
    key, etag: entry.etag, size: entry.bytes.length, customMetadata: entry.customMetadata, httpMetadata: entry.httpMetadata,
    body: new Blob([entry.bytes]).stream(), text: async () => new TextDecoder().decode(entry.bytes) };
  return { name, store, log, hooks,
    async get(key) { log.push(['get', key]); return wrap(key, store.get(key)) || null; },
    async head(key) { log.push(['head', key]); const e = store.get(key); return e ? { ...wrap(key, e), body: undefined } : null; },
    async put(key, value, options = {}) {
      log.push(['put', key]);
      if (hooks.failPut?.(key)) throw new Error('R2 unavailable');
      const existing = store.get(key);
      if (options.onlyIf?.etagDoesNotMatch === '*' && existing) return null;
      if (options.onlyIf?.etagMatches && existing?.etag !== options.onlyIf.etagMatches) return null;
      if (options.onlyIf?.etagMatches && !existing) return null;
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
      const entry = { bytes, etag: 'e' + (++counter), customMetadata: options.customMetadata, httpMetadata: options.httpMetadata };
      store.set(key, entry); return { etag: entry.etag, key };
    } };
}

function fakeImages({ mode = 'ok' } = {}) {
  const calls = [];
  return { calls,
    input(stream) { const read = new Response(stream).arrayBuffer().then(b => { const v = new DataView(b); return { width: v.getUint32(16), height: v.getUint32(20) }; });
      return { transform(t) { return { async output(o) {
      calls.push({ transform: t, output: o }); const masterSize = await read;
      if (mode === 'throw') throw new Error('Images 9999 https://secret.example/x');
      if (mode === 'hang') await new Promise(() => {});
      if (mode === 'http') return { response: () => new Response('no', { status: 500 }) };
      if (mode === 'rotated') return { response: () => new Response(webp(500, 300), { headers: { 'content-type': 'image/webp' } }) };
      if (mode === 'enlarged') return { response: () => new Response(webp(t.width * 2, t.width * 3), { headers: { 'content-type': 'image/webp' } }) };
      if (mode === 'jpeg') return { response: () => new Response(webp(10, 10), { headers: { 'content-type': 'image/jpeg' } }) };
      const w = Math.min(masterSize.width, t.width), h = Math.round(masterSize.height * w / masterSize.width);
      return { response: () => new Response(webp(w, h), { headers: { 'content-type': 'image/webp' } }) };
    } }; } }; } };
}

function setup({ masters = [[800, 1200], [300, 450]], recipes = ['v2-240-q85', 'v2-360-q85', 'v2-480-q85'], mode, cap = 100, prior = 0 } = {}) {
  const preview = fakeBucket('preview'), production = fakeBucket('production-readonly');
  const items = masters.map(([width, height], i) => {
    const bytes = png(width, height, i); const hash = sha(bytes);
    production.store.set(`covers/v1/objects/${hash}.png`, { bytes, etag: 'm' + i });
    return { file: `${hash}.png`, size: bytes.length, width, height, recipes };
  });
  const plan = { schema: 'card-generation-plan-v2', recipes: ['v2-240-q85', 'v2-360-q85', 'v2-480-q85'], items, items_sha256: sha(JSON.stringify(items)) };
  let clockMs = T0; const clock = () => clockMs;
  const images = fakeImages({ mode });
  const run = (extra = {}) => runGeneration({ bucket: preview, sourceBucket: production, images, plan, approval: plan.items_sha256,
    clock, limit: 50, holder: 'job-' + Math.random(), ...extra });
  return { preview, production, plan, items, images, run, clock, advance: ms => { clockMs += ms; },
    init: () => initLedger(preview, { now: T0, capAttempts: cap, priorConsumed: prior }),
    ledger: async () => (await readLedger(preview, periodOf(clockMs))).ledger };
}

test('budget constants: USD 15 generation = 30.000 attempts, USD 5 reserve is not usable', () => {
  assert.equal(GENERATION_CAP_CEILING, 30_000); assert.equal(RESERVE_ATTEMPTS, 10_000);
  assert.equal(GENERATION_CAP_CEILING * 0.5 / 1000, 15); assert.equal(RESERVE_ATTEMPTS * 0.5 / 1000, 5);
});

test('ledger must be created explicitly with prior consumption; generation without it stops before any read or Images call', async () => {
  const f = setup();
  const r = await f.run();
  assert.equal(r.stopped, 'ledger-missing'); assert.equal(f.images.calls.length, 0);
  assert.deepEqual(f.production.log, [], 'no master read');
  for (const bad of [{ capAttempts: 30_001, priorConsumed: 0 }, { capAttempts: 0, priorConsumed: 0 }, { capAttempts: 100 },
    { capAttempts: 100, priorConsumed: -1 }, { capAttempts: 100, priorConsumed: 101 }, { capAttempts: 100, priorConsumed: 1.5 }])
    await assert.rejects(initLedger(f.preview, { now: T0, ...bad }), /invalid-/);
  await f.init();
  await assert.rejects(f.init(), /ledger-exists/, 'second init can never reset the counter');
  assert.deepEqual([...f.preview.store.keys()], [ledgerKey('2026-10')]);
});

test('happy path: attempts are persisted before Images, v2 keys/metadata exact, dimensions proportional, no enlargement', async () => {
  const f = setup({ prior: 7 }); await f.init();
  // Observe the ledger at the instant Images is called.
  const seen = [];
  const original = f.images.input.bind(f.images);
  f.images.input = stream => { seen.push(JSON.parse(new TextDecoder().decode(f.preview.store.get(ledgerKey('2026-10')).bytes))); return original(stream); };
  const r = await f.run();
  assert.equal(r.stopped, null); assert.equal(r.attempts, 6); assert.equal(r.created, 6); assert.equal(r.complete, true);
  assert.deepEqual(seen.map(l => l.consumed), [1, 2, 3, 4, 5, 6], 'consumed already persisted at each call');
  assert.ok(seen.every(l => l.lease.pending), 'pending attempt recorded before call');
  const ledger = await f.ledger();
  assert.equal(ledger.consumed, 6); assert.equal(ledger.succeeded, 6); assert.equal(ledger.prior_consumed, 7); assert.equal(ledger.lease, null);
  assert.equal(ledger.progress.next_index, 2);
  const keys = [...f.preview.store.keys()].filter(k => k.startsWith('covers/variants/')).sort();
  assert.equal(keys.length, 6); assert.ok(keys.every(k => /^covers\/variants\/v2\/[a-f0-9]{64}\/v2-(240|360|480)-q85\.webp$/.test(k)));
  const [hash] = f.items[1].file.split('.');
  const small = f.preview.store.get(variantObjectKey(hash, 'v2-480-q85'));
  assert.equal(small.customMetadata.width, '300', 'small master is never enlarged');
  assert.equal(small.customMetadata.encoder, 'cloudflare-images'); assert.equal(small.customMetadata.recipe, 'v2-480-q85');
  assert.equal(small.customMetadata.master_sha256, hash); assert.equal(small.customMetadata.sha256, sha(small.bytes));
  assert.equal(small.httpMetadata.contentType, 'image/webp');
  assert.ok(f.images.calls.every(c => c.output.format === 'image/webp' && c.output.quality === 85 && c.transform.fit === 'scale-down'));
  // Only the ledger and v2 variant keys were ever written, only to the preview bucket.
  assert.ok(f.preview.log.filter(([op]) => op === 'put').every(([, k]) => k === ledgerKey('2026-10') || k.startsWith('covers/variants/v2/')));
  assert.equal(f.production.log.filter(([op]) => op === 'put').length, 0, 'source bucket is read-only');
});

test('resume: rerun creates nothing, calls Images zero times, and consumes no budget', async () => {
  const f = setup(); await f.init(); await f.run();
  const before = (await f.ledger()).consumed; const calls = f.images.calls.length;
  const again = await f.run();
  assert.equal(again.attempts, 0); assert.equal(f.images.calls.length, calls); assert.equal((await f.ledger()).consumed, before);
});

test('restarting the job never resets the allowance: budget is shared across runs and prior consumption counts', async () => {
  const f = setup({ cap: 10, prior: 7 }); await f.init();
  const a = await f.run();
  assert.equal(a.stopped, 'budget-exhausted'); assert.equal(a.attempts, 3); assert.equal(f.images.calls.length, 3);
  const b = await f.run(); assert.equal(b.stopped, 'budget-exhausted'); assert.equal(b.attempts, 0);
  assert.equal(f.images.calls.length, 3); assert.equal((await f.ledger()).consumed, 3);
  assert.equal(a.complete, false);
});

test('errors, timeouts and bad outputs consume budget, create no object, and stop retrying after the item limit', async () => {
  for (const mode of ['throw', 'http', 'rotated', 'enlarged', 'jpeg', 'hang']) {
    const f = setup({ mode, masters: [[800, 1200]], recipes: ['v2-240-q85'] }); await f.init();
    const first = await f.run({ imagesTimeoutMs: 20 });
    assert.equal(first.attempts, 1, mode); assert.equal(first.created, 0); assert.equal(first.failures.length, 1);
    assert.match(first.failures[0].reason, /^(images-error|images-http-\d{3}|images-timeout|dimensions-or-aspect-ratio-mismatch)$/, 'only known codes, no free text/URLs');
    assert.doesNotMatch(JSON.stringify(await f.ledger()), /secret|https/);
    assert.equal([...f.preview.store.keys()].filter(k => k.includes('/variants/')).length, 0, mode);
    assert.equal((await f.ledger()).consumed, 1); assert.equal((await f.ledger()).failed, 1);
    assert.equal(first.complete, false, 'retry still pending');
    const second = await f.run({ imagesTimeoutMs: 20 });
    assert.equal(second.attempts, 1); assert.equal((await f.ledger()).consumed, MAX_ITEM_ATTEMPTS);
    const third = await f.run({ imagesTimeoutMs: 20 });
    assert.equal(third.attempts, 0, 'poisoned item no longer spends'); assert.equal((await f.ledger()).progress.next_index, 1, 'cursor moved past the permanently failed item'); assert.equal((await f.ledger()).failures[Object.keys((await f.ledger()).failures)[0]].n, MAX_ITEM_ATTEMPTS);
    assert.equal(f.images.calls.length, MAX_ITEM_ATTEMPTS);
  }
});

test('if the ledger cannot be persisted, Images is never called (fail closed)', async () => {
  const f = setup(); await f.init();
  f.preview.hooks.failPut = key => key === ledgerKey('2026-10');
  const r = await f.run(); assert.equal(r.stopped, 'ledger-unavailable'); assert.equal(f.images.calls.length, 0);
  // Corrupt, wrong period, tampered counters, raised cap: all stop generation.
  for (const mutate of [l => { l.consumed = -1; }, l => { l.cap_attempts = 30_001; }, l => { l.period = '2026-09'; },
    l => { l.schema = 'x'; }, l => { l.consumed = '3'; }, l => { delete l.progress; }, l => { l.failures = []; }]) {
    const g = setup(); await g.init();
    const key = ledgerKey('2026-10'); const entry = g.preview.store.get(key);
    const ledger = JSON.parse(new TextDecoder().decode(entry.bytes)); mutate(ledger);
    g.preview.store.set(key, { ...entry, bytes: new TextEncoder().encode(JSON.stringify(ledger)) });
    const out = await g.run(); assert.equal(out.stopped, 'ledger-unavailable'); assert.equal(g.images.calls.length, 0);
  }
  const h = setup(); await h.init(); h.preview.store.get(ledgerKey('2026-10')).bytes = new TextEncoder().encode('{not json');
  assert.equal((await h.run()).stopped, 'ledger-unavailable'); assert.equal(h.images.calls.length, 0);
});

test('a new month needs its own explicit ledger: no silent reuse of last month', async () => {
  const f = setup(); await f.init();
  f.advance(31 * 24 * 3600 * 1000);
  const r = await f.run(); assert.equal(r.stopped, 'ledger-missing'); assert.equal(f.images.calls.length, 0);
});

test('serialization: second job is refused while the lease is live; stale writer cannot spend; lease expiry allows takeover', async () => {
  const f = setup(); await f.init();
  // Job A reserves then hangs inside Images.
  const hang = fakeImages({ mode: 'hang' });
  const a = f.run({ images: hang, holder: 'A', imagesTimeoutMs: 60_000 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await f.ledger()).lease.holder, 'A'); assert.equal((await f.ledger()).consumed, 1);
  const b = await f.run({ holder: 'B' });
  assert.equal(b.stopped, 'job-running'); assert.equal(f.images.calls.length, 0);
  // After lease expiry B takes over, resolves A's pending attempt as an interrupted failure (never refunded).
  f.advance(LEASE_MS + 1);
  const b2 = await f.run({ holder: 'B' });
  assert.equal(b2.stopped, null);
  const ledger = await f.ledger();
  assert.equal(ledger.failures['x'], undefined);
  assert.ok(ledger.consumed >= 1 + b2.attempts, 'A attempt stays consumed');
  assert.equal(ledger.failed, 1);
  a.catch(() => {});
});

test('zombie job that wakes after takeover loses the CAS, cannot spend again, and does not corrupt the ledger', async () => {
  const f = setup({ masters: [[800, 1200]], recipes: ['v2-240-q85', 'v2-360-q85'] }); await f.init();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const slow = { calls: 0, input() { slow.calls++; return { transform: () => ({ output: async () => { await gate;
    return { response: () => new Response(webp(240, 360), { headers: { 'content-type': 'image/webp' } }) }; } }) }; } };
  const a = f.run({ images: slow, holder: 'A', imagesTimeoutMs: 60_000 });
  await new Promise(resolve => setTimeout(resolve, 30));
  f.advance(LEASE_MS + 1);
  const b = await f.run({ holder: 'B' });
  assert.equal(b.stopped, null);
  const consumedByB = (await f.ledger()).consumed;
  release();
  const zombie = await a;
  assert.equal(zombie.stopped, 'ledger-conflict');
  assert.equal(slow.calls, 1, 'zombie made no further paid call');
  assert.equal((await f.ledger()).consumed, consumedByB, 'zombie recorded nothing after losing the lease');
  assert.equal((await f.ledger()).lease, null);
});

test('interrupted job: pending attempt is reconciled against R2 (object exists => success, absent => failure), never refunded', async () => {
  for (const objectExists of [true, false]) {
    const f = setup({ masters: [[800, 1200]], recipes: ['v2-240-q85'] }); await f.init();
    const [hash] = f.items[0].file.split('.'); const ref = `${hash}/v2-240-q85`;
    const key = ledgerKey('2026-10'); const entry = f.preview.store.get(key);
    const ledger = JSON.parse(new TextDecoder().decode(entry.bytes));
    ledger.consumed = 1; ledger.lease = { holder: 'dead', expires_at: new Date(T0 - 1).toISOString(), pending: { key: ref, at: 'x' } };
    f.preview.store.set(key, { ...entry, bytes: new TextEncoder().encode(JSON.stringify(ledger)) });
    if (objectExists) f.preview.store.set(variantObjectKey(hash, 'v2-240-q85'), { bytes: webp(240, 360), etag: 'v',
      httpMetadata: { contentType: 'image/webp' }, customMetadata: { master_sha256: hash, recipe: 'v2-240-q85', sha256: 'c'.repeat(64), encoder: 'cloudflare-images' } });
    const r = await f.run();
    const after = await f.ledger();
    assert.equal(after.lease, null);
    if (objectExists) { assert.equal(r.attempts, 0); assert.equal(after.succeeded, 1); assert.equal(after.consumed, 1); }
    else { assert.equal(r.attempts, 1); assert.equal(after.failed, 1); assert.equal(after.consumed, 2, 'the interrupted attempt is not refunded'); }
  }
});

test('never overwrites: conflicting v2 objects are reported; existing v1 is reused; invalid masters spend nothing', async () => {
  const f = setup({ masters: [[800, 1200]], recipes: ['v2-240-q85', 'v2-360-q85', 'v2-480-q85'] }); await f.init();
  const [hash] = f.items[0].file.split('.');
  f.preview.store.set(variantObjectKey(hash, 'v2-240-q85'), { bytes: new Uint8Array([1]), etag: 'z', httpMetadata: { contentType: 'image/webp' }, customMetadata: {} });
  f.production.store.set(variantObjectKey(hash, 'v1-360-q85'), { bytes: new Uint8Array([1]), etag: 'y', customMetadata: { master_sha256: hash, recipe: 'v1-360-q85' } });
  const r = await f.run();
  assert.deepEqual(r.conflicts, [`${hash}/v2-240-q85`]);
  assert.deepEqual(r.skipped, [{ ref: `${hash}/v2-360-q85`, reason: 'v1-exists' }]);
  assert.equal(r.attempts, 1, 'only 480 was generated');
  assert.deepEqual(f.preview.store.get(variantObjectKey(hash, 'v2-240-q85')).bytes, new Uint8Array([1]));

  const g = setup({ masters: [[800, 1200]] }); await g.init();
  g.production.store.get(`covers/v1/objects/${g.items[0].file}`).bytes[40] = 99; // hash no longer matches
  const bad = await g.run();
  assert.equal(bad.attempts, 0); assert.equal(g.images.calls.length, 0); assert.equal(bad.failures[0].reason, 'master-invalid');
  assert.equal((await g.ledger()).consumed, 0);
  const h = setup({ masters: [[800, 1200]] }); await h.init();
  h.plan.items[0].width = 801; h.plan.items_sha256 = sha(JSON.stringify(h.plan.items));
  assert.equal((await h.run({ approval: h.plan.items_sha256 })).failures[0].reason, 'master-invalid', 'plan dimensions must match the master');
});

test('closed plan: unapproved, tampered, duplicated or open-ended plans never run', async () => {
  const f = setup(); await f.init();
  for (const change of [{ approval: 'a'.repeat(64) }, { approval: undefined }, { limit: 0 }, { limit: 501 }, { holder: '' }]) {
    const r = await f.run(change); assert.ok(r.stopped, JSON.stringify(change)); assert.equal(f.images.calls.length, 0);
  }
  const bad = [p => p.items.push({ ...p.items[0] }), p => { p.items[0].recipes = ['v1-240-q85']; }, p => { p.items[0].recipes = ['v2-1024-q85']; },
    p => { p.items[0].file = '../x.png'; }, p => { p.items = []; }, p => { p.schema = 'x'; }, p => { p.items[0].size = 9e9; }];
  for (const mutate of bad) {
    const p = structuredClone(f.plan); mutate(p); p.items_sha256 = sha(JSON.stringify(p.items));
    assert.throws(() => validateGenerationPlan(p, p.items_sha256), /invalid-plan|plan-not-approved/);
  }
  assert.equal(f.images.calls.length, 0);
});

test('run limit bounds attempts per invocation and leaves the cursor on the unfinished item', async () => {
  const f = setup(); await f.init();
  const r = await f.run({ limit: 4 });
  assert.equal(r.stopped, 'run-limit'); assert.equal(r.attempts, 4); assert.equal(r.complete, false);
  assert.equal((await f.ledger()).progress.next_index, 1);
  const rest = await f.run({ limit: 4 }); assert.equal(rest.attempts, 2); assert.equal(rest.complete, true);
  assert.equal((await f.ledger()).progress.next_index, 2);
});

test('progress and ledger writes are serialized: a concurrent writer loses the CAS and stops without spending', async () => {
  const f = setup(); await f.init();
  const key = ledgerKey('2026-10');
  const realPut = f.preview.put.bind(f.preview); let puts = 0;
  f.preview.put = async (k, v, o) => { if (k === key && ++puts === 2) { // another writer slips in between our read and write
    const entry = f.preview.store.get(key); f.preview.store.set(key, { ...entry, etag: 'intruder' }); }
    return realPut(k, v, o); };
  const r = await f.run();
  assert.equal(r.stopped, 'ledger-conflict'); assert.equal(f.images.calls.length, 0, 'lost CAS => no paid call');
});
