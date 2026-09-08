import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { refreshAdminAnalytics, adminAnalyticsBundle, ADMIN_ANALYTICS_KEY } from '../../scripts/admin-web-refresh.mjs';
import { adminAnalyticsNamespace, ADMIN_ANALYTICS_TITLE } from '../../scripts/admin-web-cloudflare.mjs';
import { prepareAdminPreview, validateAdminPolicy, ADMIN_ACCESS_NAME } from '../../scripts/admin-web-preview.mjs';
import { readWebAnalytics, webPeriod, WEB_EVENTS, WEB_HOSTS } from '../_shared/admin-web-data.js';
import worker from '../../worker-admin/index.js';

const now = new Date('2026-09-08T21:00:00Z');
const namespaceId = 'b'.repeat(32);
const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'PRIVATE_CF', GA4_ACCESS_TOKEN: 'PRIVATE_GA4' };
const snapshot = days => ({ version: 1, scope: 'web-only', property: '543434807', hosts: WEB_HOSTS,
  period: webPeriod(days, now), extractedAt: now.toISOString(), summary: { sessions: 9, users: 7, views: 20 },
  events: Object.fromEntries(WEB_EVENTS.map(e => [e, 0])), channels: [], devices: [], pages: [] });

test('bundle guarda ambos períodos y elimina campos fuera del contrato', async () => {
  const snapshots = [7, 30].map(days => ({ ...snapshot(days), token: 'PRIVATE_TOKEN', buyer: 'PRIVATE_BUYER' }));
  const bundle = adminAnalyticsBundle(snapshots, now);
  assert.doesNotMatch(JSON.stringify(bundle), /PRIVATE_|buyer|token/);
  const binding = { get: async key => { assert.equal(key, ADMIN_ANALYTICS_KEY); return bundle; } };
  for (const days of [7, 30]) assert.equal((await readWebAnalytics({ APP_ENV: 'preview', ADMIN_WEB_ANALYTICS_KV: binding }, webPeriod(days, now), now)).status, 'ok');
  assert.equal((await readWebAnalytics({ APP_ENV: 'production', ADMIN_WEB_ANALYTICS_KV: { get: async () => bundle } }, webPeriod(7, now), now)).status, 'unavailable');
  assert.throws(() => adminAnalyticsBundle([snapshot(7)], now), /INCOMPLETE/);
  assert.throws(() => adminAnalyticsBundle([snapshot(30), snapshot(7)], now), /INVALID/);
  delete bundle.snapshots[30];
  assert.equal((await readWebAnalytics({ APP_ENV: 'preview', ADMIN_WEB_ANALYTICS_KV: binding }, webPeriod(7, now), now)).status, 'unavailable');
});

test('refresh GA4 → KV → lector: sólo una escritura completa en namespace propio', async () => {
  let stored;
  const writes = [];
  const fetchFn = async (url, options) => {
    if (url.startsWith('https://analyticsdata.googleapis.com/')) {
      const body = JSON.parse(options.body);
      return Response.json({ reports: body.requests.map(r => ({ metricHeaders: r.metrics, dimensionHeaders: r.dimensions,
        metadata: { timeZone: 'America/Montevideo' }, rows: [] })) });
    }
    if (url.endsWith('/storage/kv/namespaces?per_page=100&page=1')) return Response.json({ success: true,
      result: [{ id: namespaceId, title: ADMIN_ANALYTICS_TITLE }, { id: '6ea0ff4682d647118442a24fe384abc4', title: 'AMADO_KV' }] });
    assert.ok(url.includes(`/namespaces/${namespaceId}/values/preview%3Aga4%3Aweb%3Av2`));
    if (options.method === 'PUT') { writes.push(url); stored = JSON.parse(options.body); return Response.json({ success: true, result: {} }); }
    assert.equal(options.method, 'GET');
    return Response.json(stored);
  };
  const result = await refreshAdminAnalytics({ env, now, fetchFn });
  assert.equal(result.status, 'ok');
  assert.equal(writes.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|sessions|users/);
  assert.equal((await readWebAnalytics({ APP_ENV: 'preview', ADMIN_WEB_ANALYTICS_KV: { get: async () => stored } }, webPeriod(30, now), now)).status, 'ok');
});

test('un fallo de GA4 conserva el informe previo sin tocar Cloudflare', async () => {
  await assert.rejects(refreshAdminAnalytics({ env, now, fetchFn: async url => {
    assert.ok(url.startsWith('https://analyticsdata.googleapis.com/'));
    return new Response('PRIVATE_PROVIDER_ERROR', { status: 500 });
  } }));
  const cf = { list: async () => [], request: () => assert.fail('No crear almacenamiento implícito') };
  await assert.rejects(adminAnalyticsNamespace(cf), /NAMESPACE_INVALID/);
  const shared = { list: async () => [{ title: ADMIN_ANALYTICS_TITLE, id: '6ea0ff4682d647118442a24fe384abc4' }] };
  await assert.rejects(adminAnalyticsNamespace(shared), /NAMESPACE_INVALID/);
});

test('provisión restringe entrada al titular y configura sólo el Worker aislado', async () => {
  const email = 'owner@example.test';
  const policy = [{ decision: 'allow', include: [{ email: { email } }] }];
  const hostname = 'amadolibros-admin-preview.amado-test.workers.dev';
  const mutations = [];
  const cf = { list: async path => path === '/access/apps' ? [] : [{ id: namespaceId, title: ADMIN_ANALYTICS_TITLE }],
    request: async (path, opts) => {
      if (path === '/access/organizations') return { auth_domain: 'amado-test.cloudflareaccess.com' };
      if (path === '/workers/subdomain') return { subdomain: 'amado-test' };
      if (path === '/access/identity_providers') return [{ id: 'otp-id', type: 'onetimepin' }];
      if (path === '/access/apps') { mutations.push({ path, ...opts }); return { id: 'app-id', aud: 'c'.repeat(64), ...opts.body }; }
      if (path === '/access/apps/app-id/policies') return policy;
      assert.fail(path);
    } };
  const result = await prepareAdminPreview({ cf, ownerEmail: email });
  assert.equal(result.url, `https://${hostname}/admin`);
  assert.equal(result.config.name, 'amadolibros-admin-preview');
  assert.equal(result.config.vars.ADMIN_WEB_DATA_ENV, 'production');
  assert.equal(result.config.vars.ADMIN_WEB_ALLOWED_EMAILS, email);
  assert.equal(result.config.preview_urls, false);
  assert.equal(result.config.routes, undefined);
  assert.equal(result.config.kv_namespaces[0].id, namespaceId);
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].body.name, ADMIN_ACCESS_NAME);
  assert.deepEqual(mutations[0].body.policies[0].include, [{ email: { email } }]);
  assert.ok(validateAdminPolicy(policy, email));
  for (const bad of [[], [...policy, ...policy], [{ decision: 'bypass', include: [{ everyone: {} }] }],
    [{ decision: 'allow', include: [{ email_domain: { domain: 'example.test' } }] }]]) assert.equal(validateAdminPolicy(bad, email), false);
});

test('Worker no expone otras rutas, cabeceras falsas ni base de datos a anónimos', async () => {
  const runtime = { ADMIN_WEB_HOST: 'amadolibros-admin-preview.test.workers.dev', APP_ENV: 'preview', ADMIN_WEB_ENABLED: 'true',
    get ORDERS_DB() { assert.fail('No leer sin identidad válida'); } };
  const request = path => new Request(`https://${runtime.ADMIN_WEB_HOST}${path}`, { headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.test' } });
  assert.equal((await worker.fetch(request('/'), runtime)).headers.get('location'), '/admin');
  assert.equal((await worker.fetch(request('/api/orders'), runtime)).status, 404);
  assert.equal((await worker.fetch(request('/admin?format=json'), runtime)).status, 403);
  assert.equal((await worker.fetch(new Request('https://evil.test/admin'), runtime)).status, 404);
});

test('calendario comparte lock con deploy y sólo actualiza el almacenamiento existente', async () => {
  const refresh = await readFile(new URL('../../.github/workflows/admin-web-refresh.yml', import.meta.url), 'utf8');
  const preview = await readFile(new URL('../../.github/workflows/admin-web-preview.yml', import.meta.url), 'utf8');
  for (const workflow of [refresh, preview]) {
    assert.match(workflow, /group: admin-web-private-data/);
    assert.doesNotMatch(workflow, /upload-artifact|contents: write|pull_request_target/);
  }
  assert.doesNotMatch(refresh, /wrangler|--create-preview-storage/);
  assert.match(refresh, /cron: '17 \* \* \* \*'/);
  assert.match(preview, /github.ref == 'refs\/heads\/codex\/admin-web-observability'/);
});
