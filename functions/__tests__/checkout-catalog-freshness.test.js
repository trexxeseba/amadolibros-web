import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG_URL, fetchCheckoutCatalog } from '../_shared/catalog.js';
import { createCartValidationHandler } from '../api/_cart_validation_handler.js';
import { validateCartAgainstCatalog } from '../api/_orders_logic.js';

test('carrito y cobro usan el alta vigente aunque el manifest histórico no la incluya', async () => {
  const previousFetch = globalThis.fetch;
  const previousCaches = globalThis.caches;
  const calls = [];
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async url => {
    calls.push(String(url));
    if (String(url) !== CATALOG_URL) throw new Error('No usar el índice histórico para cobrar');
    return Response.json({ updated_at: '2026-11-25T07:20:55.523Z', items: [
      { id: 'MLU1544936454', title: 'Despertando al gigante interior', status: 'active', price: 3999, currency: 'UYU', available_quantity: 1 },
      { id: 'MLU2', title: 'Recién agotado', status: 'paused', price: 1000, available_quantity: 0 },
      { id: 'MLU3', title: 'Otra moneda', status: 'active', price: 100, currency: 'USD', available_quantity: 1 },
    ] });
  };
  const items = [
    { product_id: 'MLU1544936454', quantity: 1, unit_price_uyu: 3999 },
    { product_id: 'MLU2', quantity: 1, unit_price_uyu: 1000 },
    { product_id: 'MLU3', quantity: 1, unit_price_uyu: 100 },
  ];
  const ctx = { env: { APP_ENV: 'production', WEB_PROMO_OFF: '1' }, waitUntil() {},
    request: new Request('https://www.amadolibros.com/api/cart/validate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }),
    }) };
  try {
    const catalog = await fetchCheckoutCatalog(ctx);
    const validated = validateCartAgainstCatalog(items, catalog.items);
    assert.deepEqual(validated.map(item => item.status), ['ok', 'sin_stock', 'moneda_no_admitida']);
    assert.equal(validated[0].price_uyu, 3999);
    assert.equal(validated[0].available_quantity, 1);
    const response = await createCartValidationHandler({ fetchCatalog: fetchCheckoutCatalog })(ctx);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).items, validated);
    assert.ok(calls.every(url => url === CATALOG_URL));
  } finally { globalThis.fetch = previousFetch; globalThis.caches = previousCaches; }
});

test('si falla la fuente vigente el checkout no recupera stock viejo ni simula agotados', async () => {
  const previousFetch = globalThis.fetch;
  const previousCaches = globalThis.caches;
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  try {
    const ctx = { env: { APP_ENV: 'production' }, waitUntil() {},
      request: new Request('https://www.amadolibros.com/api/cart/validate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ product_id: 'MLU1544936454', quantity: 1, unit_price_uyu: 3999 }] }),
      }) };
    const response = await createCartValidationHandler({ fetchCatalog: fetchCheckoutCatalog })(ctx);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'CATALOG_UNAVAILABLE');
  } finally { globalThis.fetch = previousFetch; globalThis.caches = previousCaches; }
});
