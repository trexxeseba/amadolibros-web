import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicCatalogHandler } from '../catalogo-publico.js';
import { applyWebPromoToItems } from '../../_shared/web-promo.js';

const active = { version: 'v1', items: [
    { id: 'MLU1', title: 'Edición española', author: 'Autora', isbn: '9781234567897', price: 1500,
        available_quantity: 2, cost: 400, token: 'private', customer_email: 'private@example.test' },
    { id: 'MLU2', title: 'Otra oferta', isbn: '9781234567897', price: 1600, available_quantity: 1 },
] };
const paused = { version: 'v1', items: [
    { id: 'MLU3', title: 'Por encargo', price: 900, available_quantity: 7 },
    { id: 'MLU1', title: 'Duplicado pausado', price: 800 },
] };
const ctx = (method = 'GET') => ({ request: new Request('https://www.amadolibros.com/api/catalogo-publico', { method }), env: { APP_ENV: 'production' } });

test('exporta solo campos públicos y mantiene ofertas distintas sin sumar stock por ISBN', async () => {
    const response = await createPublicCatalogHandler({ loadActive: async () => active, loadPaused: async () => paused })(ctx());
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.complete, true);
    assert.equal(data.total, 3);
    assert.deepEqual(data.counts, { in_stock: 2, on_request: 1 });
    assert.deepEqual(data.items[0], { id: 'MLU1', title: 'Edición española', author: 'Autora', isbn: '9781234567897',
        price: 1500, currency: 'UYU', stock: 2, availability: 'in_stock', url: 'https://www.amadolibros.com/libro/MLU1/edicion-espanola' });
    assert.equal(data.items[2].price, null);
    assert.equal(data.items[2].stock, 0);
    assert.equal(data.items[2].availability, 'on_request');
    assert.doesNotMatch(JSON.stringify(data), /customer_email|private|token|cost/);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
});

test('respeta exactamente el precio web recibido, incluida una promoción vigente', async () => {
    const items = applyWebPromoToItems(active.items, { now: new Date('2026-11-05T12:00:00Z') });
    const response = await createPublicCatalogHandler({ loadActive: async () => ({ ...active, items }), loadPaused: async () => paused })(ctx());
    assert.equal((await response.json()).items[0].price, items[0].price);
    assert.equal(items[0].price, 1275);
});

test('fuentes caídas o versiones diferentes devuelven 503 sin publicar un catálogo parcial', async () => {
    for (const value of [null, { version: 'v2', items: [] }, { version: 'v1' }]) {
        const response = await createPublicCatalogHandler({ loadActive: async () => active, loadPaused: async () => value })(ctx());
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assert.equal((await response.json()).error, 'CATALOG_UNAVAILABLE');
    }
    const response = await createPublicCatalogHandler({ loadActive: async () => { throw new Error('down'); } })(ctx());
    assert.equal(response.status, 503);
});

test('es de lectura: rechaza escrituras sin consultar fuentes; admite OPTIONS y HEAD', async () => {
    const forbid = async () => { throw new Error('must not load'); };
    const blocked = createPublicCatalogHandler({ loadActive: forbid, loadPaused: forbid });
    assert.equal((await blocked(ctx('POST'))).status, 405);
    assert.equal((await blocked(ctx('OPTIONS'))).status, 204);
    const response = await createPublicCatalogHandler({ loadActive: async () => active, loadPaused: async () => paused })(ctx('HEAD'));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
});
