import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('CAS retry releases each failed manifest graph before reading the next version', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { syncCoverMirror, COVER_MANIFEST_KEY } from './worker-sync/cover-mirror.js';
    const originalParse = JSON.parse;
    const weakEntries = new Map();
    JSON.parse = function (...args) {
      const value = originalParse(...args);
      if (value?.retention_marker) weakEntries.set(value.retention_marker, new WeakRef(value));
      return value;
    };
    globalThis.FixedLengthStream = class extends TransformStream {
      constructor(length) {
        let count = 0;
        super({ transform(chunk, c) { count += chunk.byteLength; c.enqueue(chunk); },
          flush() { assert.equal(count, length); } });
      }
    };
    for (const persistent of [false, true]) {
      let reads = 0;
      let puts = 0;
      let lastManifest;
      let lastMetadata;
      const prefix = persistent ? 'persistent-' : 'retry-';
      const bucket = {
        async head() { return null; },
        async get(key) {
          if (key !== COVER_MANIFEST_KEY) return null;
          if (reads) {
            // A new event-loop turn ends WeakRef's keep-alive job. GC is only
            // in this isolated test process, never in production code.
            await new Promise(setImmediate);
            global.gc();
            await new Promise(setImmediate);
            global.gc();
            assert.equal(weakEntries.get(prefix + reads).deref(), undefined,
              'failed manifest entry is still retained before the next read');
          }
          reads++;
          const text = JSON.stringify({ schema_version: 1, updated_at: '2026-09-01T00:00:00.000Z',
            private_root: { version: reads }, entries: { 'MLU1:0': {
              product_id: 'MLU1', position: 0, retention_marker: prefix + reads,
              private_history: { value: 'keep-' + reads },
              current: { object_key: 'covers/v1/objects/' + 'a'.repeat(64) + '.jpg', sha256: 'a'.repeat(64),
                mime: 'image/jpeg', source_url: 'https://http2.mlstatic.com/D_TEST-O.jpg', width: 600, height: 900, bytes: 1 },
            } } });
          return { body: new Response(text).body, etag: 'etag-' + reads, customMetadata: { owner: 'owner-' + reads } };
        },
        async put(key, body, options = {}) {
          if (key === COVER_MANIFEST_KEY) {
            puts++;
            assert.deepEqual(options.onlyIf, { etagMatches: 'etag-' + reads });
            if (persistent || puts === 1) return null;
            lastManifest = await new Response(body).json();
            lastMetadata = options.customMetadata;
            return { etag: 'committed' };
          }
          if (body?.getReader) await new Response(body).arrayBuffer();
          return { etag: 'stored' };
        },
      };
      const running = syncCoverMirror({ COVER_R2: bucket }, { items: [] }, {
        now: () => new Date('2026-09-08T12:00:00.000Z'), fetchFn() { throw new Error('no image fetch'); },
      });
      if (persistent) {
        await assert.rejects(running, /Conflicto persistente/);
        assert.equal(puts, 4);
        assert.equal(reads, 5);
      } else {
        const result = await running;
        assert.equal(result.manifest_retries, 1);
        assert.equal(lastManifest.private_root.version, 2);
        assert.equal(lastManifest.entries['MLU1:0'].private_history.value, 'keep-2');
        assert.equal(lastMetadata.owner, 'owner-2');
        assert.equal(lastMetadata.cover_index_v1, result.public_index.hash);
        assert.equal(puts, 2);
        assert.equal(reads, 2);
      }
    }
    console.log('released failed graphs; success and retry exhaustion preserved');
  `;
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
