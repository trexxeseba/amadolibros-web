import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { APP_ID, CALLBACK, SCHEMA, createVintageOAuth } from '../_shared/meli-vintage-oauth.js';
import { createSessionToken, deriveSessionSecret } from '../_shared/panel-auth.js';
import { onRequest as middleware } from '../_middleware.js';

const ORIGIN = new URL(CALLBACK).origin;
const START = `${ORIGIN}/panel/meli-vintage`;
const expectedEmail = 'vintage@example.test';
async function fixture(t, options = {}) {
  const sqlite = new DatabaseSync(':memory:');
  function statement(sql, args = []) {
    return { sql, args, bind: (...values) => statement(sql, values),
      async first() { return sqlite.prepare(sql).get(...args) || null; },
      async run() { return sqlite.prepare(sql).run(...args); } };
  }
  const db = { prepare: sql => statement(sql), async batch(items) { for (const item of items) sqlite.prepare(item.sql).run(...item.args); } };
  // Canary values emulate the existing production grant and legacy KV. Neither
  // table nor KV API is needed by this flow, and both must remain untouched.
  sqlite.exec('CREATE TABLE ml_oauth(app_id TEXT PRIMARY KEY, access_token TEXT, refresh_token TEXT)');
  sqlite.prepare('INSERT INTO ml_oauth VALUES(?,?,?)').run(APP_ID, 'books-access-canary', 'books-refresh-canary');
  const original = JSON.stringify(sqlite.prepare('SELECT * FROM ml_oauth').all());
  t.after(() => {
    try { assert.equal(JSON.stringify(sqlite.prepare('SELECT * FROM ml_oauth').all()), original); }
    finally { sqlite.close(); }
  });
  const clock = { value: 1700000000000 }, calls = [];
  const env = { APP_ENV: 'production', ORDERS_DB: db, CLIENT_SECRET: 'test-secret', PANEL_PASSWORD: 'test-password', AMADO_KV: new Proxy({}, { get() { throw Error('Legacy KV must never be used'); } }) };
  const session = await createSessionToken(await deriveSessionSecret(env.PANEL_PASSWORD));
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, 'error');
    if (url === 'https://api.mercadolibre.com/oauth/token') {
      assert.equal(init.method, 'POST');
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('redirect_uri'), CALLBACK);
      assert.equal(body.get('client_id'), APP_ID);
      assert.ok(body.get('code_verifier'));
      return Response.json({ access_token: 'vintage-access-secret', refresh_token: 'vintage-refresh-secret', expires_in: 3600, user_id: options.tokenSeller || options.seller || 123456789 });
    }
    assert.equal(url, 'https://api.mercadolibre.com/users/me');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Authorization, 'Bearer vintage-access-secret');
    if (options.upstreamError) throw new Error('vintage-access-secret');
    return Response.json({ id: options.seller || 123456789, nickname: options.nickname || 'AMADO VINTAGE', email: options.email || expectedEmail, site_id: options.site || 'MLU' });
  };
  const handler = createVintageOAuth({ fetcher, now: () => clock.value });
  const run = request => handler({ request, env });
  async function start() {
    const response = await run(new Request(START, { method: 'POST', headers: { origin: ORIGIN, cookie: `amado_panel_session=${session}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: expectedEmail }) }));
    assert.equal(response.status, 303);
    const location = new URL(response.headers.get('location'));
    assert.equal(location.origin, 'https://auth.mercadolibre.com.uy');
    assert.equal(location.searchParams.get('redirect_uri'), CALLBACK);
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    return { location, cookie: response.headers.get('set-cookie').split(';')[0], callback: `${CALLBACK}?code=test-code&state=${location.searchParams.get('state')}` };
  }
  return { sqlite, db, clock, env, calls, session, run, start };
}

test('verified Vintage seller is saved separately; users/me ID is shown without tokens', async t => {
  const f = await fixture(t), flow = await f.start();
  const response = await f.run(new Request(flow.callback, { headers: { cookie: flow.cookie } }));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /123456789/);
  assert.doesNotMatch(html, /vintage-access-secret|vintage-refresh-secret|test-secret|test-code/);
  const row = f.sqlite.prepare('SELECT * FROM ml_oauth_sellers').get();
  assert.equal(row.app_id, APP_ID); assert.equal(row.seller_id, '123456789');
  assert.equal(row.refresh_token, 'vintage-refresh-secret');
  assert.equal(row.access_expires_at, f.clock.value + 3600000);
  assert.equal(f.calls.length, 2);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

for (const options of [{ seller: 440298103 }, { nickname: 'AMADOLIBROS COMUY' }, { email: 'wrong@example.test' }, { site: 'MLA' }, { tokenSeller: 999 }]) {
  test(`wrong account is refused before credentials are stored: ${JSON.stringify(options)}`, async t => {
    const f = await fixture(t, options), flow = await f.start();
    const response = await f.run(new Request(flow.callback, { headers: { cookie: flow.cookie } }));
    assert.equal(response.status, 409);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ml_oauth_sellers').get().n, 0);
  });
}

test('no session, cross-origin POST, preview and wrong app cannot begin authorization', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(new Request(START))).status, 401);
  assert.equal((await f.run(new Request(START, { method: 'POST', headers: { cookie: `amado_panel_session=${f.session}`, origin: 'https://attacker.test' } }))).status, 403);
  f.env.APP_ENV = 'preview'; assert.equal((await f.run(new Request(START))).status, 403);
  f.env.APP_ENV = 'production'; f.env.APP_ID = 'other'; assert.equal((await f.run(new Request(START))).status, 503);
  assert.equal(f.calls.length, 0);
});

test('plain callback makes no API calls or database changes', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(new Request(CALLBACK))).status, 200);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'ml_oauth_%'").get().n, 0);
});

test('state is single use and bound to the initiating browser', async t => {
  const f = await fixture(t), flow = await f.start();
  assert.equal((await f.run(new Request(flow.callback))).status, 400);
  assert.equal(f.calls.length, 0);
  const request = () => new Request(flow.callback, { headers: { cookie: flow.cookie } });
  const responses = await Promise.all([f.run(request()), f.run(request())]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 400]);
  assert.equal(f.calls.length, 2);
});

test('expired state and a denied consent never call Mercado Libre', async t => {
  const f = await fixture(t), flow = await f.start();
  f.clock.value += 11 * 60000;
  assert.equal((await f.run(new Request(flow.callback, { headers: { cookie: flow.cookie } }))).status, 400);
  const next = await f.start();
  assert.equal((await f.run(new Request(next.callback.replace('code=test-code', 'error=access_denied'), { headers: { cookie: next.cookie } }))).status, 400);
  assert.equal(f.calls.length, 0);
});

test('existing seller credentials are never replaced', async t => {
  const f = await fixture(t), flow = await f.start();
  f.sqlite.prepare('INSERT INTO ml_oauth_sellers VALUES(?,?,?,?,?,?,?)').run(APP_ID, '123456789', 'Vintage', 'existing-access', 0, 'existing-refresh', 0);
  assert.equal((await f.run(new Request(flow.callback, { headers: { cookie: flow.cookie } }))).status, 409);
  assert.equal(f.sqlite.prepare('SELECT refresh_token FROM ml_oauth_sellers').get().refresh_token, 'existing-refresh');
});

test('upstream errors neither leak tokens nor save an unverified seller', async t => {
  const f = await fixture(t, { upstreamError: true }), flow = await f.start();
  const response = await f.run(new Request(flow.callback, { headers: { cookie: flow.cookie } }));
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /vintage-access-secret/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ml_oauth_sellers').get().n, 0);
});

test('middleware keeps callback codes out of analytics and legacy routing', async () => {
  let scheduled = 0;
  const response = await middleware({ request: new Request(`${CALLBACK}?code=secret&book=MLU123`), env: {}, next: async () => new Response('callback', { headers: { 'referrer-policy': 'no-referrer' } }), waitUntil() { scheduled++; } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'callback');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(scheduled, 0);
});
