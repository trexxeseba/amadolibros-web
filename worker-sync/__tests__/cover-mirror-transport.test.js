import test from 'node:test';
import assert from 'node:assert/strict';
import { syncCoverMirror, COVER_MANIFEST_KEY } from '../cover-mirror.js';

const NOW = '2026-09-08T12:00:00.000Z';
const lost = () => new Error('Network connection lost.');
const entry = id => ({ product_id: id, position: 0, private_history: [{ unknown: id }], current: {
  object_key: 'covers/v1/objects/' + 'a'.repeat(64) + '.jpg', sha256: 'a'.repeat(64), mime: 'image/jpeg',
  source_url: 'https://http2.mlstatic.com/D_' + id + '-O.jpg', width: 600, height: 900, bytes: 1,
} });

test.beforeEach(() => {
  globalThis.FixedLengthStream = class extends TransformStream {
    constructor(length) {
      let count = 0;
      super({ transform(chunk, controller) { count += chunk.byteLength; controller.enqueue(chunk); },
        flush() { assert.equal(count, length); } });
    }
  };
});
test.afterEach(() => { delete globalThis.FixedLengthStream; });

class TransportBucket {
  constructor(mode, failure = lost()) {
    this.mode = mode;
    this.failure = failure;
    this.records = new Map();
    this.version = 0;
    this.reads = 0;
    this.attempts = [];
    this.commitsBeforeError = 0;
    this.seed(COVER_MANIFEST_KEY, { schema_version: 1, updated_at: '2026-09-01T00:00:00.000Z',
      entries: { 'MLU1:0': entry('MLU1') } }, { owner: 'initial-owner' });
  }
  seed(key, value, metadata) {
    this.records.set(key, { text: JSON.stringify(value), etag: 'etag-' + ++this.version, customMetadata: metadata });
  }
  json(key = COVER_MANIFEST_KEY) { return JSON.parse(this.records.get(key).text); }
  async head(key) { return this.records.get(key) || null; }
  async get(key) {
    if (key === COVER_MANIFEST_KEY) this.reads++;
    const record = this.records.get(key);
    return record && { ...record, body: new Response(record.text).body, text: async () => record.text };
  }
  async put(key, body, options = {}) {
    if (this.mode === 'index-error' && key.includes('/public-index/')) throw this.failure;
    if (this.mode === 'report-error' && key.endsWith('/quality-report.json')) throw this.failure;
    if (key === COVER_MANIFEST_KEY) {
      this.attempts.push(options.onlyIf);
      assert.equal(options.onlyIf.etagMatches, this.records.get(key).etag);
      const first = this.attempts.length === 1;
      if (this.mode === 'persistent' || (this.mode === 'other-error' && first)) throw this.failure;
      if (this.mode === 'before-write' && first) {
        // A competing writer wins before the uncertain transport result.
        this.seed(key, { schema_version: 1, updated_at: NOW, unknown_root: { winner: true },
          entries: { 'MLU1:0': entry('MLU1'), 'MLU2:0': entry('MLU2') } }, { owner: 'winner', extra: 'keep' });
        throw this.failure;
      }
      const value = await new Response(body).json();
      this.seed(key, value, options.customMetadata);
      if (this.mode === 'commit-then-throw' && first) {
        this.commitsBeforeError++;
        // The original PUT did commit; a subsequent metadata/private-root
        // update leaves the public tree valid and must survive recovery.
        this.seed(key, { ...value, unknown_root: { winner: true } }, {
          ...options.customMetadata, owner: 'winner', extra: 'keep',
        });
        throw this.failure;
      }
      return { etag: this.records.get(key).etag };
    }
    this.seed(key, await new Response(body).json(), options.customMetadata || {});
    return { etag: this.records.get(key).etag };
  }
}

const run = bucket => syncCoverMirror({ COVER_R2: bucket }, { items: [] }, {
  now: () => new Date(NOW), fetchFn() { throw new Error('No image fetch during bootstrap'); },
});

for (const mode of ['before-write', 'commit-then-throw']) {
  test(`re-reads and conditionally preserves the actual winner after ${mode}`, { timeout: 3000 }, async () => {
    const bucket = new TransportBucket(mode);
    const result = await run(bucket);
    assert.equal(result.manifest_retries, 1);
    assert.equal(result.manifest_transport_retries, 1);
    assert.deepEqual(result.manifest_transport_errors, [{ attempt: 1, message: 'Network connection lost.', outcome: 'unknown' }]);
    assert.equal(bucket.reads, 2);
    assert.equal(bucket.attempts.length, 2);
    assert.notEqual(bucket.attempts[0].etagMatches, bucket.attempts[1].etagMatches);
    assert.equal(bucket.commitsBeforeError, mode === 'commit-then-throw' ? 1 : 0);
    const manifest = bucket.json();
    assert.deepEqual(manifest.unknown_root, { winner: true });
    assert.deepEqual(manifest.entries['MLU1:0'].private_history, entry('MLU1').private_history);
    if (mode === 'before-write') assert.deepEqual(manifest.entries['MLU2:0'], entry('MLU2'));
    const metadata = bucket.records.get(COVER_MANIFEST_KEY).customMetadata;
    assert.equal(metadata.owner, 'winner');
    assert.equal(metadata.extra, 'keep');
    assert.equal(metadata.cover_index_v1, result.public_index.hash);
    assert.equal(result.public_index.entries, mode === 'before-write' ? 2 : 1);
  });
}

test('persistent exact transport failure stops after four attempts and reports all uncertain outcomes', { timeout: 3000 }, async () => {
  const bucket = new TransportBucket('persistent');
  await assert.rejects(run(bucket), error => {
    assert.match(error.message, /Transporte persistente.*Network connection lost\./);
    assert.equal(error.manifest_transport_retries, 3);
    assert.deepEqual(error.manifest_transport_errors.map(row => row.attempt), [1, 2, 3, 4]);
    assert.ok(error.manifest_transport_errors.every(row => row.outcome === 'unknown'));
    return true;
  });
  assert.equal(bucket.attempts.length, 4);
  assert.equal(bucket.reads, 4);
  assert.equal(bucket.records.has('covers/v1/quality-report.json'), false);
});

test('different conditional PUT errors propagate unchanged without retry', async () => {
  for (const failure of [new Error('Network connection lost'), new Error('Network connection lost. extra'), new Error('Access denied'), null]) {
    const bucket = new TransportBucket('other-error', failure);
    let thrown;
    try { await run(bucket); } catch (error) { thrown = error; }
    assert.equal(thrown, failure);
    assert.equal(bucket.attempts.length, 1);
    assert.equal(bucket.reads, 1);
  }
});

test('the exact message from index preparation or quality-report PUT never triggers manifest recovery', async () => {
  for (const mode of ['index-error', 'report-error']) {
    const bucket = new TransportBucket(mode);
    await assert.rejects(run(bucket), error => error === bucket.failure);
    assert.equal(bucket.reads, 1);
    assert.equal(bucket.attempts.length, mode === 'index-error' ? 0 : 1);
  }
});

test('the exact message from stream setup is not misclassified as a native PUT failure', async () => {
  const failure = lost();
  globalThis.FixedLengthStream = class { constructor() { throw failure; } };
  const bucket = new TransportBucket('none');
  await assert.rejects(run(bucket), error => error === failure);
  assert.equal(bucket.reads, 1);
  assert.equal(bucket.attempts.length, 0);
});
