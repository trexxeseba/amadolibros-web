import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStorePrices, normalizeStoreCatalog } from '../_shared/store-price.js';

test('one public UYU price is used without changing the raw supplier snapshot', () => {
    const raw = { updated_at: 'today', items: [{id:'MLU653077561',price:1467.75,original_price:1957.5}, {id:'MLU2',price:185}] };
    const publicCatalog = normalizeStoreCatalog(raw);
    assert.equal(publicCatalog.items[0].price, 1468);
    assert.equal(publicCatalog.items[0].original_price, 1958);
    assert.equal(raw.items[0].price, 1467.75);
    assert.equal(publicCatalog.updated_at, raw.updated_at);
    assert.strictEqual(publicCatalog.items[1], raw.items[1]);
    assert.deepEqual(normalizeStoreCatalog(publicCatalog), publicCatalog);
});

test('foreign currency, unavailable data and invalid prices are not converted or fabricated', () => {
    const items = [{price:12.49,currency:'USD'}, {price:0}, {price:'invalid'}, null];
    assert.deepEqual(normalizeStorePrices(items), items);
    assert.equal(normalizeStoreCatalog(null), null);
    assert.deepEqual(normalizeStoreCatalog({error:true}), {error:true});
});
