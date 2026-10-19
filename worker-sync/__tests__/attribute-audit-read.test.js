import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAttributeAuditRead, projectAuditItem, AUDIT_ATTRIBUTE_IDS } from '../attribute-audit-read.js';
import { BOOK_ATTRIBUTES } from '../../scripts/mercadolibre/attribute-audit.mjs';

const env = { USER_ID: '440298103' };
const post = body => new Request('https://worker.test/attribute-audit', { method: 'POST', body: JSON.stringify(body ?? {}) });
const item = (id, extra = {}) => ({ id, seller_id: 440298103, title: 'T ' + id, status: 'active', category_id: 'MLU1196', catalog_listing: false, sold_quantity: 2, available_quantity: 1, attributes: [{ id: 'AUTHOR', value_name: 'X' }, { id: 'SECRET_OTHER', value_name: 'no' }], ...extra });

test('los ids que pide el Worker cubren todos los que mide la auditoría', () => {
  for (const spec of BOOK_ATTRIBUTES) for (const id of spec.ids) assert.ok(AUDIT_ATTRIBUTE_IDS.includes(id), id);
});

test('proyecta sólo atributos de ficha de libro', () => {
  const out = projectAuditItem(item('MLU1'));
  assert.deepEqual(out.attributes.map(a => a.id), ['AUTHOR']);
});

test('lee una página con solo GET y devuelve el scroll_id', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), method: init.method });
    if (String(url).includes('/items/search')) return Response.json({ results: ['MLU1', 'MLU2'], scroll_id: 'abc', paging: { total: 2 } });
    return Response.json([{ status_code: 200, body: item('MLU1') }, { status_code: 404 }]);
  };
  const res = await createAttributeAuditRead({ fetcher, tokenProvider: async () => 't' })(post(), env);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.read_only, true);
  assert.equal(data.scroll_id, 'abc');
  assert.deepEqual(data.items.map(i => i.id), ['MLU1']);
  assert.deepEqual(data.failed_ids, ['MLU2']);
  assert.ok(calls.every(c => c.method === 'GET'));
  assert.ok(!JSON.stringify(data).includes('"t"'));
});

test('rechaza publicaciones de otro vendedor y cuentas mal configuradas', async () => {
  const fetcher = async url => String(url).includes('/items/search')
    ? Response.json({ results: ['MLU1'], scroll_id: null })
    : Response.json([{ status_code: 200, body: item('MLU1', { seller_id: 999 }) }]);
  const run = createAttributeAuditRead({ fetcher, tokenProvider: async () => 't' });
  assert.equal((await run(post(), env)).status, 403);
  assert.equal((await run(post(), { USER_ID: '1' })).status, 503);
  assert.equal((await run(new Request('https://worker.test/attribute-audit'), env)).status, 405);
  assert.equal((await run(post({ scroll_id: 5 }), env)).status, 400);
});
