import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSellerPromotions } from '../seller-promotions.js';

const env = { USER_ID: '440298103' };
const post = body => new Request('https://worker.test/meli-promos', { method: 'POST', body: JSON.stringify(body ?? {}) });
const SELLER = '440298103';

function harness(routes) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const u = new URL(String(url));
    const call = { method: init.method ?? 'GET', path: u.pathname, query: u.searchParams, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const handler = routes(call);
    if (handler instanceof Response) return handler;
    return Response.json(handler ?? {});
  };
  return { calls, handle: createSellerPromotions({ fetcher, tokenProvider: async () => 'TOKEN-SECRETO' }) };
}
const run = async (h, body, e = env) => {
  const res = await h.handle(post(body), e);
  return { status: res.status, data: await res.json() };
};

test('solo acepta POST y solo para la cuenta configurada', async () => {
  const h = harness(() => ({}));
  assert.equal((await h.handle(new Request('https://worker.test/meli-promos'), env)).status, 405);
  assert.equal((await run(h, { action: 'status' }, { USER_ID: '999' })).status, 503);
  assert.equal((await run(h, { action: 'nada' })).status, 400);
  assert.equal(h.calls.length, 0);
});

test('status: lista las promociones con GET y no devuelve el token', async () => {
  const h = harness(() => ({ results: [{ id: 'P-1', type: 'DEAL', status: 'started', name: 'Semana', start_date: '2026-10-28T00:00:00', finish_date: '2026-10-31T23:59:00', extra: 'no' }] }));
  const { status, data } = await run(h, { action: 'status' });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.ml_status, 200);
  assert.deepEqual(data.promotions.map(p => [p.id, p.type, p.status, p.name]), [['P-1', 'DEAL', 'started', 'Semana']]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, 'GET');
  assert.equal(h.calls[0].path, `/seller-promotions/users/${SELLER}`);
  assert.equal(h.calls[0].query.get('app_version'), 'v2');
  assert.ok(!JSON.stringify(data).includes('TOKEN-SECRETO'));
  assert.ok(!JSON.stringify(data).includes('extra'));
});

test('status: un 403 de Mercado Libre se informa como falta de permiso, no como caída', async () => {
  const h = harness(() => new Response(JSON.stringify({ message: 'forbidden' }), { status: 403 }));
  const { status, data } = await run(h, { action: 'status' });
  assert.equal(status, 200);
  assert.equal(data.ok, false);
  assert.equal(data.ml_status, 403);
  assert.equal(data.error, 'ml_forbidden');
});

test('promo_items: una página, proyecta precios y manda search_after', async () => {
  const h = harness(() => ({
    results: [{ id: 'MLU1', status: 'started', price: 840, original_price: 1000, meli_percentage: 6, seller_percentage: 10, offer_id: 'O1', secret: 'x' }],
    paging: { total: 120, limit: 50 }, search_after: 'tok2',
  }));
  const { data } = await run(h, { action: 'promo_items', promotion_id: 'P-1', promotion_type: 'DEAL', search_after: 'tok1' });
  assert.equal(data.items.length, 1);
  assert.deepEqual(Object.keys(data.items[0]).sort(), ['id', 'meli_percentage', 'offer_id', 'original_price', 'price', 'seller_percentage', 'status'].sort());
  assert.equal(data.search_after, 'tok2');
  assert.equal(data.total, 120);
  assert.equal(h.calls[0].path, '/seller-promotions/promotions/P-1/items');
  assert.equal(h.calls[0].query.get('promotion_type'), 'DEAL');
  assert.equal(h.calls[0].query.get('search_after'), 'tok1');
});

test('item_promos: promociones y stock de hasta 20 publicaciones, solo propias', async () => {
  const h = harness(call => {
    if (call.path === '/items/bulk') {
      return [{ code: 200, body: { id: 'MLU1', seller_id: Number(SELLER), price: 840, original_price: 1000, available_quantity: 4, status: 'active' } }];
    }
    return [{ id: 'P-1', type: 'DEAL', status: 'started', price: 840, original_price: 1000 }];
  });
  const { data } = await run(h, { action: 'item_promos', ids: ['MLU1'] });
  assert.equal(data.items[0].id, 'MLU1');
  assert.equal(data.items[0].available_quantity, 4);
  assert.equal(data.items[0].promotions[0].type, 'DEAL');
  assert.ok(h.calls.every(c => c.method === 'GET'));
  assert.equal((await run(h, { action: 'item_promos', ids: Array.from({ length: 21 }, (_, i) => `MLU${i + 1}`) })).status, 400);
  assert.equal((await run(h, { action: 'item_promos', ids: ['no-es-un-id'] })).status, 400);

  const ajena = harness(call => call.path === '/items/bulk' ? [{ code: 200, body: { id: 'MLU1', seller_id: 1, price: 1, available_quantity: 1 } }] : []);
  assert.equal((await run(ajena, { action: 'item_promos', ids: ['MLU1'] })).status, 403);
});

test('remove: sin confirm=true no hace ninguna llamada', async () => {
  const h = harness(() => ({}));
  const { status } = await run(h, { action: 'remove', removals: [{ item_id: 'MLU1', promotion_id: 'P-1', promotion_type: 'DEAL' }] });
  assert.equal(status, 400);
  assert.equal(h.calls.length, 0);
});

test('remove: con confirm solo manda DELETE a seller-promotions y nunca toca precio ni estado', async () => {
  const h = harness(() => ({}));
  const { data } = await run(h, { action: 'remove', confirm: true, removals: [{ item_id: 'MLU1', promotion_id: 'P-1', promotion_type: 'DEAL' }] });
  assert.equal(data.results[0].ok, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, 'DELETE');
  assert.equal(h.calls[0].path, '/seller-promotions/items/MLU1');
  assert.equal(h.calls[0].query.get('promotion_id'), 'P-1');
  assert.equal(h.calls[0].query.get('promotion_type'), 'DEAL');
  assert.ok(h.calls.every(c => c.path.startsWith('/seller-promotions/')));
});

test('remove: cupones y publicidad se rechazan y no se llama a Mercado Libre', async () => {
  for (const type of ['SELLER_COUPON_CAMPAIGN', 'MARKETPLACE_COUPON', 'ADVERTISING', 'PRODUCT_ADS']) {
    const h = harness(() => ({}));
    const { data } = await run(h, { action: 'remove', confirm: true, removals: [{ item_id: 'MLU1', promotion_id: 'P-1', promotion_type: type }] });
    assert.equal(data.results[0].ok, false, type);
    assert.equal(data.results[0].error, 'tipo_no_permitido', type);
    assert.equal(h.calls.length, 0, type);
  }
});

test('remove: un error de Mercado Libre en un ítem no corta los demás', async () => {
  const h = harness(call => call.path.endsWith('MLU1') ? new Response('{}', { status: 400 }) : {});
  const { data } = await run(h, { action: 'remove', confirm: true, removals: [
    { item_id: 'MLU1', promotion_id: 'P-1', promotion_type: 'DEAL' },
    { item_id: 'MLU2', promotion_id: 'P-1', promotion_type: 'DEAL' },
  ] });
  assert.deepEqual(data.results.map(r => r.ok), [false, true]);
  assert.equal(data.results[0].ml_status, 400);
});

test('join_lightning: sin confirm no hace nada; con confirm solo suma a LIGHTNING y nunca sube el precio', async () => {
  const entry = { item_id: 'MLU1', promotion_id: 'L-1', promotion_type: 'LIGHTNING', deal_price: 900, current_price: 950, stock: 2, available_quantity: 5 };
  const sin = harness(() => ({}));
  assert.equal((await run(sin, { action: 'join_lightning', joins: [entry] })).status, 400);
  assert.equal(sin.calls.length, 0);

  const h = harness(() => ({}));
  const { data } = await run(h, { action: 'join_lightning', confirm: true, joins: [entry] });
  assert.equal(data.results[0].ok, true);
  assert.equal(h.calls[0].method, 'POST');
  assert.equal(h.calls[0].path, '/seller-promotions/items/MLU1');
  assert.deepEqual(h.calls[0].body, { promotion_id: 'L-1', promotion_type: 'LIGHTNING', deal_price: 900, stock: 2 });

  for (const bad of [
    { ...entry, promotion_type: 'DEAL' },
    { ...entry, deal_price: 951 },
    { ...entry, deal_price: 900.5 },
    { ...entry, stock: 6 },
    { ...entry, stock: 0 },
  ]) {
    const g = harness(() => ({}));
    const out = await run(g, { action: 'join_lightning', confirm: true, joins: [bad] });
    assert.equal(out.data.results[0].ok, false);
    assert.equal(g.calls.length, 0);
  }
});

test('ninguna acción manda PUT ni toca precios, estado, cupones o publicidad de la publicación', async () => {
  const h = harness(call => call.path === '/items/bulk' ? [] : {});
  await run(h, { action: 'status' });
  await run(h, { action: 'promo_items', promotion_id: 'P-1', promotion_type: 'DEAL' });
  await run(h, { action: 'remove', confirm: true, removals: [{ item_id: 'MLU1', promotion_id: 'P-1', promotion_type: 'DEAL' }] });
  await run(h, { action: 'join_lightning', confirm: true, joins: [{ item_id: 'MLU1', promotion_id: 'L-1', promotion_type: 'LIGHTNING', deal_price: 9, current_price: 10, stock: 1, available_quantity: 1 }] });
  assert.ok(h.calls.every(c => c.method !== 'PUT' && c.method !== 'PATCH'));
  assert.ok(h.calls.every(c => c.path.startsWith('/seller-promotions/') || (c.method === 'GET' && c.path === '/items/bulk')));
});
