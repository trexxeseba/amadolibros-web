import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { apiCheck, checklyApi, dedicatedMonitorDb } from '../../scripts/admin-web-monitor-connect.mjs';
import { readMonitorCoverage } from '../_shared/admin-web-coverage.js';
import { receiveCheckly, normalizeCheckly } from '../../worker-monitor/index.js';
const ids = ['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
const registry = Object.fromEntries(ids.map((id,i) => [id, { environment: 'production', component: ['sync','catalogo','portadas'][i], path: ['/api/status','/catalogo','/'][i], frequency: i === 2 ? 120 : 10 }]));
const now = new Date('2026-09-09T08:00:00Z');

test('provisión nunca selecciona pedidos y crea controles inactivos con alertas exclusivamente explícitas', async () => {
  await assert.rejects(dedicatedMonitorDb({ list: async () => [{ name: 'amadolibros-web-monitor', uuid: '6dc8dc3a-2d4f-4045-b428-14323c7b0bcd' }] }), /DATABASE_INVALID/);
  let writes = 0;
  assert.equal(await dedicatedMonitorDb({ list: async () => [], request: async () => { writes++; } }), null);
  assert.equal(writes, 0);
  const c = apiCheck('fixture', 'https://example.test/', 1440, 23);
  assert.equal(c.activated, false); assert.equal(c.doubleCheck, false); assert.equal(c.useGlobalAlertSettings, false);
  assert.equal(c.request.method, 'GET'); assert.deepEqual(c.alertChannelSubscriptions, [{ alertChannelId: 23, activated: true }]);
  const code = await readFile(new URL('../../scripts/admin-web-monitor-connect.mjs', import.meta.url), 'utf8');
  assert.match(code, /autoAssignAlerts=false/); assert.match(code, /autoSubscribe: false/);
  assert.match(code, /target: \{ checkId: \[id\] \}/);
  const api = checklyApi({ env: { CHECKLY_API_KEY: 'PRIVATE' }, fetchFn: async (url, options) => {
    assert.ok(url.startsWith('https://api.checklyhq.com/v1/'));
    assert.equal(options.redirect, 'manual');
    return new Response('PRIVATE ERROR', { status: 403 });
  } });
  await assert.rejects(api('/v1/checks'), /^Error: CHECKLY_GET_HTTP_403$/);
  await assert.rejects(api('https://untrusted.test/'), /CHECKLY_PATH_INVALID/);
});

test('última ejecución distingue fallo, pausa, atraso y falta de datos sin filtrar credenciales ni payload', async () => {
  const env = { CHECKLY_API_KEY: 'PRIVATE_KEY', ADMIN_WEB_MONITOR_CHECKS_JSON: JSON.stringify(registry) };
  const fetchFn = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer PRIVATE_KEY'); assert.equal(options.redirect, 'manual');
    if (url.endsWith('/v1/checks')) return Response.json(ids.map((id,i) => ({ id, activated: true, frequency: i===2?120:10, script: 'PRIVATE_SCRIPT' })));
    const id = ids.find(id => url.includes(id));
    return Response.json({ entries: [{ checkId: id, startedAt: id === ids[2] ? '2026-09-08T00:00:00Z' : '2026-09-09T07:58:00Z',
      hasFailures: id === ids[1], hasErrors: false, isDegraded: false, privateField: 'PRIVATE_PAYLOAD' }] });
  };
  const result = await readMonitorCoverage(env, now, fetchFn);
  assert.deepEqual(result.rows.map(r => r.state), ['passed','confirmed','stale']);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|11111111/);
  const empty = await readMonitorCoverage(env, now, async url => url.endsWith('/v1/checks') ? Response.json(ids.map((id,i) => ({ id, activated: i!==0, frequency: i===2?120:10 }))) : Response.json({ entries: [] }));
  assert.deepEqual(empty.rows.map(r => r.state), ['paused','unknown','unknown']);
  const redirect = await readMonitorCoverage(env, now, async () => new Response(null, { status: 302 }));
  assert.equal(redirect.status, 'unavailable');
  assert.equal((await readMonitorCoverage({}, now, () => assert.fail('sin configuración no consulta'))).status, 'unavailable');
});

test('fixture existe sólo en entorno de prueba y el contrato no acepta coerciones', async () => {
  let fixtureMode = 'failure';
  const env = { MONITOR_ENABLED: 'true', MONITOR_ENV: 'preview', MONITOR_HOST: 'fixture.test', MONITOR_ACCEPTANCE_MODE: 'enabled',
    MONITOR_DB: { prepare: () => ({ first: async () => ({ value: fixtureMode }) }) } };
  const request = new Request('https://fixture.test/_monitor-test');
  assert.equal((await receiveCheckly(request, env, now)).status, 503);
  fixtureMode = 'recovery';
  assert.equal((await receiveCheckly(request, env, now)).status, 200);
  assert.equal((await receiveCheckly(request, { ...env, MONITOR_ENV: 'production' }, now)).status, 404);
  assert.equal((await receiveCheckly(request, { ...env, MONITOR_ENABLED: 'false' }, now)).status, 404);
  const raw = { version: 1, checkId: ids[0], resultId: ids[1], alertType: 'ALERT_FAILURE', occurredAt: now.toISOString() };
  for (const k of ['checkId','resultId','alertType']) assert.throws(() => normalizeCheckly({ ...raw, [k]: [raw[k]] }, registry, 'production', now), /EVENT_INVALID/);
});
