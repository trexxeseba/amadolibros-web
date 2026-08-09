import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRealCovers } from '../scripts/select-real-covers.js';

function item(index, overrides = {}) {
  return {
    id: `MLU${String(100000000 + index)}`,
    status: 'active',
    available_quantity: 1,
    pictures: [{ url: `http://http2.mlstatic.com/D_NQ_NP_${index}-O.jpg` }],
    ...overrides,
  };
}

test('selecciona exactamente 20 activos con stock y normaliza HTTPS', () => {
  const catalog = { items: Array.from({ length: 25 }, (_, index) => item(index)) };
  const payload = selectRealCovers(catalog);
  assert.equal(payload.items.length, 20);
  assert.ok(payload.items.every(entry => entry.url.startsWith('https://http2.mlstatic.com/')));
  assert.ok(payload.items.every(entry => entry.position === 0));
});

test('descarta pausados, sin stock, hosts ajenos y URLs duplicadas', () => {
  const valid = Array.from({ length: 20 }, (_, index) => item(index + 10));
  const catalog = {
    items: [
      item(1, { status: 'paused' }),
      item(2, { available_quantity: 0 }),
      item(3, { pictures: [{ url: 'https://example.com/cover.jpg' }] }),
      item(4),
      item(5, { pictures: [{ url: 'http://http2.mlstatic.com/D_NQ_NP_4-O.jpg' }] }),
      ...valid,
    ],
  };
  const payload = selectRealCovers(catalog);
  assert.equal(payload.items.length, 20);
  assert.equal(payload.items.some(entry => entry.product_id === 'MLU100000001'), false);
  assert.equal(new Set(payload.items.map(entry => entry.url)).size, 20);
});

test('falla cerrado si no puede reunir 20 portadas válidas', () => {
  assert.throws(
    () => selectRealCovers({ items: [item(1)] }),
    /Sólo se encontraron 1 portadas válidas/,
  );
});
