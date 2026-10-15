import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOperationsReader, OPERATIONS_ISSUER, OPERATIONS_PATH, verifyOperationsRequest } from '../operations-read.js';

const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicKey = await crypto.subtle.exportKey('jwk', keys.publicKey);
const now = () => 1_800_000_000_000;
const env = { USER_ID: '440298103', APP_ID: '4741021817925208' };
const b64 = value => Buffer.from(value).toString('base64url');
async function signed(action, args = {}, claims = {}, signingKey = keys.privateKey) {
  const data = { v: 1, iss: OPERATIONS_ISSUER, aud: 'amado-mercadolibre-read', seller_id: '440298103', method: 'POST', path: OPERATIONS_PATH, iat: now() / 1000, exp: now() / 1000 + 60, jti: crypto.randomUUID(), action, args, ...claims };
  const payload = b64(JSON.stringify(data));
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, new TextEncoder().encode(payload));
  return new Request('https://worker.test' + OPERATIONS_PATH, { method: 'POST', headers: { Authorization: `Amado-Signature ${payload}.${b64(signature)}` } });
}
function reader(fetcher, extra = {}) { return createOperationsReader({ fetcher, tokenProvider: async () => 'private-token-for-test', now, publicKey, ...extra }); }

test('signed envelope binds issuer, audience, seller, expiry, method and route', async () => {
  assert.equal((await verifyOperationsRequest(await signed('cuenta'), { publicKey, now })).action, 'cuenta');
  for (const claims of [{ iss: 'other' }, { aud: 'other' }, { seller_id: '123' }, { path: '/trigger' }, { method: 'PUT' }, { exp: now()/1000 }, { exp: now()/1000+61 }, { iat: now()/1000+16 }, { jti: 'bad' }]) await assert.rejects(verifyOperationsRequest(await signed('cuenta', {}, claims), { publicKey, now }));
  const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  await assert.rejects(verifyOperationsRequest(await signed('cuenta', {}, {}, other.privateKey), { publicKey, now }));
});

test('unsigned, tampered, expired or write requests never refresh a token or reach ML', async () => {
  let tokens = 0, calls = 0;
  const run = reader(async () => { calls++; throw new Error('should not fetch'); }, { tokenProvider: async () => { tokens++; return 'token'; } });
  assert.equal((await run(new Request('https://worker.test'+OPERATIONS_PATH, { method: 'POST' }), env)).status, 401);
  assert.equal((await run(await signed('publicar'), env)).status, 400);
  assert.equal((await run(await signed('cuenta', { path: '/orders' }), env)).status, 400);
  assert.equal((await run(await signed('consultar_publicaciones', { ids: ['https://evil.test'] }), env)).status, 400);
  assert.equal((await run(await signed('listar_publicaciones', { estado: 'active', limite: 21 }), env)).status, 400);
  assert.equal((await run(await signed('cuenta', {}, { exp: now()/1000-1 }), env)).status, 401);
  const req = await signed('cuenta');
  const h = req.headers.get('authorization');
  req.headers.set('authorization', h.slice(0,30)+'A'+h.slice(31));
  assert.equal((await run(req, env)).status, 401);
  assert.equal(tokens, 0); assert.equal(calls, 0);
});

test('account uses live users/me, verifies seller and withholds token and personal fields', async () => {
  const run = reader(async (url, options) => {
    assert.equal(url, 'https://api.mercadolibre.com/users/me'); assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer private-token-for-test');
    return Response.json({ id: 440298103, nickname: 'AMADOLIBROSCOMUY', site_id: 'MLU', email: 'private@example.test', address: { street: 'private' }, access_token: 'do-not-return' });
  });
  const res = await run(await signed('cuenta'), env);
  assert.equal(res.status, 200);
  const text = await res.text(); const data = JSON.parse(text);
  assert.equal(data.source, 'Mercado Libre API'); assert.equal(data.data.id, 440298103);
  assert.doesNotMatch(text, /private-token|do-not-return|private@example|street/);
  assert.equal(data.read_only, true);
});

test('paused search has explicit status and scroll and returns incomplete-page notice', async () => {
  const run = reader(async url => {
    const u = new URL(url); assert.equal(u.pathname, '/users/440298103/items/search');
    assert.equal(u.searchParams.get('status'), 'paused'); assert.equal(u.searchParams.get('search_type'), 'scan');
    assert.equal(u.searchParams.get('scroll_id'), 'scroll=/+opaque');
    return Response.json({ seller_id: '440298103', results: ['MLU1234567'], paging: { total: 9000 }, scroll_id: 'next' });
  });
  const data = await (await run(await signed('listar_publicaciones', { estado: 'paused', scroll_id: 'scroll=/+opaque' }), env)).json();
  assert.equal(data.data.total, 9000); assert.equal(data.data.scroll_id, 'next'); assert.match(data.data.note, /incompleta/);
});

test('item details validate ownership; UP and product association do not imply Catalog', async () => {
  const body = { id: 'MLU1234567', seller_id: 440298103, title: 'Book', catalog_listing: false, user_product_id: 'MLUU100', catalog_product_id: 'MLU100', attributes: [{ id: 'ISBN', value_name: '9789681313173' }] };
  for (const key of ['code','status_code']) {
    const run = reader(async () => Response.json([{ [key]: 200, body }]));
    const data = await (await run(await signed('consultar_publicaciones', { ids: [body.id] }), env)).json();
    assert.equal(data.data.items[0].catalog_listing, false); assert.equal(data.data.items[0].isbn, '9789681313173');
    assert.equal(data.data.items[0].available_quantity, null);
  }
  const foreign = reader(async () => Response.json([{ code: 200, body: { ...body, seller_id: 1 } }]));
  assert.equal((await foreign(await signed('consultar_publicaciones', { ids: [body.id] }), env)).status, 403);
});

test('account mismatch and malformed upstream responses fail closed', async () => {
  assert.equal((await reader(async () => Response.json({ id: 1 }))(await signed('cuenta'), env)).status, 403);
  assert.equal((await reader(async () => Response.json({}))(await signed('listar_publicaciones'), env)).status, 502);
  assert.equal((await reader(async () => { throw new Error('private diagnostic'); })(await signed('cuenta'), env)).status, 502);
  assert.equal((await reader(async () => Response.json({}))(await signed('cuenta'), { ...env, USER_ID: '1' })).status, 503);
});

test('token is reused briefly, invalidated on 401, and auth errors never reveal secrets', async () => {
  let tokens = 0, status = 200;
  const run = reader(async () => status === 200 ? Response.json({ id: 440298103 }) : new Response('', { status }), { tokenProvider: async () => { tokens++; return 'cached-token'; } });
  assert.equal((await run(await signed('cuenta'), env)).status, 200);
  assert.equal((await run(await signed('cuenta'), env)).status, 200); assert.equal(tokens, 1);
  status = 401; assert.equal((await run(await signed('cuenta'), env)).status, 502);
  status = 200; await run(await signed('cuenta'), env); assert.equal(tokens, 2);
  const failing = reader(async () => { throw new Error('unused'); }, { tokenProvider: async () => { throw new Error('secret-refresh-token'); } });
  const response = await failing(await signed('cuenta'), env); assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /secret-refresh-token/);
});
