// Prueba en workerd con identidad y claves sintéticas. No usa sesiones reales
// ni bindings del negocio y nunca despliega el Worker de prueba.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { Miniflare } = await import(pathToFileURL(resolve(process.argv[2])).href);
const auth = await readFile(new URL('../functions/_shared/admin-web-auth.js', import.meta.url), 'utf8');
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
const mf = new Miniflare({ modules: true, compatibilityDate: '2024-09-23',
  script: `${auth}\nexport default {async fetch(request) {return Response.json(await checkAdminAccess(request, ${JSON.stringify(env)},
    {fetchFn:async()=>Response.json({keys:[${JSON.stringify(jwk)}]})}));}};` });
try {
  for (const [name, headers, expected] of cases) {
    const response = await mf.dispatchFetch('https://runtime-test.example/admin', { headers });
    assert.equal((await response.json()).ok, expected, name);
  }
  console.log(JSON.stringify({ status: 'runtime_auth_verified', checks: cases.length }));
} finally { await mf.dispose(); }
