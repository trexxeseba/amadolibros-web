import test from 'node:test';
import assert from 'node:assert/strict';
import { createCartValidationHandler } from '../_cart_validation_handler.js';

const CATALOG = { items: [
  { id: 'MLU1', title: 'Disponible', author: 'Autora', price: 1000, available_quantity: 2, status: 'active' },
  { id: 'MLU2', title: 'Agotado', author: 'Autor', price: 900, available_quantity: 0, status: 'paused' },
  { id: 'MLU3', title: 'Una unidad', author: '', price: 750, available_quantity: 1, status: 'active' },
  { id: 'MLU4', title: 'Precio en dólares', author: '', price: 285, currency: 'USD', available_quantity: 1, status: 'active' },
] };

function context(body, { method = 'POST', type = 'application/json', length } = {}) {
  const headers = { 'Content-Type': type };
  if (length !== undefined) headers['Content-Length'] = String(length);
  return {
    request: new Request('https://www.amadolibros.com/api/cart/validate', {
      method,
      headers,
      body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    }),
    env: { APP_ENV: 'production' },
    waitUntil() {},
  };
}

async function call(body, fetchCatalog = async () => CATALOG, options) {
  const handler = createCartValidationHandler({ fetchCatalog });
  const response = await handler(context(body, options));
  return { response, data: await response.json() };
}

test('devuelve estado individual y no bloquea los productos que siguen vendibles', async () => {
  const { response, data } = await call({ items: [
    { product_id: 'MLU1', quantity: 1, unit_price_uyu: 1000 },
    { product_id: 'MLU2', quantity: 1, unit_price_uyu: 900 },
    { product_id: 'MLU404', quantity: 1, unit_price_uyu: 800 },
  ] });
  assert.equal(response.status, 200);
  assert.deepEqual(data.items.map(item => item.status), ['ok', 'sin_stock', 'no_existe']);
  assert.equal(data.items[1].title, 'Agotado');
  assert.equal(data.has_blocking_items, true);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
});

test('bloquea moneda no-UYU aunque el producto siga activo y con stock', async () => {
  const { data } = await call({ items: [
    { product_id: 'MLU4', quantity: 1, unit_price_uyu: 285 },
  ] });
  assert.equal(data.items[0].status, 'moneda_no_admitida');
  assert.equal(data.items[0].currency, 'USD');
  assert.equal(data.has_blocking_items, true);
});

test('actualiza precio y reduce cantidad al stock vigente sin perder la venta', async () => {
  const { data } = await call({ items: [
    { product_id: 'MLU1', quantity: 1, unit_price_uyu: 850 },
    { product_id: 'MLU3', quantity: 2, unit_price_uyu: 750 },
  ] });
  assert.equal(data.items[0].status, 'precio_cambiado');
  assert.equal(data.items[0].price_uyu, 1000);
  assert.equal(data.items[1].status, 'cantidad_ajustada');
  assert.equal(data.items[1].suggested_quantity, 1);
});

test('catálogo caído es 503 y nunca se interpreta como agotado', async () => {
  for (const fetchCatalog of [async () => null, async () => { throw new Error('R2'); }]) {
    const { response, data } = await call({
      items: [{ product_id: 'MLU1', quantity: 1, unit_price_uyu: 1000 }],
    }, fetchCatalog);
    assert.equal(response.status, 503);
    assert.equal(data.code, 'CATALOG_UNAVAILABLE');
  }
});

test('contrato HTTP limita método, tipo, tamaño, duplicados y cantidades', async () => {
  assert.equal((await call(null, async () => CATALOG, { method: 'GET' })).response.status, 405);
  assert.equal((await call('{}', async () => CATALOG, { type: 'text/plain' })).response.status, 415);
  assert.equal((await call('{}', async () => CATALOG, { length: 33 * 1024 })).response.status, 413);
  assert.equal((await call({ items: [
    { product_id: 'MLU1', quantity: 1 },
    { product_id: 'MLU1', quantity: 1 },
  ] })).response.status, 400);
  assert.equal((await call({ items: [{ product_id: 'MLU1', quantity: 100 }] })).response.status, 400);
});
