// Immutable, bounded public projection of the private cover manifest. The root
// hash is stored in the SAME conditional R2 PUT as the authoritative manifest.
export const COVER_INDEX_METADATA = 'cover_index_v1';
export const COVER_INDEX_PREFIX = 'covers/v1/public-index/';
export const COVER_INDEX_SHARDS = 256;
const HASH = /^[a-f0-9]{64}$/;
const ENTRY = /^(MLU\d+):(\d|1[0-5])$/;
const MAX_ROOT_BYTES = 128 * 1024;
const MAX_SHARD_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

export function coverShard(productId) {
    let hash = 2166136261;
    for (let i = 0; i < productId.length; i++) hash = Math.imul(hash ^ productId.charCodeAt(i), 16777619);
    return (hash >>> 0 & 255).toString(16).padStart(2, '0');
}

export async function coverIndexHash(text) {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function objectKey(kind, hash) {
    if (!HASH.test(hash)) throw new Error('cover-index-invalid-hash');
    return `${COVER_INDEX_PREFIX}${kind}/${hash}.json`;
}

function validRoot(root) {
    return root?.schema_version === 1 && root.shard_count === COVER_INDEX_SHARDS &&
        root.shards && typeof root.shards === 'object' && !Array.isArray(root.shards) &&
        Object.entries(root.shards).every(([id, row]) => /^[a-f0-9]{2}$/.test(id) &&
            HASH.test(row?.sha256) && Number.isInteger(row.entries) && row.entries > 0 &&
            Number.isInteger(row.bytes) && row.bytes > 0 && row.bytes <= MAX_SHARD_BYTES);
}

function publicEntry(value) {
    const current = value?.current;
    return { product_id: value?.product_id, position: value?.position,
        ...(current && typeof current === 'object' ? { current: {
            object_key: current.object_key, sha256: current.sha256, mime: current.mime,
            source_url: current.source_url, width: current.width, height: current.height, bytes: current.bytes,
        } } : {}) };
}

async function readHashed(bucket, kind, hash, { cache, origin, appEnv, waitUntil, stats } = {}) {
    const key = objectKey(kind, hash);
    const maxBytes = kind === 'roots' ? MAX_ROOT_BYTES : MAX_SHARD_BYTES;
    const cacheKey = origin ? new Request(new URL(`/__amado-cache/${key}?env=${encodeURIComponent(appEnv || '')}`, origin)) : null;
    // Cache failures must not turn a healthy R2 object into a legacy fallback.
    let cached = null;
    try { if (cacheKey) cached = await cache?.match?.(cacheKey); } catch { /* R2 below */ }
    let text;
    if (cached) text = await cached.text();
    else {
        const object = await bucket.get(key);
        if (!object) throw new Error(`cover-index-missing-${kind}`);
        if (Number(object.size) > maxBytes) throw new Error('cover-index-object-too-large');
        text = await object.text();
        if (stats) { stats.objects++; stats.bytes += encoder.encode(text).byteLength; }
    }
    if (encoder.encode(text).byteLength > maxBytes || await coverIndexHash(text) !== hash) {
        throw new Error('cover-index-integrity-failed');
    }
    const parsed = JSON.parse(text);
    if (!cached && cacheKey && cache?.put) {
        const put = cache.put(cacheKey, new Response(text, { headers: {
            'content-type': 'application/json', 'cache-control': 'public, max-age=31536000, immutable',
        } })).catch(() => {});
        if (waitUntil) waitUntil(put);
        else await put;
    }
    return parsed;
}

async function mapBounded(items, fn) {
    let cursor = 0;
    const result = new Array(items.length);
    await Promise.all(Array.from({ length: Math.min(8, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            result[index] = await fn(items[index]);
        }
    }));
    return result;
}

// Does not publish the pointer. A failed upload or a failed subsequent manifest
// CAS leaves readers on the complete previous immutable tree.
export async function prepareCoverIndex(bucket, manifest, previousHash = null) {
    let previous = null;
    if (HASH.test(previousHash || '')) {
        try {
            const root = await readHashed(bucket, 'roots', previousHash);
            if (validRoot(root)) previous = root;
        } catch { /* Rebuild the projection if the old index is absent/corrupt. */ }
    }
    const groups = new Map();
    for (const key of Object.keys(manifest.entries).sort()) {
        const match = ENTRY.exec(key);
        if (!match) continue;
        const id = coverShard(match[1]);
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(key);
    }
    let written = 0;
    let totalBytes = 0;
    const shards = await mapBounded([...groups].sort(([a], [b]) => a.localeCompare(b)), async ([id, keys]) => {
        // Hold only eight small projections concurrently, never a second copy
        // of the global manifest or its private probe/transform histories.
        const entries = Object.fromEntries(keys.map(key => [key, publicEntry(manifest.entries[key])]));
        const text = JSON.stringify({ schema_version: 1, shard: id, entries });
        const bytes = encoder.encode(text).byteLength;
        if (bytes > MAX_SHARD_BYTES) throw new Error(`cover-index-shard-too-large:${id}`);
        const sha256 = await coverIndexHash(text);
        if (previous?.shards[id]?.sha256 !== sha256) {
            const result = await bucket.put(objectKey('shards', sha256), text, {
                httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable' },
            });
            if (result === null) throw new Error('cover-index-shard-write-failed');
            written++;
        }
        totalBytes += bytes;
        return [id, { sha256, bytes, entries: keys.length }];
    });
    const root = { schema_version: 1, shard_count: COVER_INDEX_SHARDS, shards: Object.fromEntries(shards) };
    const text = JSON.stringify(root);
    const hash = await coverIndexHash(text);
    if (hash !== previousHash || !previous) {
        const result = await bucket.put(objectKey('roots', hash), text, {
            httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable' },
        });
        if (result === null) throw new Error('cover-index-root-write-failed');
    }
    return { hash, shards: shards.length, shards_written: written, bytes: totalBytes,
        entries: shards.reduce((sum, [, row]) => sum + row.entries, 0) };
}

export async function readCoverIndex(bucket, productIds, options = {}) {
    if (typeof bucket.head !== 'function') throw new Error('cover-index-head-unavailable');
    const head = await bucket.head('covers/v1/manifest.json');
    const hash = head?.customMetadata?.[COVER_INDEX_METADATA];
    if (!HASH.test(hash || '')) throw new Error('cover-index-not-published');
    const stats = { mode: 'public-index', root: hash, heads: 1, objects: 0, bytes: 0, entries_retained: 0 };
    const opts = { ...options, stats };
    const root = await readHashed(bucket, 'roots', hash, opts);
    if (!validRoot(root)) throw new Error('cover-index-invalid-root');
    const products = new Set(productIds);
    const ids = [...new Set([...products].map(coverShard))];
    const rows = await mapBounded(ids, async id => {
        const descriptor = root.shards[id];
        if (!descriptor) return [];
        const shard = await readHashed(bucket, 'shards', descriptor.sha256, opts);
        if (shard?.schema_version !== 1 || shard.shard !== id || !shard.entries ||
            typeof shard.entries !== 'object' || Array.isArray(shard.entries) ||
            Object.keys(shard.entries).length !== descriptor.entries) throw new Error('cover-index-invalid-shard');
        return Object.entries(shard.entries).filter(([key]) => {
            const match = ENTRY.exec(key);
            if (!match || coverShard(match[1]) !== id) throw new Error('cover-index-wrong-shard');
            return products.has(match[1]);
        });
    });
    const entries = Object.fromEntries(rows.flat());
    stats.entries_retained = Object.keys(entries).length;
    return { schema_version: 1, entries, read_stats: stats };
}
