import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    COVER_INDEX_METADATA, COVER_INDEX_PREFIX, coverIndexHash, coverShard,
    prepareCoverIndex, readCoverIndex,
} from '../_shared/cover-public-index.js';
import { findPreviewCover } from '../_shared/preview-cover.js';
import { onRequest as stableCoverRequest } from '../book-cover/[[path]].js';
import { CATALOG_URL } from '../_shared/catalog.js';
import { COVER_MANIFEST_KEY, syncCoverMirror } from '../../worker-sync/cover-mirror.js';

const NOW = '2026-09-08T12:00:00.000Z';
const encoder = new TextEncoder();
const clone = value => structuredClone(value);
const rootKey = hash => `${COVER_INDEX_PREFIX}roots/${hash}.json`;
const shardKey = hash => `${COVER_INDEX_PREFIX}shards/${hash}.json`;

// Content ETags, metadata snapshots and conditional writes model the contract
// that joins the public tree to its authoritative manifest in one R2 PUT.
class MetadataR2 {
    constructor(manifest = { schema_version: 1, updated_at: NOW, entries: {} }) {
        this.records = new Map();
        this.gets = [];
        this.heads = [];
        this.puts = [];
        this.beforeManifestPut = null;
        this.afterHead = null;
        this.failPrefix = null;
        this.seed(COVER_MANIFEST_KEY, JSON.stringify(manifest), { owner: 'existing-metadata' });
    }
    seed(key, body, customMetadata = {}) {
        const bytes = typeof body === 'string' ? encoder.encode(body) : new Uint8Array(body);
        this.records.set(key, { bytes: bytes.slice(), customMetadata: clone(customMetadata),
            etag: createHash('md5').update(bytes).digest('hex') });
    }
    info(key) {
        const record = this.records.get(key);
        return record && { size: record.bytes.byteLength, etag: record.etag,
            customMetadata: clone(record.customMetadata) };
    }
    async head(key) {
        this.heads.push(key);
        const value = this.info(key) || null;
        if (this.afterHead) {
            const fn = this.afterHead;
            this.afterHead = null;
            await fn(key);
        }
        return value;
    }
    async get(key) {
        this.gets.push(key);
        const record = this.records.get(key);
        if (!record) return null;
        const bytes = record.bytes.slice();
        return { ...this.info(key), body: new Response(bytes).body,
            text: async () => new TextDecoder().decode(bytes) };
    }
    async put(key, body, options = {}) {
        this.puts.push({ key, options: clone(options) });
        if (this.failPrefix && key.startsWith(this.failPrefix)) return null;
        if (key === COVER_MANIFEST_KEY && this.beforeManifestPut) {
            const fn = this.beforeManifestPut;
            this.beforeManifestPut = null;
            await fn();
        }
        const record = this.records.get(key);
        if (options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== record?.etag) return null;
        if (options.onlyIf?.etagDoesNotMatch === '*' && record) return null;
        this.seed(key, body, options.customMetadata || {});
        return this.info(key);
    }
    json(key = COVER_MANIFEST_KEY) {
        return JSON.parse(new TextDecoder().decode(this.records.get(key).bytes));
    }
    resetCalls() { this.gets = []; this.heads = []; this.puts = []; }
}

function entry(id = 'MLU100', letter = 'a', position = 0) {
    const sha = letter.repeat(64);
    return { product_id: id, position, last_validated_at: NOW,
        source_policy_version: 1, native_checked_at: NOW,
        source_probes: [{ diagnostic: 'private-only' }],
        current: { object_key: `covers/v1/objects/${sha}.jpg`, sha256: sha, mime: 'image/jpeg',
            source_url: `https://http2.mlstatic.com/${id}-${position}-O.jpg`,
            width: 800, height: 1200, bytes: 1234, private_note: 'must-not-leak' } };
}
function manifest(...rows) {
    return { schema_version: 1, updated_at: NOW,
        entries: Object.fromEntries(rows.map(row => [`${row.product_id}:${row.position}`, row])) };
}
function context(bucket) {
    return { request: new Request('https://example.test/catalogo'),
        env: { APP_ENV: 'production', COVER_R2: bucket }, data: {} };
}
async function publish(bucket, source, previous = null) {
    const result = await prepareCoverIndex(bucket, source, previous);
    bucket.seed(COVER_MANIFEST_KEY, JSON.stringify(source), {
        owner: 'existing-metadata', [COVER_INDEX_METADATA]: result.hash,
    });
    return result;
}
async function seedHashed(bucket, kind, object) {
    const text = JSON.stringify(object);
    const hash = await coverIndexHash(text);
    bucket.seed(`${COVER_INDEX_PREFIX}${kind}/${hash}.json`, text);
    return { hash, bytes: encoder.encode(text).byteLength };
}
function png() {
    const bytes = new Uint8Array(45);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, 800); view.setUint32(20, 1200);
    bytes.set([73, 69, 78, 68], 37);
    return bytes;
}
function catalogItem(id = 'MLU200') {
    return { id, status: 'active', available_quantity: 1, price: 1000, currency_id: 'UYU',
        domain_id: 'MLU-BOOKS', pictures: [`https://http2.mlstatic.com/${id}-O.jpg`] };
}
const syncOptions = { now: () => new Date(NOW),
    fetchFn: async () => new Response(png(), { headers: { 'content-type': 'image/png' } }) };

// This is a real sync execution: the losing write has already processed MLU200
// before another execution updates MLU100 and discovers MLU300.
test('cover index: CAS retry recomputes the complete projection from the winning manifest', async () => {
    const initial = manifest(entry());
    const bucket = new MetadataR2(initial);
    const old = await publish(bucket, initial);
    bucket.beforeManifestPut = async () => {
        const winner = manifest(entry('MLU100', 'b'), entry('MLU300', 'c'));
        winner.updated_at = '2026-09-08T12:01:00.000Z';
        await publish(bucket, winner, old.hash);
    };
    const result = await syncCoverMirror({ COVER_R2: bucket }, { items: [catalogItem()] }, syncOptions);
    assert.equal(result.manifest_retries, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.imported, 1);
    const source = bucket.json();
    const indexed = await readCoverIndex(bucket, ['MLU100', 'MLU200', 'MLU300']);
    assert.deepEqual(Object.keys(indexed.entries).sort(), Object.keys(source.entries).sort());
    for (const [key, row] of Object.entries(source.entries)) {
        assert.equal(indexed.entries[key].current.sha256, row.current.sha256, key);
    }
    assert.equal(indexed.entries['MLU100:0'].current.sha256, 'b'.repeat(64));
    assert.equal(indexed.entries['MLU300:0'].current.sha256, 'c'.repeat(64));
    assert.equal(bucket.info(COVER_MANIFEST_KEY).customMetadata.owner, 'existing-metadata');
    assert.equal(result.public_index.hash, bucket.info(COVER_MANIFEST_KEY).customMetadata[COVER_INDEX_METADATA]);
});

for (const kind of ['shards', 'roots']) {
    test(`cover index: ${kind} upload failure preserves authoritative body and pointer`, async () => {
        const initial = manifest(entry());
        const bucket = new MetadataR2(initial);
        const old = await publish(bucket, initial);
        const before = clone(bucket.records.get(COVER_MANIFEST_KEY));
        bucket.resetCalls();
        bucket.failPrefix = `${COVER_INDEX_PREFIX}${kind}/`;
        await assert.rejects(syncCoverMirror({ COVER_R2: bucket }, { items: [catalogItem()] }, syncOptions),
            new RegExp(`cover-index-${kind === 'roots' ? 'root' : 'shard'}-write-failed`));
        assert.deepEqual(bucket.records.get(COVER_MANIFEST_KEY), before);
        assert.equal(bucket.puts.filter(row => row.key === COVER_MANIFEST_KEY).length, 0);
        assert.equal((await readCoverIndex(bucket, ['MLU100'])).read_stats.root, old.hash);
    });
}

test('cover index: empty image batch bootstraps existing images and preserves metadata', async () => {
    const initial = manifest(entry(), entry('MLU200', 'b', 15));
    const bucket = new MetadataR2(initial);
    const result = await syncCoverMirror({ COVER_R2: bucket }, { items: [] }, syncOptions);
    assert.equal(result.attempted, 0);
    assert.equal(result.public_index.entries, 2);
    assert.equal(bucket.info(COVER_MANIFEST_KEY).customMetadata.owner, 'existing-metadata');
    assert.deepEqual(bucket.json().entries, initial.entries);
    assert.equal((await readCoverIndex(bucket, ['MLU100', 'MLU200'])).read_stats.entries_retained, 2);
    bucket.resetCalls();
    const noOp = await syncCoverMirror({ COVER_R2: bucket }, { items: [] }, syncOptions);
    assert.equal(noOp.public_index, null);
    assert.ok(bucket.puts.every(row => row.key !== COVER_MANIFEST_KEY && !row.key.startsWith(COVER_INDEX_PREFIX)));
});

test('cover index: a genuinely empty manifest has a usable empty index', async () => {
    const bucket = new MetadataR2();
    await syncCoverMirror({ COVER_R2: bucket }, { items: [] }, syncOptions);
    const indexed = await readCoverIndex(bucket, ['MLU100']);
    assert.equal(indexed.read_stats.mode, 'public-index');
    assert.deepEqual(indexed.entries, {});
});

test('cover index: an old HEAD retains a complete immutable view during concurrent publication', async () => {
    const first = manifest(entry());
    const second = manifest(entry('MLU100', 'b'));
    const bucket = new MetadataR2(first);
    const old = await publish(bucket, first);
    bucket.afterHead = async key => {
        assert.equal(key, COVER_MANIFEST_KEY);
        await publish(bucket, second, old.hash);
    };
    const inFlight = await readCoverIndex(bucket, ['MLU100']);
    assert.equal(inFlight.entries['MLU100:0'].current.sha256, 'a'.repeat(64));
    const next = await readCoverIndex(bucket, ['MLU100']);
    assert.equal(next.entries['MLU100:0'].current.sha256, 'b'.repeat(64));
    assert.notEqual(next.read_stats.root, inFlight.read_stats.root);
});

test('cover index: healthy batched reads use no manifest body and disclose no private history', async () => {
    const source = manifest(entry(), entry('MLU100', 'b', 15), entry('MLU200', 'c'));
    const bucket = new MetadataR2(source);
    await publish(bucket, source);
    bucket.resetCalls();
    const ctx = context(bucket);
    const [primary, gallery, other] = await Promise.all([
        findPreviewCover(ctx, 'MLU100'), findPreviewCover(ctx, 'MLU100', 15), findPreviewCover(ctx, 'MLU200'),
    ]);
    assert.ok(primary && gallery && other);
    assert.equal(ctx.data.coverIndex.mode, 'public-index');
    assert.equal(bucket.gets.includes(COVER_MANIFEST_KEY), false);
    assert.deepEqual(bucket.heads, [COVER_MANIFEST_KEY]);
    assert.equal(bucket.gets.filter(key => key.includes('/roots/')).length, 1);
    assert.equal(primary.entry.source_probes, undefined);
    assert.equal(primary.entry.current.private_note, undefined);
});

const corruptions = [
    ['missing metadata', async bucket => {
        const source = bucket.json(); bucket.seed(COVER_MANIFEST_KEY, JSON.stringify(source));
    }, 'cover-index-not-published'],
    ['malformed root hash', async bucket => {
        bucket.seed(COVER_MANIFEST_KEY, JSON.stringify(bucket.json()), { [COVER_INDEX_METADATA]: '../escape' });
    }, 'cover-index-not-published'],
    ['missing root', async (bucket, root) => { bucket.records.delete(rootKey(root.hash)); }, 'cover-index-missing-roots'],
    ['corrupt root bytes', async (bucket, root) => { bucket.seed(rootKey(root.hash), '{}'); }, 'cover-index-integrity-failed'],
    ['unsupported root schema with valid hash', async bucket => {
        const invalid = await seedHashed(bucket, 'roots', { schema_version: 2, shard_count: 256, shards: {} });
        bucket.seed(COVER_MANIFEST_KEY, JSON.stringify(bucket.json()), { [COVER_INDEX_METADATA]: invalid.hash });
    }, 'cover-index-invalid-root'],
    ['missing shard', async (bucket, root) => {
        const descriptor = bucket.json(rootKey(root.hash)).shards[coverShard('MLU100')];
        bucket.records.delete(shardKey(descriptor.sha256));
    }, 'cover-index-missing-shards'],
    ['corrupt shard bytes', async (bucket, root) => {
        const descriptor = bucket.json(rootKey(root.hash)).shards[coverShard('MLU100')];
        bucket.seed(shardKey(descriptor.sha256), '{}');
    }, 'cover-index-integrity-failed'],
    ['unsupported shard schema with valid hash', async (bucket, root) => {
        const id = coverShard('MLU100');
        const changed = bucket.json(rootKey(root.hash));
        const shard = await seedHashed(bucket, 'shards', { schema_version: 2, shard: id, entries: { 'MLU100:0': entry() } });
        changed.shards[id] = { sha256: shard.hash, bytes: shard.bytes, entries: 1 };
        const invalid = await seedHashed(bucket, 'roots', changed);
        bucket.seed(COVER_MANIFEST_KEY, JSON.stringify(bucket.json()), { [COVER_INDEX_METADATA]: invalid.hash });
    }, 'cover-index-invalid-shard'],
];
for (const [label, corrupt, reason] of corruptions) {
    test(`cover index: ${label} produces an explicit legacy fallback, preserving the image`, async () => {
        const source = manifest(entry());
        const bucket = new MetadataR2(source);
        const root = await publish(bucket, source);
        await corrupt(bucket, root);
        bucket.resetCalls();
        const ctx = context(bucket);
        const cover = await findPreviewCover(ctx, 'MLU100');
        assert.equal(cover?.sha256, 'a'.repeat(64));
        assert.equal(ctx.data.coverIndex.mode, 'legacy-fallback');
        assert.equal(ctx.data.coverIndex.reason, reason);
        assert.equal(bucket.gets.filter(key => key === COVER_MANIFEST_KEY).length, 1);
    });
}

test('cover index: source mismatch and untrusted URL still reject the stored master', async () => {
    const source = manifest(entry());
    const bucket = new MetadataR2(source);
    await publish(bucket, source);
    assert.ok(await findPreviewCover(context(bucket), 'MLU100', 0, entry().current.source_url));
    assert.equal(await findPreviewCover(context(bucket), 'MLU100', 0, 'https://http2.mlstatic.com/replaced-O.jpg'), null);
    assert.equal(await findPreviewCover(context(bucket), 'MLU100', 0, 'https://evil.test/cover.jpg'), null);
});

for (const [label, change] of [
    ['MIME mismatch', row => { row.current.mime = 'image/png'; }],
    ['digest mismatch', row => { row.current.sha256 = 'b'.repeat(64); }],
    ['malformed object hash', row => { row.current.object_key = 'covers/v1/objects/not-a-hash.jpg'; }],
    ['out-of-prefix object', row => { row.current.object_key = `private/${'a'.repeat(64)}.jpg`; }],
]) {
    test(`cover index: ${label} remains invalid for consumers`, async () => {
        const row = entry(); change(row);
        const source = manifest(row);
        const bucket = new MetadataR2(source);
        await publish(bucket, source);
        const ctx = context(bucket);
        assert.equal(await findPreviewCover(ctx, 'MLU100'), null);
        assert.equal(ctx.data.coverIndex.mode, 'public-index');
    });
}

test('cover index: malformed product or position causes no R2 reads', async () => {
    const bucket = new MetadataR2(manifest(entry()));
    for (const [id, position] of [['MLU100', -1], ['MLU100', 16], ['MLU100', 1.5], ['MLU100', '0'], ['../MLU100', 0]]) {
        assert.equal(await findPreviewCover(context(bucket), id, position), null);
    }
    assert.equal(bucket.gets.length, 0);
    assert.equal(bucket.heads.length, 0);
});

test('cover index: diagnostic-only changes reuse the entire public tree without PUTs', async () => {
    const source = manifest(entry(), entry('MLU200', 'b'));
    const bucket = new MetadataR2(source);
    const old = await publish(bucket, source);
    const changed = clone(source);
    changed.updated_at = '2026-09-09T00:00:00.000Z';
    changed.entries['MLU100:0'].source_probes.push({ new_private_diagnostic: true });
    bucket.resetCalls();
    const prepared = await prepareCoverIndex(bucket, changed, old.hash);
    assert.equal(prepared.hash, old.hash);
    assert.equal(prepared.shards_written, 0);
    assert.deepEqual(bucket.puts, []);
});

test('cover index: changing one master writes only its shard and a new root', async () => {
    assert.notEqual(coverShard('MLU100'), coverShard('MLU200'));
    const source = manifest(entry(), entry('MLU200', 'b'));
    const bucket = new MetadataR2(source);
    const old = await publish(bucket, source);
    const changed = manifest(entry('MLU100', 'c'), entry('MLU200', 'b'));
    bucket.resetCalls();
    const prepared = await prepareCoverIndex(bucket, changed, old.hash);
    assert.equal(prepared.shards_written, 1);
    assert.equal(bucket.puts.filter(row => row.key.includes('/shards/')).length, 1);
    assert.equal(bucket.puts.filter(row => row.key.includes('/roots/')).length, 1);
    // Preparation alone may not change the live manifest pointer.
    assert.equal(bucket.info(COVER_MANIFEST_KEY).customMetadata[COVER_INDEX_METADATA], old.hash);
});

for (const corruption of ['deleted', 'corrupt']) {
    test(`cover index: daily empty-batch rebuild repairs an unchanged ${corruption} shard`, async () => {
        const source = manifest(entry(), entry('MLU200', 'b'));
        const bucket = new MetadataR2(source);
        await syncCoverMirror({ COVER_R2: bucket }, { items: [] }, syncOptions);
        const initialMetadata = bucket.info(COVER_MANIFEST_KEY).customMetadata;
        assert.equal(initialMetadata.cover_index_refreshed_at, NOW);
        const originalRoot = initialMetadata[COVER_INDEX_METADATA];
        const descriptor = bucket.json(rootKey(originalRoot)).shards[coverShard('MLU100')];
        const damagedKey = shardKey(descriptor.sha256);
        if (corruption === 'deleted') bucket.records.delete(damagedKey);
        else bucket.seed(damagedKey, '{}');
        const damagedCtx = context(bucket);
        assert.ok(await findPreviewCover(damagedCtx, 'MLU100'));
        assert.equal(damagedCtx.data.coverIndex.mode, 'legacy-fallback');

        // Before the exact 24 h boundary a no-op must not continually postpone
        // the scheduled repair by refreshing the timestamp without rebuilding.
        const notDue = await syncCoverMirror({ COVER_R2: bucket }, { items: [] }, {
            ...syncOptions, now: () => new Date('2026-09-09T11:59:59.999Z'),
        });
        assert.equal(notDue.public_index, null);
        assert.equal(bucket.info(COVER_MANIFEST_KEY).customMetadata.cover_index_refreshed_at, NOW);

        const dueAt = '2026-09-09T12:00:00.000Z';
        bucket.resetCalls();
        const repaired = await syncCoverMirror({ COVER_R2: bucket }, { items: [] }, {
            ...syncOptions, now: () => new Date(dueAt),
        });
        assert.equal(repaired.attempted, 0);
        assert.equal(repaired.public_index.hash, originalRoot);
        assert.equal(repaired.public_index.shards_written, repaired.public_index.shards);
        assert.ok(bucket.puts.some(row => row.key === damagedKey));
        assert.equal(bucket.info(COVER_MANIFEST_KEY).customMetadata.cover_index_refreshed_at, dueAt);
        assert.deepEqual(bucket.json().entries, source.entries);

        bucket.resetCalls();
        const healthyCtx = context(bucket);
        assert.equal((await findPreviewCover(healthyCtx, 'MLU100')).sha256, 'a'.repeat(64));
        assert.equal(healthyCtx.data.coverIndex.mode, 'public-index');
        assert.equal(bucket.gets.includes(COVER_MANIFEST_KEY), false);
    });
}

test('cover index: ordinary image batches do not postpone the daily complete rebuild', async () => {
    const source = manifest(entry());
    const bucket = new MetadataR2(source);
    await syncCoverMirror({ COVER_R2: bucket }, { items: [] }, syncOptions);
    const initialRoot = bucket.info(COVER_MANIFEST_KEY).customMetadata[COVER_INDEX_METADATA];
    const ordinary = await syncCoverMirror({ COVER_R2: bucket }, { items: [catalogItem()] }, {
        ...syncOptions, now: () => new Date('2026-09-09T00:00:00.000Z'),
    });
    assert.equal(ordinary.imported, 1);
    assert.notEqual(ordinary.public_index.hash, initialRoot);
    assert.equal(bucket.info(COVER_MANIFEST_KEY).customMetadata.cover_index_refreshed_at, NOW);
    const dueAt = '2026-09-09T12:00:00.000Z';
    const daily = await syncCoverMirror({ COVER_R2: bucket }, { items: [] }, {
        ...syncOptions, now: () => new Date(dueAt),
    });
    assert.equal(daily.attempted, 0);
    assert.ok(daily.public_index);
    assert.equal(daily.public_index.shards_written, daily.public_index.shards);
    assert.equal(bucket.info(COVER_MANIFEST_KEY).customMetadata.cover_index_refreshed_at, dueAt);
});

test('cover index: stable route updates telemetry on cached bytes after fallback, including bodyless HEAD', async t => {
    const cachesDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'caches');
    const originalFetch = globalThis.fetch;
    t.after(() => {
        if (cachesDescriptor) Object.defineProperty(globalThis, 'caches', cachesDescriptor);
        else delete globalThis.caches;
        globalThis.fetch = originalFetch;
    });
    const storedResponses = new Map();
    const cache = {
        async match(request) { return storedResponses.get(request.url)?.clone(); },
        async put(request, response) {
            const bytes = await response.arrayBuffer();
            storedResponses.set(request.url, new Response(bytes, { status: response.status, headers: response.headers }));
        },
    };
    Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: cache } });
    globalThis.fetch = async () => { throw new Error('Integration test must never use a network fallback'); };
    const imageBytes = png();
    const digest = createHash('sha256').update(imageBytes).digest('hex');
    const row = entry();
    row.current = { ...row.current, sha256: digest, object_key: `covers/v1/objects/${digest}.png`, mime: 'image/png' };
    const source = manifest(row);
    const bucket = new MetadataR2(source);
    bucket.seed(row.current.object_key, imageBytes);
    await publish(bucket, source);
    await cache.put(new Request(CATALOG_URL), Response.json({ items: [{
        id: 'MLU100', status: 'active', available_quantity: 1, pictures: [row.current.source_url],
    }] }));
    async function invoke(method = 'GET') {
        const pending = [];
        const ctx = { request: new Request('https://example.test/book-cover/MLU100/cover.jpg', { method }),
            params: { path: ['MLU100', 'cover.jpg'] }, env: { APP_ENV: 'production', COVER_R2: bucket },
            data: {}, waitUntil: promise => pending.push(promise) };
        const response = await stableCoverRequest(ctx);
        const bytes = new Uint8Array(await response.arrayBuffer());
        await Promise.all(pending);
        return { response, bytes, ctx };
    }
    bucket.resetCalls();
    const first = await invoke();
    assert.equal(first.response.status, 200);
    assert.equal(first.response.headers.get('x-cover-index'), 'public-index');
    assert.equal(first.response.headers.get('x-cover-source'), 'r2-production');
    assert.deepEqual(first.bytes, imageBytes);
    assert.equal(bucket.gets.filter(key => key === row.current.object_key).length, 1);
    assert.equal(bucket.gets.includes(COVER_MANIFEST_KEY), false);

    const imageCacheUrl = `https://example.test/book-cover/MLU100/cover.jpg?master=${digest}`;
    assert.ok(storedResponses.has(imageCacheUrl), 'Actual stable handler must have cached the master bytes');
    // Also exercise an already cached response containing old telemetry. The
    // per-request observation must overwrite it instead of trusting its age.
    storedResponses.get(imageCacheUrl).headers.set('x-cover-index', 'public-index');
    bucket.seed(COVER_MANIFEST_KEY, JSON.stringify(source), { owner: 'existing-metadata' });
    bucket.resetCalls();
    const fallback = await invoke();
    assert.equal(fallback.response.status, 200);
    assert.equal(fallback.response.headers.get('x-cover-index'), 'legacy-fallback');
    assert.equal(fallback.ctx.data.coverIndex.reason, 'cover-index-not-published');
    assert.deepEqual(fallback.bytes, imageBytes);
    assert.equal(bucket.gets.filter(key => key === COVER_MANIFEST_KEY).length, 1);
    assert.equal(bucket.gets.includes(row.current.object_key), false, 'Fallback request must reuse cached image bytes');

    bucket.resetCalls();
    const head = await invoke('HEAD');
    assert.equal(head.response.status, 200);
    assert.equal(head.response.headers.get('x-cover-index'), 'legacy-fallback');
    assert.equal(head.response.headers.get('etag'), `"${digest}"`);
    assert.equal(head.bytes.byteLength, 0);
    assert.equal(bucket.gets.includes(row.current.object_key), false);
});
