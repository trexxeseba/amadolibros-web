import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { streamCoverManifest } from '../_shared/cover-manifest-stream.js';
import { previewCoverUrl } from '../_shared/preview-cover.js';
import { onRequest } from '../preview-cover/[[path]].js';

const hash = 'a'.repeat(64);
const source = 'https://http2.mlstatic.com/D_123-MLU123_012026-O.jpg';
const entry = id => ({ product_id: id, position: 0, source_probes: [{ text: 'unused diagnostic' }], current: {
    sha256: hash, object_key: `covers/v1/objects/${hash}.jpg`, mime: 'image/jpeg',
    source_url: source, width: 1200, height: 1500, bytes: 3,
} });
const fixture = () => ({ schema_version: 1, entries: { 'MLU1:0': entry('MLU1'), 'MLU2:0': entry('MLU2') } });

test.beforeEach(() => { delete globalThis.caches; });

test('stream keeps only requested products and no diagnostic history', async () => {
    const parsed = await streamCoverManifest(new Response(JSON.stringify(fixture())), { productIds: ['MLU2'] });
    assert.deepEqual(Object.keys(parsed.entries), ['MLU2:0']);
    assert.deepEqual(parsed.entries['MLU2:0'].current, entry('MLU2').current);
    assert.equal(parsed.entries['MLU2:0'].source_probes, undefined);
    assert.equal(parsed.read_stats.entries_scanned, 2);
});

test('stream handles split UTF-8 and escaped strings', async () => {
    const data = fixture();
    data.entries['MLU1:0'].current.source_url = 'á💡"\\';
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    let offset = 0;
    const body = new ReadableStream({ pull(controller) {
        if (offset === bytes.length) controller.close();
        else controller.enqueue(bytes.slice(offset, ++offset));
    } });
    const result = await streamCoverManifest({ body });
    assert.equal(result.entries['MLU1:0'].current.source_url, 'á💡"\\');
});

test('malformed, truncated, extra JSON and invalid schema fail closed', async () => {
    for (const value of ['{"schema_version":1,"entries":{', JSON.stringify(fixture()) + '{}',
        '{"schema_version":2,"entries":{}}', '{"schema_version":1,"entries":[]}', '{}', 'null']) {
        await assert.rejects(() => streamCoverManifest(new Response(value)), value);
    }
});

test('empty entries remain a valid empty manifest', async () => {
    const result = await streamCoverManifest(new Response('{"schema_version":1,"entries":{}}'));
    assert.equal(result.read_stats.entries_retained, 0);
});

test('large R2 objects cannot silently fall back to text()', async () => {
    let read = false;
    await assert.rejects(() => streamCoverManifest({ size: 60_000_000, text() { read = true; return '{}'; } }));
    assert.equal(read, false);
});

test('a grid batches requested products into one streaming read', async () => {
    let reads = 0;
    const ctx = { request: new Request('https://example.test/catalogo'), data: {}, env: {
        APP_ENV: 'production', COVER_R2: { async get() { reads++; return new Response(JSON.stringify(fixture())); } },
    } };
    const urls = await Promise.all(['MLU1', 'MLU2'].map(id => previewCoverUrl(ctx, id, 0, source)));
    assert.ok(urls.every(Boolean));
    assert.equal(reads, 1);
    assert.equal(await previewCoverUrl(ctx, 'MLU1', 0, source), urls[0]);
    assert.equal(reads, 1);
});

test('later products in the same request are resolved, not incorrectly reported missing', async () => {
    let reads = 0;
    const ctx = { request: new Request('https://example.test/catalogo'), data: {}, env: {
        APP_ENV: 'production', COVER_R2: { async get() { reads++; return new Response(JSON.stringify(fixture())); } },
    } };
    assert.ok(await previewCoverUrl(ctx, 'MLU1', 0, source));
    assert.ok(await previewCoverUrl(ctx, 'MLU2', 0, source));
    assert.equal(reads, 2);
});

test('an immutable image works even if the global manifest cannot be read', async () => {
    const reads = [];
    const ctx = { request: new Request('https://example.test/image'), params: { path: ['MLU1', '0', `${hash}.jpg`] }, env: {
        APP_ENV: 'production', COVER_R2: { async get(key) {
            reads.push(key);
            assert.equal(key, `covers/v1/objects/${hash}.jpg`);
            return { body: new Uint8Array([1, 2, 3]), size: 3 };
        } },
    } };
    const response = await onRequest(ctx);
    assert.equal(response.status, 200);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
    assert.equal(reads.length, 1);
});

test('invalid immutable paths never access R2', async () => {
    for (const path of [['no-id', '0', `${hash}.jpg`], ['MLU1', '16', `${hash}.jpg`],
        ['MLU1', '-1', `${hash}.jpg`], ['MLU1', '', `${hash}.jpg`], ['MLU1', '0', '../manifest.json']]) {
        const response = await onRequest({ request: new Request('https://example.test/image'), params: { path },
            env: { APP_ENV: 'production', COVER_R2: { get() { throw new Error('must not read'); } } } });
        assert.equal(response.status, 404);
    }
});

test('65 MB manifest is processed under a 64 MB JS heap with only one retained entry', () => {
    const script = `
        import { streamCoverManifest } from './functions/_shared/cover-manifest-stream.js';
        let n = 0; const total = 65000;
        const body = new ReadableStream({ pull(c) {
            if (n === 0) { c.enqueue(new TextEncoder().encode('{"schema_version":1,"entries":{')); n++; return; }
            if (n <= total) {
                const id = n++; const prefix = id === 1 ? '' : ',';
                const record = {product_id:'MLU'+id,current:{width:1200},history:'x'.repeat(1000)};
                c.enqueue(new TextEncoder().encode(prefix+'"MLU'+id+':0":'+JSON.stringify(record))); return;
            }
            if (n++ === total + 1) c.enqueue(new TextEncoder().encode('}}')); else c.close();
        } });
        const result = await streamCoverManifest({body},{productIds:['MLU1']});
        console.log(JSON.stringify(result.read_stats));
    `;
    const result = spawnSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', script], {
        cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const stats = JSON.parse(result.stdout);
    assert.ok(stats.bytes > 65_000_000);
    assert.equal(stats.entries_scanned, 65000);
    assert.equal(stats.entries_retained, 1);
});
