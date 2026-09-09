// Conecta únicamente recursos identificados de ADMIN-WEB-01. No usa main ni escribe negocio.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { adminCloudflare } from './admin-web-cloudflare.mjs';
import { AMADO_CHECKLY_ACCOUNT } from './admin-web-checkly-connection.mjs';
import { installImageSensor } from './admin-web-image-sensor.mjs';
import { GOOGLE_IMAGE_PATH, googleImageCheckScript } from './admin-web-google-image-check.mjs';

export const MONITOR_WORKER = 'amadolibros-web-monitor';
export const MONITOR_DATABASE = 'amadolibros-web-monitor';
export const MONITOR_CHANNEL = 'Amado web - backend privado';
const TAG = 'amado-admin-web-v1';
const BUSINESS_DB = '6dc8dc3a-2d4f-4045-b428-14323c7b0bcd';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const run = promisify(execFile);
const log = (status, extra = {}) => console.log(JSON.stringify({ status, ...extra }));
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function checklyApi({ env = process.env, fetchFn = fetch } = {}) {
  if (!env.CHECKLY_API_KEY) throw new Error('CHECKLY_KEY_REQUIRED');
  return async (path, { method = 'GET', body } = {}) => {
    if (!/^\/v[12]\/[a-z0-9/?=&,._-]+$/i.test(path)) throw new Error('CHECKLY_PATH_INVALID');
    const response = await fetchFn(`https://api.checklyhq.com${path}`, { method, redirect: 'manual',
      headers: { Authorization: `Bearer ${env.CHECKLY_API_KEY}`, 'X-Checkly-Account': AMADO_CHECKLY_ACCOUNT,
        Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`CHECKLY_${method}_HTTP_${response.status}`);
    return response.status === 204 ? null : response.json();
  };
}

export function baseCheck(name, frequency, channelId) {
  return { name, activated: false, muted: false, doubleCheck: false, retryStrategy: null,
    locations: ['us-east-1'], runParallel: false, frequency, tags: [TAG],
    useGlobalAlertSettings: false,
    alertSettings: { escalationType: 'RUN_BASED', runBasedEscalation: { failedRunThreshold: 1 },
      reminders: { amount: 0, interval: 5 }, sslCertificates: { enabled: false, alertThreshold: 30 } },
    alertChannelSubscriptions: [{ alertChannelId: channelId, activated: true }] };
}
const statusAssertion = { source: 'STATUS_CODE', comparison: 'EQUALS', target: '200' };
export function apiCheck(name, url, frequency, channelId, assertions = []) {
  return { ...baseCheck(name, frequency, channelId), checkType: 'API',
    degradedResponseTime: 8000, maxResponseTime: 15000,
    request: { method: 'GET', url, followRedirects: false, skipSSL: false,
      headers: [{ key: 'User-Agent', value: 'Amado-Web-Monitor/1.0' }],
      assertions: [statusAssertion, ...assertions] } };
}

export async function dedicatedMonitorDb(cf, { create = false } = {}) {
  const rows = await cf.list('/d1/database');
  const found = rows.filter(r => r.name === MONITOR_DATABASE);
  if (found.length > 1) throw new Error('MONITOR_DATABASE_AMBIGUOUS');
  const db = found[0] || (create ? await cf.request('/d1/database', { method: 'POST', body: { name: MONITOR_DATABASE } }) : null);
  if (!db) return null;
  const id = db.uuid || db.id;
  if (db.name !== MONITOR_DATABASE || !UUID.test(id || '') || id === BUSINESS_DB) throw new Error('MONITOR_DATABASE_INVALID');
  return { id, name: MONITOR_DATABASE };
}

export async function pauseOwnedChecks(api = checklyApi()) {
  const inventory = await api('/v1/checks');
  for (const check of inventory.filter(c => c.tags?.includes(TAG) && c.activated)) {
    if (!UUID.test(check.id)) throw new Error('CHECKLY_CHECK_ID_INVALID');
    const fields = ['name','checkType','frequency','script','request','runtimeId','locations','tags','alertChannelSubscriptions','alertSettings','useGlobalAlertSettings','degradedResponseTime','maxResponseTime'];
    const body = { ...Object.fromEntries(Object.entries(check).filter(([key]) => fields.includes(key))), activated: false, doubleCheck: false, retryStrategy: null };
    await api(`/v1/checks/${check.checkType === 'BROWSER' ? 'browser' : 'api'}/${check.id}?autoAssignAlerts=false`, { method: 'PUT', body });
  }
  log('owned_monitor_checks_paused');
}

export async function connectMonitor({ env = process.env, cf = adminCloudflare({ env }), api = checklyApi({ env }) } = {}) {
  const checks = new Map(); let accepted = false; let testId; let phase = 'preflight';
  const putCheck = async (definition, existingId) => {
    const endpoint = definition.checkType === 'BROWSER' ? 'browser' : 'api';
    const result = await api(`/v1/checks/${endpoint}${existingId ? `/${existingId}` : ''}?autoAssignAlerts=false`,
      { method: existingId ? 'PUT' : 'POST', body: definition });
    if (!UUID.test(result?.id || '')) throw new Error('CHECKLY_CHECK_ID_INVALID');
    checks.set(result.id, definition);
    const saved = await api(`/v1/checks/${result.id}`);
    const wanted = definition.alertChannelSubscriptions;
    if (!Array.isArray(saved.alertChannelSubscriptions) || saved.alertChannelSubscriptions.length !== wanted.length ||
        saved.alertChannelSubscriptions.some(s => !wanted.some(w => w.alertChannelId === s.alertChannelId && w.activated === s.activated)))
      throw new Error('CHECKLY_SUBSCRIPTIONS_MISMATCH');
    return result.id;
  };
  try {
    const inventory = await api('/v1/checks');
    if (!Array.isArray(inventory)) throw new Error('CHECKLY_INVENTORY_INVALID');
    const owned = inventory.filter(c => c.tags?.includes(TAG));
    // Una cuenta con otros controles activos necesita recalcular su consumo, sin alterarlos.
    if (inventory.some(c => c.activated && !c.tags?.includes(TAG))) throw new Error('CHECKLY_EXISTING_USAGE_REQUIRES_REVIEW');
    const plans = await api('/v1/accounts/me/entitlements');
    if (!['trial', 'hobby'].includes(plans.plan)) throw new Error('CHECKLY_PLAN_REQUIRES_REVIEW');
    if (!plans.locations?.all?.some(l => l.id === 'us-east-1' && l.available)) throw new Error('CHECKLY_LOCATION_UNAVAILABLE');
    log('monitor_preflight_verified', { plan: plans.plan, accountMatched: true, otherActiveChecks: 0 });
    // Pausar sólo controles de esta integración antes de cambiar su receptor/secreto.
    for (const c of owned) {
      if (!UUID.test(c.id)) throw new Error('CHECKLY_CHECK_ID_INVALID');
      const old = { ...baseCheck(c.name, c.frequency, 1), ...Object.fromEntries(Object.entries(c).filter(([k]) =>
        ['name','checkType','frequency','script','request','runtimeId','locations','tags','alertChannelSubscriptions','alertSettings','useGlobalAlertSettings','degradedResponseTime','maxResponseTime'].includes(k))) };
      await putCheck(old, c.id);
    }
    const sub = await cf.request('/workers/subdomain');
    if (sub.subdomain !== 'undiaes') throw new Error('MONITOR_SUBDOMAIN_MISMATCH');
    const host = `${MONITOR_WORKER}.${sub.subdomain}.workers.dev`;
    const db = await dedicatedMonitorDb(cf, { create: true });
    const query = async (sql, params = []) => {
      if (db.id === BUSINESS_DB) throw new Error('BUSINESS_DATABASE_FORBIDDEN');
      const r = await cf.request(`/d1/database/${db.id}/query`, { method: 'POST', body: { sql, params } });
      if (!Array.isArray(r) || r.some(x => x.success === false)) throw new Error('MONITOR_QUERY_FAILED');
      return r[0]?.results || [];
    };
    // Ejecutar cada DDL de esta base por separado y verificar que existan ambos contratos.
    const schema = (await readFile('worker-monitor/schema.sql', 'utf8')).replace(/^--.*$/gm, '');
    for (const statement of schema.split(';').map(s => s.trim()).filter(Boolean)) await query(statement);
    await query('SELECT delivery_id FROM monitor_events LIMIT 1');
    await query('SELECT key FROM monitor_config LIMIT 1');
    const fixtureMode = value => query("INSERT INTO monitor_config(key,value) VALUES ('acceptance_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [value]);
    await fixtureMode('recovery');
    const secret = randomBytes(32).toString('hex');
    const channelDefinition = { type: 'WEBHOOK', sendFailure: true, sendRecovery: true, sendDegraded: true,
      autoSubscribe: false, sslExpiry: false, subscriptions: [], config: { name: MONITOR_CHANNEL,
        method: 'POST', url: `https://${host}/webhooks/checkly`, webhookSecret: secret,
        headers: [{ key: 'Content-Type', value: 'application/json' }], queryParameters: [],
        template: JSON.stringify(JSON.parse(await readFile('worker-monitor/checkly-webhook.template.json', 'utf8'))) } };
    const channels = await api('/v1/alert-channels');
    const found = channels.filter(c => c.type === 'WEBHOOK' && c.config?.name === MONITOR_CHANNEL);
    if (found.length > 1 || found.some(c => c.config.url !== channelDefinition.config.url ||
      c.subscriptions?.some(s => !owned.some(o => o.id === s.checkId)))) throw new Error('CHECKLY_CHANNEL_OWNERSHIP_INVALID');
    phase = 'channel';
    const channel = await api(`/v1/alert-channels${found[0] ? `/${found[0].id}` : ''}`,
      { method: found[0] ? 'PUT' : 'POST', body: channelDefinition });
    if (!Number.isSafeInteger(channel.id) || channel.id < 1) throw new Error('CHECKLY_CHANNEL_INVALID');
    const upsert = async definition => {
      const matches = owned.filter(c => c.name === definition.name);
      if (matches.length > 1) throw new Error('CHECKLY_CHECK_AMBIGUOUS');
      return putCheck(definition, matches[0]?.id);
    };
    const fixtureDefinition = apiCheck('Amado - prueba de entrega al backend', `https://${host}/_monitor-test`, 1440, channel.id);
    testId = await upsert(fixtureDefinition);
    const statusId = await upsert(apiCheck('Amado - catalogo y sincronizacion', 'https://www.amadolibros.com/api/status', 10, channel.id,
      [{ source: 'JSON_BODY', property: '$.healthy', comparison: 'EQUALS', target: 'true' },
       { source: 'JSON_BODY', property: '$.catalog.total_items', comparison: 'GREATER_THAN', target: '0' }]));
    const navigationId = await upsert(apiCheck('Amado - disponibilidad del catalogo', 'https://www.amadolibros.com/catalogo', 10, channel.id,
      [{ source: 'TEXT_BODY', comparison: 'CONTAINS', target: 'Amado' }]));
    const browserSource = await readFile('scripts/admin-web-checkly-browser.js', 'utf8');
    const browserId = await upsert({ ...baseCheck('Amado - portadas banners y ficha', 120, channel.id),
      checkType: 'BROWSER', runtimeId: '2026.04', script: browserSource.replace('/* AMADO_IMAGE_SENSOR */', `const installImageSensor = ${installImageSensor.toString()};`) });
    const googleImageId = await upsert({ ...baseCheck('Amado - imagen declarada para Google', 120, channel.id),
      checkType: 'BROWSER', runtimeId: '2026.04', script: googleImageCheckScript() });
    const production = {
      [statusId]: { environment: 'production', component: 'sync', path: '/api/status', frequency: 10 },
      [navigationId]: { environment: 'production', component: 'catalogo', path: '/catalogo', frequency: 10 },
      [browserId]: { environment: 'production', component: 'portadas', path: '/', frequency: 120 },
      [googleImageId]: { environment: 'production', component: 'google_imagen', path: GOOGLE_IMAGE_PATH, frequency: 120 },
    };
    const fixtureRegistry = { [testId]: { environment: 'preview', component: 'navegacion', path: '/_monitor-test', frequency: 1440 } };
    const configPath = resolve('worker-monitor/wrangler.connected.json');
    const waitHttp = async (path, expected, method = 'GET') => {
      let status = 0;
      for (let attempt = 0; attempt < 15; attempt++) {
        const response = await fetch(`https://${host}${path}`, { method, redirect: 'manual',
          ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
          signal: AbortSignal.timeout(10000) });
        status = response.status; await response.body?.cancel();
        if (status === expected) return;
        if (method === 'POST' && status === 200) throw new Error('MONITOR_UNSIGNED_ACCEPTED');
        await sleep(2000);
      }
      throw new Error(`MONITOR_PROPAGATION_HTTP_${status}_EXPECTED_${expected}`);
    };
    const config = { name: MONITOR_WORKER, main: 'index.js', compatibility_date: '2024-09-23',
      workers_dev: true, preview_urls: false, observability: { enabled: false },
      vars: { MONITOR_ENABLED: 'false', MONITOR_ENV: 'preview', MONITOR_HOST: host, MONITOR_CHECKS_JSON: JSON.stringify(fixtureRegistry),
        MONITOR_ACCEPTANCE_MODE: 'enabled' },
      d1_databases: [{ binding: 'MONITOR_DB', database_name: db.name, database_id: db.id }],
      ratelimits: [{ name: 'MONITOR_RATE_LIMITER', namespace_id: '2026090901', simple: { limit: 60, period: 60 } }],
      triggers: { crons: ['23 4 * * *'] } };
    const deploy = async () => {
      await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
      try { await run('npx', ['--yes', 'wrangler@4.107.0', 'deploy', '--config', configPath],
        { env, maxBuffer: 4 * 1024 * 1024, timeout: 180000 }); }
      catch { throw new Error('MONITOR_DEPLOY_FAILED'); }
    };
    phase = 'receiver';
    await deploy();
    await cf.request(`/workers/scripts/${MONITOR_WORKER}/secrets`, { method: 'PUT', body: { name: 'CHECKLY_WEBHOOK_SECRET', text: secret, type: 'secret_text' } });
    config.vars.MONITOR_ENABLED = 'true'; await deploy();
    // La respuesta 401 confirma que el binding real existe y el receptor exige firma.
    await waitHttp('/webhooks/checkly', 401, 'POST');
    await waitHttp('/_monitor-test', 200);
    const waitEvent = async (state, result) => {
      if (!UUID.test(result?.id || '')) throw new Error('CHECKLY_RESULT_ID_INVALID');
      for (let attempt = 0; attempt < 24; attempt++) {
        const alertTypes = state === 'confirmed' ? ['ALERT_FAILURE','ALERT_FAILURE_REMAIN','ALERT_DEGRADED_FAILURE'] : ['ALERT_RECOVERY','ALERT_DEGRADED_RECOVERY','ALERT_RECOVERY'];
        const events = await query('SELECT state FROM monitor_events WHERE delivery_id IN (?,?,?)',
          alertTypes.map(type => `${testId}:${result.id}:${type}`));
        if (events.some(event => event.state === state)) return;
        await sleep(15000);
      }
      throw new Error(`CHECKLY_DELIVERY_${state.toUpperCase()}_TIMEOUT`);
    };
    const trigger = id => api('/v2/check-sessions/trigger', { method: 'POST', body: { target: { checkId: [id] }, refreshCache: true } });
    const waitResult = async (id, since, failures = null) => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const r = await api(`/v2/check-results/${id}?limit=1&resultType=FINAL&fields=id,checkId,hasFailures,hasErrors,startedAt`);
        const entry = r.entries?.[0];
        if (entry?.checkId === id && Date.parse(entry.startedAt) >= Date.parse(since) && (failures === null || entry.hasFailures === failures)) return entry;
        await sleep(10000);
      }
      throw new Error('CHECKLY_RESULT_TIMEOUT');
    };
    const runFixture = async failures => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const since = new Date().toISOString();
        await trigger(testId);
        const result = await waitResult(testId, since);
        if (result.hasFailures === failures && result.hasErrors === false) return result;
        log('fixture_result_retry', { expectedFailure: failures, observedFailure: result.hasFailures === true });
        await sleep(10000);
      }
      throw new Error('CHECKLY_FIXTURE_RESPONSE_MISMATCH');
    };
    phase = 'healthy_baseline';
    await putCheck({ ...fixtureDefinition, activated: true }, testId);
    await runFixture(false);
    phase = 'real_failure';
    await fixtureMode('failure');
    await waitHttp('/_monitor-test', 503);
    await waitEvent('confirmed', await runFixture(true)); log('real_checkly_failure_received', { fixtureOnly: true, signed: true });
    await fixtureMode('recovery');
    await waitHttp('/_monitor-test', 200);
    phase = 'real_recovery';
    await waitEvent('recovered', await runFixture(false)); log('real_checkly_recovery_received', { fixtureOnly: true, signed: true });
    await putCheck(fixtureDefinition, testId);
    config.vars.MONITOR_ENV = 'production'; config.vars.MONITOR_CHECKS_JSON = JSON.stringify(production);
    delete config.vars.MONITOR_ACCEPTANCE_MODE;
    await deploy();
    await waitHttp('/_monitor-test', 404);
    phase = 'activate';
    const firstProductionRun = new Date().toISOString();
    for (const id of Object.keys(production)) { await putCheck({ ...checks.get(id), activated: true }, id); await trigger(id); }
    for (const id of Object.keys(production)) {
      const result = await waitResult(id, firstProductionRun);
      if (result.hasErrors === true) throw new Error('CHECKLY_RUNTIME_ERROR');
      log('production_check_executed', { component: production[id].component, failed: result.hasFailures === true, monitorError: result.hasErrors === true });
    }
    await cf.request('/workers/scripts/amadolibros-admin-preview/secrets', { method: 'PUT', body: {
      name: 'CHECKLY_API_KEY', text: env.CHECKLY_API_KEY, type: 'secret_text' } });
    const connection = { version: 1, environment: 'production', deliveryVerifiedAt: new Date().toISOString(), checks: production };
    await query("INSERT INTO monitor_config (key,value) VALUES ('connection',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(connection)]);
    accepted = true;
    log('monitoring_connected', { realProviderDeliveryVerified: true, activeChecks: 4, apiFrequencyMinutes: 10,
      browserFrequencyMinutes: 120, maximumScheduledBrowserRuns31Days: 744, fixtureDeactivated: true,
      shopDeployed: false, businessWrites: 0 });
  } catch (error) {
    log('monitor_connection_incomplete', { phase }); throw error;
  } finally {
    if (!accepted) {
      // Reintentos no dejan pruebas ni una activación parcial corriendo sin comprobación.
      for (const [id, definition] of checks) {
        try { await putCheck({ ...definition, activated: false }, id); } catch { log('monitor_pause_requires_attention'); }
      }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { if (process.argv.includes('--pause-owned')) await pauseOwnedChecks(); else await connectMonitor(); }
  catch (error) { console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'MONITOR_CONNECTION_FAILED'); process.exitCode = 1; }
}
