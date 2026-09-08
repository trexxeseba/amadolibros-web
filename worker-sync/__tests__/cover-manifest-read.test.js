import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFullCoverManifest } from '../cover-manifest-read.js';
import { syncCoverMirror } from '../cover-mirror.js';

const encoder = new TextEncoder();
function streamed(text, chunkSize = 17) {
  const bytes = encoder.encode(text);
  let offset = 0;
  return { size: bytes.byteLength, body: new ReadableStream({ pull(controller) {
    if (offset === bytes.byteLength) controller.close();
    else { controller.enqueue(bytes.subarray(offset, offset + chunkSize)); offset += Math.min(chunkSize, bytes.byteLength - offset); }
  } }), text() { throw new Error('A stream must never be read through text()'); } };
}

test('retains every root field/history with JSON.parse semantics across single-byte UTF-8 splits', async () => {
  const text = String.raw`{"schema_version":1,"before":{"unknown":[true,null,-0,1e309]},"entries":{"MLU1:0":{"source_probes":[{"private":"á💡\\\""}],"lone_high":"\ud800","lone_low":"\udfff","escaped":"\ud800x\u0041","__proto__":{"private":true}},"__proto__":{"keep":"entry"}},"__proto__":{"keep":"root"},"after":[{},[],"𝄞"]}`;
  const parsed = await readFullCoverManifest(streamed(text, 1));
  assert.deepEqual(parsed, JSON.parse(text));
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(Object.getPrototypeOf(parsed.entries), Object.prototype);
  assert.equal(Object.getPrototypeOf(parsed.entries['MLU1:0']), Object.prototype);
  assert.equal(Object.hasOwn(parsed, '__proto__'), true);
  assert.equal(Object.hasOwn(parsed.entries, '__proto__'), true);
  assert.equal(parsed.entries['MLU1:0'].lone_high.charCodeAt(0), 0xd800);
  assert.equal(parsed.entries['MLU1:0'].lone_low.charCodeAt(0), 0xdfff);
});

test('duplicate keys and escaped entries names have the same last-value-wins result as JSON.parse', async () => {
  for (const text of [
    '{"schema_version":0,"schema_version":1,"entries":{"old":1},"entries":{"x":0,"x":{"history":2}}}',
    String.raw`{"schema_version":1,"\u0065ntries":{"x":1},"entries":null,"entries":{"__proto__":0,"__proto__":{"last":true}}}`,
    '{"entries":{"a":1},"entries":[1,2],"schema_version":1,"unknown":{"same":0,"same":2}}',
    '{"__proto__":{"first":1},"__proto__":{"last":2},"entries":{},"schema_version":1}',
  ]) {
    assert.deepEqual(await readFullCoverManifest(streamed(text, 3)), JSON.parse(text));
  }
});

test('rejects truncated, malformed and trailing JSON instead of returning a partial manifest', async () => {
  for (const text of [
    '', ' ', 'null', '[]', '{}{}', '{} trailing', '{', '{"a"', '{"a":', '{"a":1',
    '{"a":1,}', '{"a" 1}', '{"a":01}', '{"a":tru}', '{"a":1 "b":2}',
    '{"a":"unterminated}', '{"a":"bad\ncontrol"}', '{"a":"\\uGGGG"}',
    '{"entries":{"x":1,}}', '{"entries":{"x":[1,]}}', '{"entries":{"x":{]}}',
    '{"entries":{"x":1}', '{"entries":{,"x":1}}', '{"entries":{{}}}',
  ]) {
    await assert.rejects(readFullCoverManifest(streamed(text, 2)), undefined, text);
  }
});

test('invalid UTF-8 and early parse failure cancel the source and release its lock', async () => {
  for (const bytes of [new Uint8Array([123, 34, 120, 34, 58, 34, 0xff]), encoder.encode('{"entries":{invalid')]) {
    let cancelled = false;
    const body = new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel() { cancelled = true; } });
    await assert.rejects(readFullCoverManifest({ body }));
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  }
  await assert.rejects(readFullCoverManifest({ body: new Uint8Array([123, 34, 120, 34, 58, 34, 0xe2, 0x82]) }));
});

test('supports existing byte/small-text mocks and refuses a large text-only fallback', async () => {
  const text = '{"schema_version":1,"entries":{"x":{"history":"kept"}}}';
  assert.deepEqual(await readFullCoverManifest({ body: encoder.encode(text) }), JSON.parse(text));
  assert.deepEqual(await readFullCoverManifest({ text: async () => text }), JSON.parse(text));
  let called = false;
  await assert.rejects(readFullCoverManifest({ size: 80_000_000, text() { called = true; return text; } }), /readable stream/);
  assert.equal(called, false);
});

test('mirror still rejects invalid schema, missing entries and missing ETag before writes', async () => {
  for (const text of ['{"schema_version":2,"entries":{}}', '{"schema_version":1}', '{"schema_version":1,"entries":[]}', '{"schema_version":1,"entries":null}']) {
    let writes = 0;
    const bucket = { async get() { return { ...streamed(text), etag: 'known' }; }, async head() {}, async put() { writes++; } };
    await assert.rejects(syncCoverMirror({ COVER_R2: bucket }, { items: [] }), /inválido/);
    assert.equal(writes, 0);
  }
  await assert.rejects(syncCoverMirror({ COVER_R2: {
    async get() { return streamed('{"schema_version":1,"entries":{}}'); }, async head() {}, async put() { throw new Error('must not write'); },
  } }, { items: [] }), /sin ETag/);
});

test('two complete 60 MB reads retain every history under a 96 MB heap', () => {
  const script = `
    import { readFullCoverManifest } from './worker-sync/cover-manifest-read.js';
    const encoder = new TextEncoder();
    for (let pass = 0; pass < 2; pass++) {
      let next = -1; let bytes = 0;
      const body = new ReadableStream({ pull(controller) {
        let text;
        if (next === -1) { next++; text = '{"schema_version":1,"before":{"private":true},"entries":{'; }
        else if (next < 6000) {
          const id = next++;
          text = (id ? ',' : '') + JSON.stringify('MLU' + id + ':0') + ':' + JSON.stringify({ private_history: String(id).padEnd(10000, 'x') });
        } else if (next++ === 6000) text = '},"after":{"unknown":"kept"}}';
        else { controller.close(); return; }
        const chunk = encoder.encode(text); bytes += chunk.byteLength; controller.enqueue(chunk);
      } });
      const parsed = await readFullCoverManifest({ body, text() { throw new Error('no text buffering'); } });
      if (Object.keys(parsed.entries).length !== 6000 || bytes < 60000000 || parsed.after.unknown !== 'kept' || !parsed.before.private) throw new Error('full read failed');
      for (let i = 0; i < 6000; i++) if (parsed.entries['MLU' + i + ':0'].private_history !== String(i).padEnd(10000, 'x')) throw new Error('lost history');
      console.log(JSON.stringify({ pass, entries: 6000, bytes }));
    }
  `;
  const result = spawnSync(process.execPath, ['--max-old-space-size=96', '--input-type=module', '-e', script], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 20000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 2);
});
