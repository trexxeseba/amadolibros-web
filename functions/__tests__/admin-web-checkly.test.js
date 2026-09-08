import test from 'node:test';
import assert from 'node:assert/strict';
import { checkChecklyConnection, AMADO_CHECKLY_ACCOUNT } from '../../scripts/admin-web-checkly-connection.mjs';
test('conexión Checkly fija cuenta, usa sólo GET y no expone payload ni clave', async () => {
  assert.equal((await checkChecklyConnection({ env: {}, fetchFn: () => assert.fail('No hay clave') })).authenticated, false);
  const result = await checkChecklyConnection({ env: { CHECKLY_API_KEY: 'PRIVATE_KEY' }, fetchFn: async (url, options) => {
    assert.equal(url, 'https://api.checklyhq.com/v1/checks'); assert.equal(options.method, 'GET');
    assert.equal(options.headers['X-Checkly-Account'], AMADO_CHECKLY_ACCOUNT);
    assert.equal(options.headers.Authorization, 'Bearer PRIVATE_KEY'); assert.equal(options.redirect, 'manual');
    return Response.json([{ id: 'PRIVATE_ID', script: 'PRIVATE_SCRIPT' }]);
  } });
  assert.deepEqual(result, { status: 'read_access_verified', authenticated: true, writes: 0 });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  await assert.rejects(checkChecklyConnection({ env: { CHECKLY_API_KEY: 'PRIVATE' }, fetchFn: async () => new Response('PRIVATE_ERROR', { status: 401 }) }), /^Error: CHECKLY_HTTP_401$/);
});
