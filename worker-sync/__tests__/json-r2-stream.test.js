import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { putJsonToR2 } from '../json-r2-stream.js';
import { COVER_MANIFEST_KEY, syncCoverMirror } from '../cover-mirror.js';

const encoder = new TextEncoder();
const knownLengths = new WeakMap();
const streams = [];

// A real backpressured TransformStream, with the length enforcement that R2
// requires from Cloudflare's FixedLengthStream. No buffering consumer is used
// by cancellation tests or by the large-document subprocess below.
class TestFixedLengthStream extends TransformStream {
  constructor(length) {
    let seen = 0;
    super({
      transform(chunk, controller) {
        assert.ok(chunk instanceof Uint8Array);
        seen += chunk.byteLength;
        if (seen > length) throw new Error('FixedLengthStream overflow');
        controller.enqueue(chunk);
      },
      flush() { if (seen !== length) throw new Error('FixedLengthStream underflow'); },
    });
    knownLengths.set(this.readable, length);
    streams.push(this);
  }
}

test.beforeEach(() => { streams.length = 0; globalThis.FixedLengthStream = TestFixedLengthStream; });
test.afterEach(() => { delete globalThis.FixedLengthStream; });

async function consume(body) {
  if (typeof body === 'string') return encoder.encode(body);
  if (body instanceof Uint8Array) return body;
  assert.ok(knownLengths.has(body), 'R2 must receive the known-length readable itself');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of body) {
    assert.ok(chunk.byteLength <= 64 * 1024);
    chunks.push(chunk);
    bytes += chunk.byteLength;
  }
  assert.equal(bytes, knownLengths.get(body));
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

test('streams exact JSON bytes including Unicode, private histories, unknown fields and array holes', async () => {
  const document = JSON.parse('{"schema_version":1,"unknown":{"__proto__":{"preserve":true}},"entries":{"MLU1:0":{"history":[{"private":"kept"}],"unknown":null}}}');
  document.entries['MLU1:0'].unicode = ('á💡"\\\u0000').repeat(18000);
  document.array = [undefined, , null, { omit: undefined, keep: false }];
  document.omit = undefined;
  const expected = JSON.stringify(document);
  const options = { onlyIf: { etagMatches: 'original' }, customMetadata: { owner: 'unchanged' } };
  const result = await putJsonToR2({ async put(key, body, actualOptions) {
    assert.equal(key, 'manifest');
    assert.equal(actualOptions, options);
    assert.equal(knownLengths.get(body), encoder.encode(expected).byteLength);
    assert.equal(new TextDecoder().decode(await consume(body)), expected);
    return { etag: 'new' };
  } }, 'manifest', document, options);
  assert.deepEqual(result, { etag: 'new' });
  assert.equal(streams[0].writable.locked, false);
});

for (const outcome of ['null-before-read', 'throw-before-read', 'null-after-read']) {
  test(`cancels producer without hanging when R2 returns ${outcome}`, { timeout: 2000 }, async () => {
    const failure = new Error('upload unavailable');
    const promise = putJsonToR2({ async put(key, body) {
      if (outcome === 'null-after-read') {
        const reader = body.getReader();
        await reader.read();
        reader.releaseLock();
      }
      if (outcome === 'throw-before-read') throw failure;
      return null;
    } }, 'manifest', { entries: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [i, { history: 'x'.repeat(1000) }])) });
    if (outcome === 'throw-before-read') await assert.rejects(promise, error => error === failure);
    else assert.equal(await promise, null);
    assert.equal(streams[0].writable.locked, false);
    const reader = streams[0].readable.getReader();
    const terminal = await reader.read().catch(error => ({ error }));
    assert.ok(terminal.done || terminal.error);
    reader.releaseLock();
  });
}

test('readable cancellation unblocks a native-style abort waiting on producer backpressure', { timeout: 2000 }, async () => {
  let cancelled = false;
  globalThis.FixedLengthStream = class extends TestFixedLengthStream {
    constructor(length) {
      super(length);
      let releaseAbort;
      const cancellation = new Promise(resolve => { releaseAbort = resolve; });
      const cancel = this.readable.cancel.bind(this.readable);
      this.readable.cancel = reason => { cancelled = true; releaseAbort(); return cancel(reason); };
      const getWriter = this.writable.getWriter.bind(this.writable);
      this.writable.getWriter = () => {
        const writer = getWriter();
        const abort = writer.abort.bind(writer);
        writer.abort = async reason => { await cancellation; return abort(reason); };
        return writer;
      };
    }
  };
  assert.equal(await putJsonToR2({ async put() { return null; } }, 'manifest', { entries: { x: 'x'.repeat(200000) } }), null);
  assert.equal(cancelled, true);
  assert.equal(streams[0].writable.locked, false);
});

test('producer failures abort the R2 consumer and propagate', { timeout: 2000 }, async () => {
  const document = { entries: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [i, { history: 'x'.repeat(1000) }])) };
  await assert.rejects(putJsonToR2({ async put(key, body) {
    // Mutate only after the size pass to model a serialization failure while
    // R2 is waiting for the producer. Real callers retain immutable documents.
    document.entries[999] = 1n;
    await consume(body);
  } }, 'manifest', document), /BigInt/);
  assert.equal(streams[0].writable.locked, false);
});

test('missing Cloudflare stream supports small native mocks but rejects a large body', async () => {
  delete globalThis.FixedLengthStream;
  let writes = 0;
  const bucket = { async put(key, body) { writes++; assert.ok(body instanceof Uint8Array); return undefined; } };
  assert.equal(await putJsonToR2(bucket, 'small', { entries: {} }), undefined);
  await assert.rejects(putJsonToR2(bucket, 'large', { entries: { x: { history: 'x'.repeat(1024 * 1024) } } }), /requires FixedLengthStream/);
  assert.equal(writes, 1);
});

test('manifest CAS retry and quality report stream preserve complete winning data and metadata', async () => {
  const now = '2026-09-08T12:00:00.000Z';
  const entry = id => ({ product_id: id, position: 0, private_history: { nested: ['retain', id] },
    source_probes: [{ private_detail: 'probe-' + id }], current: {
      object_key: 'covers/v1/objects/' + 'a'.repeat(64) + '.jpg', sha256: 'a'.repeat(64), mime: 'image/jpeg',
      source_url: 'https://http2.mlstatic.com/D_' + id + '-O.jpg', width: 100, height: 120, bytes: 1,
    } });
  const initial = { schema_version: 1, updated_at: '2026-09-07T12:00:00.000Z', root_private: { old: true }, entries: { 'MLU1:0': entry('MLU1') } };
  const winner = { ...initial, root_private: { concurrent: true }, extra_unknown: ['root', null],
    entries: { ...initial.entries, 'MLU2:0': entry('MLU2'), 'private-key': { preserve_unknown: true } } };
  const records = new Map();
  let version = 0;
  const seed = (key, value, metadata) => records.set(key, { bytes: encoder.encode(JSON.stringify(value)), etag: String(++version), customMetadata: metadata });
  seed(COVER_MANIFEST_KEY, initial, { owner: 'original' });
  let conflict = true;
  const attempts = [];
  const streamKeys = [];
  const bucket = {
    async head(key) { const row = records.get(key); return row && { ...row, size: row.bytes.byteLength }; },
    async get(key) {
      const row = records.get(key);
      return row && { ...row, text: async () => new TextDecoder().decode(row.bytes) };
    },
    async put(key, body, options = {}) {
      if (knownLengths.has(body)) streamKeys.push(key);
      if (key === COVER_MANIFEST_KEY) {
        attempts.push(options);
        if (conflict) { conflict = false; seed(key, winner, { owner: 'concurrent-owner', extra: 'keep' }); return null; }
        assert.equal(options.onlyIf.etagMatches, records.get(key).etag);
      }
      const bytes = await consume(body);
      records.set(key, { bytes, etag: String(++version), customMetadata: options.customMetadata || {} });
      return { etag: String(version) };
    },
  };
  const result = await syncCoverMirror({ COVER_R2: bucket }, { items: [] }, {
    now: () => new Date(now), fetchFn() { throw new Error('No image fetch in bootstrap'); },
  });
  assert.equal(result.manifest_retries, 1);
  const saved = records.get(COVER_MANIFEST_KEY);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(saved.bytes)), { ...winner, updated_at: now });
  assert.equal(saved.customMetadata.owner, 'concurrent-owner');
  assert.equal(saved.customMetadata.extra, 'keep');
  assert.equal(saved.customMetadata.cover_index_v1, result.public_index.hash);
  assert.equal(saved.customMetadata.cover_index_refreshed_at, now);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0].onlyIf, { etagMatches: '1' });
  const report = JSON.parse(new TextDecoder().decode(records.get('covers/v1/quality-report.json').bytes));
  assert.deepEqual(report.needs_better_source.map(row => row.probes), [entry('MLU1').source_probes, entry('MLU2').source_probes]);
  assert.deepEqual(streamKeys, [COVER_MANIFEST_KEY, COVER_MANIFEST_KEY, 'covers/v1/quality-report.json']);
});

test('100 MB output streams under a 48 MB heap without constructing the global JSON string', () => {
  const script = `
    import { putJsonToR2 } from './worker-sync/json-r2-stream.js';
    let expected;
    globalThis.FixedLengthStream = class extends TransformStream {
      constructor(length) {
        expected = length; let seen = 0;
        super({ transform(chunk, c) { seen += chunk.byteLength; c.enqueue(chunk); },
          flush() { if (seen !== length) throw new Error('incorrect byte length'); } });
      }
    };
    const history = 'x'.repeat(20000);
    const document = { schema_version: 1, entries: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => ['MLU' + i + ':0', { private_history: history }])) };
    let bytes = 0; let largest = 0;
    await putJsonToR2({ async put(key, body) {
      for await (const chunk of body) { bytes += chunk.byteLength; largest = Math.max(largest, chunk.byteLength); }
      return { etag: 'stored' };
    } }, 'manifest', document);
    if (bytes !== expected || bytes < 100000000 || largest > 65536) throw new Error('stream bounds failed');
    console.log(JSON.stringify({ bytes, largest }));
  `;
  const result = spawnSync(process.execPath, ['--max-old-space-size=48', '--input-type=module', '-e', script], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 20000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(JSON.parse(result.stdout).bytes > 100000000);
});
