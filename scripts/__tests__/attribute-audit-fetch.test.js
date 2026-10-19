import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllItems } from '../mercadolibre/attribute-audit-fetch.mjs';

test('recorre las páginas hasta que no hay scroll_id y no repite items', async () => {
  const pages = [
    { items: [{ id: 'MLU1' }, { id: 'MLU2' }], scroll_id: 's1', total: 3 },
    { items: [{ id: 'MLU2' }, { id: 'MLU3' }], scroll_id: null, total: 3, failed_ids: ['MLU9'] },
  ];
  const bodies = [];
  const fetcher = async (url, init) => { bodies.push(JSON.parse(init.body)); return Response.json(pages.shift()); };
  const out = await fetchAllItems({ secret: 'x', fetcher, wait: async () => {} });
  assert.deepEqual(out.items.map(i => i.id), ['MLU1', 'MLU2', 'MLU3']);
  assert.deepEqual(out.failed_ids, ['MLU9']);
  assert.deepEqual(bodies, [{}, { scroll_id: 's1' }]);
});

test('reintenta ante 429 y corta ante un error definitivo', async () => {
  let n = 0;
  const flaky = async () => (++n === 1 ? Response.json({ error: 'x' }, { status: 429 }) : Response.json({ items: [], scroll_id: null }));
  assert.equal((await fetchAllItems({ secret: 'x', fetcher: flaky, wait: async () => {} })).items.length, 0);
  await assert.rejects(fetchAllItems({ secret: 'x', fetcher: async () => Response.json({ error: 'no' }, { status: 401 }), wait: async () => {} }), /no/);
  await assert.rejects(fetchAllItems({}), /SYNC_SECRET/);
});
