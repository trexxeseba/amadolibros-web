// Prueba en workerd con identidad y claves sintéticas. No usa sesiones reales
// ni bindings del negocio y nunca despliega el Worker de prueba.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const { Miniflare } = await import(pathToFileURL(resolve(process.argv[2])).href);
const root = fileURLToPath(new URL('../', import.meta.url));
const modules = await Promise.all(['functions/_shared/admin-web-auth.js', 'functions/_shared/admin-web-data.js',
  'functions/_shared/catalog.js', 'functions/_shared/perf.js'].map(async path => ({ type: 'ESModule',
    path: resolve(root, path), contents: await readFile(resolve(root, path), 'utf8') })));
const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', keys.publicKey), kid: 'runtime-test', alg: 'RS256', use: 'sig' };
const env = { ADMIN_WEB_ACCESS_TEAM: 'test.cloudflareaccess.com', ADMIN_WEB_ACCESS_AUD: 'runtime-test',
  ADMIN_WEB_ALLOWED_EMAILS: 'owner@example.test' };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
async function token(changes = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode({ type: 'app', iss: 'https://test.cloudflareaccess.com',
    aud: ['runtime-test'], email: 'owner@example.test', sub: 'runtime-test-user', iat: now - 1, nbf: now - 1, exp: now + 120, ...changes })}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(body));
  return `${body}.${Buffer.from(signature).toString('base64url')}`;
}
const valid = await token();
const cases = [
  ['header', { 'Cf-Access-Jwt-Assertion': valid }, true],
  ['browser-cookie', { Cookie: `other=value; CF_Authorization=${valid}` }, true],
  ['anonymous', {}, false],
  ['forged-cookie', { Cookie: 'CF_Authorization=invalid.invalid.invalid' }, false],
  ['other-account', { Cookie: `CF_Authorization=${await token({ email: 'other@example.test' })}` }, false],
  ['expired-cookie', { Cookie: `CF_Authorization=${await token({ exp: 1 })}` }, false],
  ['other-application', { Cookie: `CF_Authorization=${await token({ aud: ['other'] })}` }, false],
  ['ambiguous-cookie', { Cookie: `CF_Authorization=${valid}; CF_Authorization=${valid}` }, false],
  ['invalid-header-with-cookie', { 'Cf-Access-Jwt-Assertion': 'invalid.invalid.invalid', Cookie: `CF_Authorization=${valid}` }, false],
];
const publicRoot = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev';
const certUrl = 'https://test.cloudflareaccess.com/cdn-cgi/access/certs';
const requests = [];
function runtime(redirects = false) {
  return new Miniflare({ compatibilityDate: '2024-09-23', modules: [{ type: 'ESModule', path: resolve(root, 'runtime-check.js'),
    contents: `import {checkAdminAccess} from './functions/_shared/admin-web-auth.js';
      import {readWebCatalog,readWebSync} from './functions/_shared/admin-web-data.js';
      export default {async fetch(request) {const path=new URL(request.url).pathname;
        if(path==='/catalog')return Response.json(await readWebCatalog());
        if(path==='/sync')return Response.json(await readWebSync());
        return Response.json(await checkAdminAccess(request, ${JSON.stringify(env)}));}};` }, ...modules],
    // Se intercepta el destino de red DESPUÉS de ejecutar fetch real de workerd.
    // Sustituir fetchFn dentro del Worker ocultaba opciones no soportadas.
    outboundService: async request => {
      assert.equal(request.headers.get('Cookie'), null, 'No reenviar la sesión a las fuentes');
      assert.equal(request.headers.get('Cf-Access-Jwt-Assertion'), null);
      requests.push(request.url);
      assert.ok([certUrl, `${publicRoot}/catalog.json`, `${publicRoot}/meta.json`].includes(request.url), 'No seguir redirects');
      if (redirects) return new Response(null, { status: 302, headers: { location: 'https://untrusted.example/' } });
      if (request.url === certUrl) return Response.json({ keys: [jwk] });
      if (request.url.endsWith('/catalog.json')) return Response.json({ items: [{ id: 'TEST-BOOK', title: 'Libro de prueba', price: 300, available_quantity: 2 }] });
      return Response.json({ updated_at: new Date(Date.now() - 60000).toISOString() });
    } });
}
const mf = runtime();
try {
  for (const [name, headers, expected] of cases) {
    const response = await mf.dispatchFetch('https://runtime-test.example/admin', { headers });
    assert.equal((await response.json()).ok, expected, name);
  }
  for (const path of ['/catalog', '/sync']) {
    const result = await (await mf.dispatchFetch(`https://runtime-test.example${path}`)).json();
    assert.equal(result.status, 'ok', path);
    if (path === '/catalog') assert.equal(result.rows[0].id, 'TEST-BOOK');
  }
} finally { await mf.dispose(); }
const redirectRuntime = runtime(true);
try {
  const access = await (await redirectRuntime.dispatchFetch('https://runtime-test.example/admin', { headers: { 'Cf-Access-Jwt-Assertion': valid } })).json();
  assert.deepEqual(access, { ok: false, reference: 'A07' });
  for (const path of ['/catalog', '/sync']) assert.equal((await (await redirectRuntime.dispatchFetch(`https://runtime-test.example${path}`)).json()).status, 'unavailable');
} finally { await redirectRuntime.dispose(); }
assert.equal(requests.length, 6, 'Tres fuentes válidas y tres redirects rechazados');
console.log(JSON.stringify({ status: 'runtime_auth_verified', checks: cases.length + 5, realFetch: true }));
