import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSellerOrdersUrl,
  fetchSellerOrders,
  fetchSellerOrdersPage,
  normalizeMlOrderItems,
  summarizeNormalizedSales,
} from '../ml-orders.js';

function response(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() { return body; },
  };
}

test('buildSellerOrdersUrl usa seller, paid, date_closed, limit y offset', () => {
  const url = new URL(buildSellerOrdersUrl({
    sellerId: '440298103',
    dateFrom: '2026-06-01T00:00:00Z',
    dateTo: '2026-08-27T12:00:00Z',
    offset: 50,
    limit: 50,
  }));
  assert.equal(url.pathname, '/orders/search');
  assert.equal(url.searchParams.get('seller'), '440298103');
  assert.equal(url.searchParams.get('order.status'), 'paid');
  assert.equal(url.searchParams.get('order.date_closed.from'), '2026-06-01T00:00:00.000Z');
  assert.equal(url.searchParams.get('order.date_closed.to'), '2026-08-27T12:00:00.000Z');
  assert.equal(url.searchParams.get('offset'), '50');
  assert.equal(url.searchParams.get('limit'), '50');
});

test('fetchSellerOrdersPage acepta HTTP 206 Partial Content como éxito', async () => {
  const payload = { results: [{ id: 1 }], paging: { total: 1, offset: 0, limit: 50 } };
  const result = await fetchSellerOrdersPage('token', {
    sellerId: '440298103',
    dateFrom: '2026-08-01T00:00:00Z',
    dateTo: '2026-08-27T00:00:00Z',
    mlGetDeps: { fetchFn: async () => response(payload, { status: 206 }) },
  });
  assert.deepEqual(result, payload);
});

test('fetchSellerOrders pagina hasta cubrir paging.total', async () => {
  const offsets = [];
  const pages = [
    { results: [{ id: 1 }, { id: 2 }], paging: { total: 3, offset: 0, limit: 2 } },
    { results: [{ id: 3 }], paging: { total: 3, offset: 2, limit: 2 } },
  ];
  const result = await fetchSellerOrders('token', {
    sellerId: '440298103',
    dateFrom: '2026-08-01T00:00:00Z',
    dateTo: '2026-08-27T00:00:00Z',
    limit: 2,
    mlGetDeps: {
      fetchFn: async url => {
        offsets.push(Number(new URL(String(url)).searchParams.get('offset')));
        return response(pages.shift());
      },
    },
  });
  assert.deepEqual(offsets, [0, 2]);
  assert.equal(result.orders.length, 3);
  assert.equal(result.pages, 2);
  assert.equal(result.total_reported, 3);
});

test('fetchSellerOrders deduplica order.id observado en páginas', async () => {
  const pages = [
    { results: [{ id: 1 }, { id: 2 }], paging: { total: 4, offset: 0, limit: 2 } },
    { results: [{ id: 2 }, { id: 3 }], paging: { total: 4, offset: 2, limit: 2 } },
  ];
  const result = await fetchSellerOrders('token', {
    sellerId: '440298103', dateFrom: '2026-08-01', dateTo: '2026-08-27', limit: 2,
    mlGetDeps: { fetchFn: async () => response(pages.shift()) },
  });
  assert.deepEqual(result.orders.map(o => o.id), [1, 2, 3]);
});

test('normalizeMlOrderItems conserva sólo datos de producto y omite PII', () => {
  const rows = normalizeMlOrderItems([{
    id: 9001,
    status: 'paid',
    date_created: '2026-08-20T10:00:00Z',
    date_closed: '2026-08-20T10:05:00Z',
    date_last_updated: '2026-08-20T10:06:00Z',
    buyer: { id: 1, nickname: 'privado', phone: { number: '099' } },
    order_items: [{ item: { id: 'MLU123' }, quantity: 2, unit_price: 1000, gross_price: 1100, currency_id: 'UYU' }],
  }], { observedAt: '2026-08-27T12:00:00Z' });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    order_id: '9001', item_id: 'MLU123', quantity: 2, unit_price: 1000, gross_price: 1100,
    currency_id: 'UYU', order_status: 'paid', date_created: '2026-08-20T10:00:00Z',
    date_closed: '2026-08-20T10:05:00Z', date_last_updated: '2026-08-20T10:06:00Z',
    commercial_date: '2026-08-20T10:05:00Z', observed_at: '2026-08-27T12:00:00Z',
  });
  assert.equal('buyer' in rows[0], false);
  assert.equal(JSON.stringify(rows).includes('privado'), false);
  assert.equal(JSON.stringify(rows).includes('099'), false);
});

test('normalizeMlOrderItems agrega líneas duplicadas del mismo MLU dentro de una orden', () => {
  const rows = normalizeMlOrderItems([{
    id: 1, status: 'paid', date_created: '2026-08-20T00:00:00Z', date_closed: '2026-08-20T01:00:00Z',
    order_items: [
      { item: { id: 'MLU1' }, quantity: 1, unit_price: 100, currency_id: 'UYU' },
      { item: { id: 'MLU1' }, quantity: 2, unit_price: 200, currency_id: 'UYU' },
    ],
  }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 3);
  assert.equal(Math.round(rows[0].unit_price * 100) / 100, 166.67);
});

test('normalizeMlOrderItems usa date_created como fallback de commercial_date', () => {
  const [row] = normalizeMlOrderItems([{
    id: 1, status: 'paid', date_created: '2026-08-20T00:00:00Z',
    order_items: [{ item: { id: 'MLU1' }, quantity: 1, unit_price: 100 }],
  }]);
  assert.equal(row.commercial_date, '2026-08-20T00:00:00Z');
});

test('summarizeNormalizedSales agrega unidades/revenue por MLU', () => {
  const summary = summarizeNormalizedSales([
    { item_id: 'MLU1', quantity: 2, unit_price: 100, commercial_date: '2026-08-20' },
    { item_id: 'MLU1', quantity: 1, unit_price: 120, commercial_date: '2026-08-21' },
    { item_id: 'MLU2', quantity: 1, unit_price: 50, commercial_date: '2026-08-20' },
  ]);
  assert.deepEqual(summary[0], { item_id: 'MLU1', units: 3, revenue: 320, last_sale_at: '2026-08-21' });
});
