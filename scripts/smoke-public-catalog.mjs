import assert from 'node:assert/strict';

const base = process.env.SMOKE_BASE_URL || 'https://www.amadolibros.com';
const url = new URL('/api/catalogo-publico', base);
const expectedKeys = ['id', 'title', 'author', 'isbn', 'price', 'currency', 'stock', 'availability', 'url'].sort();

for (let attempt = 1; attempt <= 6; attempt++) {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
        assert.equal(response.status, 200, `HTTP ${response.status}`);
        assert.match(response.headers.get('content-type') || '', /application\/json/);
        const data = await response.json();
        assert.equal(data.schema_version, 1);
        assert.equal(data.complete, true);
        assert.ok(data.catalog_version);
        assert.ok(Array.isArray(data.items));
        assert.equal(data.total, data.items.length);
        assert.ok(data.total > 0, 'Production catalog is unexpectedly empty');
        const counts = { in_stock: 0, on_request: 0 };
        const seen = new Set();
        for (const item of data.items) {
            assert.deepEqual(Object.keys(item).sort(), expectedKeys);
            assert.ok(!seen.has(item.id));
            seen.add(item.id);
            assert.match(item.id, /^MLU\d+$/);
            assert.ok(item.title);
            assert.equal(item.currency, 'UYU');
            assert.match(item.url, /^https:\/\/www\.amadolibros\.com\/libro\/MLU\d+\//);
            assert.ok(Object.hasOwn(counts, item.availability));
            counts[item.availability]++;
            if (item.availability === 'on_request') {
                assert.equal(item.price, null);
                assert.equal(item.stock, 0);
            } else {
                assert.ok(Number.isFinite(item.price) && item.price > 0);
                assert.ok(Number.isInteger(item.stock) && item.stock > 0);
            }
        }
        assert.deepEqual(data.counts, counts);
        console.log(JSON.stringify({ url: url.href, version: data.catalog_version, total: data.total, counts, result: 'ok' }));
        break;
    } catch (error) {
        if (attempt === 6) throw error;
        console.log(`Catalog not ready (${attempt}/6): ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
}
