import { perfNow, recordPerf } from './perf.js';

export const R2_BASE = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev';
export const CATALOG_URL = `${R2_BASE}/catalog.json`;
export const PAUSED_MANIFEST_URL = `${R2_BASE}/stock1-preview/manifest.json`;
export const BASE = 'https://www.amadolibros.com';

export function catalogUrlFor() {
    return CATALOG_URL;
}

async function fetchJsonCached(ctx, url, maxAge, timingName = 'catalog_fetch') {
    const cache = caches.default;
    const cacheKey = new Request(url);
    const cacheStartedAt = perfNow();
    let response = await cache.match(cacheKey);
    const cacheStatus = response ? 'hit' : 'miss';
    recordPerf(ctx, `${timingName}_cache`, cacheStartedAt, { cache: cacheStatus });
    if (!response) {
        const originStartedAt = perfNow();
        const fetched = await fetch(url);
        recordPerf(ctx, `${timingName}_origin`, originStartedAt);
        if (!fetched.ok) return null;
        response = new Response(fetched.body, {
            status: fetched.status,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': `public, max-age=${maxAge}`,
            },
        });
        if (typeof ctx?.waitUntil === 'function') {
            ctx.waitUntil(cache.put(cacheKey, response.clone()));
        }
    }
    try {
        const parseStartedAt = perfNow();
        const result = await response.json();
        recordPerf(ctx, `${timingName}_parse`, parseStartedAt);
        return result;
    } catch {
        return null;
    }
}

export async function fetchCatalog(ctx) {
    return fetchJsonCached(ctx, CATALOG_URL, 3600, 'catalog');
}

function isPreview(ctx) {
    return ctx?.env?.APP_ENV === 'preview';
}

function validDescriptor(value) {
    return value &&
        typeof value === 'object' &&
        typeof value.version === 'string' &&
        typeof value.index_key === 'string' &&
        typeof value.block_prefix === 'string' &&
        Number.isInteger(value.block_count) &&
        value.block_count >= 1;
}

function validActiveDescriptor(value) {
    return validDescriptor(value) &&
        typeof value.active_index_key === 'string' &&
        value.active_index_key.endsWith('/active-index.json');
}

async function fetchPausedManifest(ctx) {
    if (!isPreview(ctx)) return null;
    const manifest = await fetchJsonCached(ctx, PAUSED_MANIFEST_URL, 60, 'manifest');
    if (!manifest || manifest.schema_version !== 1 || !validDescriptor(manifest.current)) {
        return null;
    }
    return manifest;
}

function descriptorCandidates(manifest) {
    return [manifest?.current, manifest?.previous].filter(validDescriptor);
}

function expandPausedIndex(index) {
    const expectedFields = ['id', 'title', 'author', 'isbn', 'image'];
    if (!index || index.schema_version !== 1 || !Array.isArray(index.items)) return null;
    if (JSON.stringify(index.fields) !== JSON.stringify(expectedFields)) return null;
    if (index.derived_fields?.slug !== 'slugify-v1' ||
        index.derived_fields?.status !== 'paused' ||
        index.derived_fields?.block !== 'numeric-id-mod-block-count' ||
        !Number.isInteger(index.block_count)) return null;
    const items = [];
    for (const row of index.items) {
        if (!Array.isArray(row) || row.length !== expectedFields.length) return null;
        const [id, title, author, isbn, thumbnail] = row;
        if (!/^MLU\d+$/.test(id) || !title) return null;
        items.push({
            id,
            title,
            author: author || null,
            isbn: isbn || null,
            thumbnail: thumbnail || null,
            slug: slugify(title),
            status: 'paused',
            available_quantity: 0,
            paused_block: pausedBlockNumberForId(id, index.block_count),
        });
    }
    return items;
}

function expandActiveIndex(index) {
    const expectedFields = [
        'id',
        'title',
        'author',
        'isbn',
        'image',
        'price',
        'available_quantity',
    ];
    if (!index || index.schema_version !== 1 || !Array.isArray(index.items)) return null;
    if (JSON.stringify(index.fields) !== JSON.stringify(expectedFields)) return null;
    if (index.derived_fields?.slug !== 'slugify-v1' ||
        index.derived_fields?.status !== 'active') return null;
    const items = [];
    for (const row of index.items) {
        if (!Array.isArray(row) || row.length !== expectedFields.length) return null;
        const [id, title, author, isbn, thumbnail, price, availableQuantity] = row;
        if (!/^MLU\d+$/.test(id) || !title ||
            !Number.isFinite(Number(price)) ||
            !Number.isFinite(Number(availableQuantity)) ||
            Number(availableQuantity) <= 0) return null;
        items.push({
            id,
            title,
            author: author || null,
            isbn: isbn || null,
            thumbnail: thumbnail || null,
            price: Number(price),
            status: 'active',
            available_quantity: Number(availableQuantity),
            slug: slugify(title),
        });
    }
    return items;
}

function slugify(text) {
    return (text || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 60);
}

export async function fetchPausedIndex(ctx) {
    const manifest = await fetchPausedManifest(ctx);
    for (const descriptor of descriptorCandidates(manifest)) {
        const url = `${R2_BASE}/${descriptor.index_key}`;
        const index = await fetchJsonCached(ctx, url, 31536000, 'paused_index');
        const items = expandPausedIndex(index);
        if (items) return { version: descriptor.version, items };
    }
    return null;
}

export async function fetchActiveIndex(ctx) {
    const manifest = await fetchPausedManifest(ctx);
    for (const descriptor of descriptorCandidates(manifest).filter(validActiveDescriptor)) {
        const url = `${R2_BASE}/${descriptor.active_index_key}`;
        const index = await fetchJsonCached(ctx, url, 31536000, 'active_index');
        const items = expandActiveIndex(index);
        if (items) return { version: descriptor.version, items };
    }
    return null;
}

export function pausedBlockNumberForId(id, blockCount) {
    const digits = String(id || '').replace(/\D/g, '');
    if (!digits || !Number.isInteger(blockCount) || blockCount < 1) return 0;
    let remainder = 0;
    for (const digit of digits) remainder = ((remainder * 10) + Number(digit)) % blockCount;
    return remainder;
}

function blockFilename(block) {
    return `block-${String(block).padStart(3, '0')}.json`;
}

export async function fetchPausedItem(ctx, id) {
    const productId = String(id || '').toUpperCase();
    if (!isPreview(ctx) || !/^MLU\d+$/.test(productId)) return null;
    const manifest = await fetchPausedManifest(ctx);
    for (const descriptor of descriptorCandidates(manifest)) {
        const block = pausedBlockNumberForId(productId, descriptor.block_count);
        const url = `${R2_BASE}/${descriptor.block_prefix}/${blockFilename(block)}`;
        const payload = await fetchJsonCached(ctx, url, 31536000, 'paused_block');
        if (!payload || payload.schema_version !== 1 || !Array.isArray(payload.items)) continue;
        const item = payload.items.find(candidate => candidate?.id === productId);
        if (item?.status === 'paused') return item;
    }
    return null;
}
