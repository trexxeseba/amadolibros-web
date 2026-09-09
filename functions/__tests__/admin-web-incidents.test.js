import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { receiveCheckly, normalizeCheckly, pruneMonitorEvents } from '../../worker-monitor/index.js';
import { readWebIncidents } from '../_shared/admin-web-incidents.js';
import { incidentPanel } from '../_shared/admin-web-view.js';

const checkId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const now = new Date('2026-09-08T22:00:00Z');
function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../worker-monitor/schema.sql', import.meta.url), 'utf8'));
  const db = { prepare(sql) { const stmt = sqlite.prepare(sql); return { bind(...values) { return {
    async run() { stmt.run(...values); return { success: true }; }, async first() { return stmt.get(...values) || null; },
    async all() { return { success: true, results: stmt.all(...values) }; } }; } }; } };
  return { sqlite, env: { MONITOR_ENABLED: 'true', MONITOR_ENV: 'preview', MONITOR_HOST: 'monitor.example.test',
    MONITOR_DB: db, MONITOR_RATE_LIMITER: { limit: async () => ({ success: true }) }, CHECKLY_WEBHOOK_SECRET: 's'.repeat(48),
    MONITOR_CHECKS_JSON: JSON.stringify({ [checkId]: { environment: 'preview', component: 'portadas', path: '/libro/MLU123/prueba' } }) },
    read: () => readWebIncidents({ ADMIN_WEB_MONITOR_DB: db, ADMIN_WEB_MONITOR_ENV: 'preview' }, now) };
}
const event = (number, type = 'ALERT_FAILURE', seconds = 0) => ({ version: 1, checkId,
  resultId: `bbbbbbbb-bbbb-bbbb-bbbb-${String(number).padStart(12, '0')}`, alertType: type,
  occurredAt: new Date(now.getTime() - 3600000 + seconds * 1000).toISOString() });
async function signed(env, data, overrides = {}) {
  const body = JSON.stringify(data); const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.CHECKLY_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))).toString('hex');
  return new Request('https://monitor.example.test/webhooks/checkly', { method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-checkly-signature': signature }, ...overrides });
}

test('aviso firmado → registro → panel → recuperación; duplicados y avisos viejos son inocuos', async () => {
  const { env, read, sqlite } = setup();
  try {
    const fail = event(1);
    assert.equal((await receiveCheckly(await signed(env, fail), env, now)).status, 202);
    assert.match(incidentPanel(await read()), /Falla confirmada por el monitor/);
    assert.match(incidentPanel(await read()), /No son fallas observadas en la tienda productiva/);
    assert.equal((await receiveCheckly(await signed(env, fail), env, now)).status, 202);
    assert.equal((await read()).rows[0].events, 1);
    assert.equal((await receiveCheckly(await signed(env, event(2, 'ALERT_RECOVERY', 20)), env, now)).status, 202);
    assert.equal((await read()).rows[0].state, 'recovered');
    assert.equal((await receiveCheckly(await signed(env, event(3, 'ALERT_FAILURE', 10)), env, now)).status, 202);
    assert.equal((await read()).rows[0].state, 'recovered');
    assert.equal((await receiveCheckly(await signed(env, event(4, 'ALERT_FAILURE', 20)), env, now)).status, 202);
    assert.equal((await read()).rows[0].state, 'confirmed', 'A igual hora la falla prevalece');
    assert.equal((await receiveCheckly(await signed(env, { ...fail, occurredAt: event(1, 'ALERT_FAILURE', 1).occurredAt }), env, now)).status, 409);
  } finally { sqlite.close(); }
});

test('imagen para Google conserva enlace y recuperación en el registro real SQLite', async () => {
  const { env, read, sqlite } = setup();
  const path = '/libro/MLU651526046/big-english-1-british-pupil-s-book-pearson';
  env.MONITOR_CHECKS_JSON = JSON.stringify({ [checkId]: { environment:'preview',component:'google_imagen',path } });
  try {
    assert.equal((await receiveCheckly(await signed(env,event(1)),env,now)).status,202);
    const failed = await read();
    assert.equal(failed.rows[0].component,'google_imagen'); assert.equal(failed.rows[0].path,path);
    assert.ok(incidentPanel(failed).includes(`https://www.amadolibros.com${path}`));
    assert.equal((await receiveCheckly(await signed(env,event(2,'ALERT_RECOVERY',20)),env,now)).status,202);
    assert.equal((await read()).rows[0].state,'recovered');
    assert.equal((await read()).rows[0].events,2);
  } finally { sqlite.close(); }
});

test('rechazo de firma, entorno, datos extra, evento viejo y tamaño sin escritura', async () => {
  const { env, sqlite } = setup();
  try {
    assert.equal((await receiveCheckly(await signed(env, event(1), { headers: { 'content-type': 'application/json', 'x-checkly-signature': '0'.repeat(64) } }), env, now)).status, 401);
    for (const data of [{ ...event(1), email: 'private@example.test' }, { ...event(1), checkId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' },
      { ...event(1), occurredAt: '2026-01-01T00:00:00Z' }, { ...event(1), occurredAt: '2027-01-01T00:00:00Z' },
      { ...event(1), alertType: 'IGNORED' }]) assert.equal((await receiveCheckly(await signed(env, data), env, now)).status, 400);
    assert.equal((await receiveCheckly(await signed(env, { ...event(1), padding: 'x'.repeat(17000) }), env, now)).status, 413);
    assert.equal((await receiveCheckly(await signed(env, event(1)), { ...env, MONITOR_ENABLED: 'false' }, now)).status, 404);
    assert.equal((await receiveCheckly(await signed(env, event(1)), { ...env, MONITOR_ENV: 'production' }, now)).status, 400);
    assert.equal((await receiveCheckly(await signed(env, event(1)), { ...env, ORDERS_DB: env.MONITOR_DB }, now)).status, 503);
    assert.equal((await receiveCheckly(await signed(env, event(1)), { ...env, MONITOR_RATE_LIMITER: { limit: async () => ({ success: false }) } }, now)).status, 429);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM monitor_events').get().n, 0);
    assert.equal((await readWebIncidents({})).status, 'unavailable');
  } finally { sqlite.close(); }
});

test('transiciones oficiales de Checkly conservan fallas y mejoras parciales; retención separada', async () => {
  const { env, sqlite } = setup();
  try {
    const transitions = { ALERT_FAILURE: 'confirmed', ALERT_FAILURE_REMAIN: 'confirmed', ALERT_DEGRADED_FAILURE: 'confirmed',
      ALERT_DEGRADED: 'degraded', ALERT_DEGRADED_REMAIN: 'degraded', ALERT_FAILURE_DEGRADED: 'degraded',
      ALERT_RECOVERY: 'recovered', ALERT_DEGRADED_RECOVERY: 'recovered' };
    for (const [type, state] of Object.entries(transitions)) assert.equal(normalizeCheckly(event(1, type), JSON.parse(env.MONITOR_CHECKS_JSON), 'preview', now).state, state);
    await receiveCheckly(await signed(env, event(1)), env, now);
    const later = new Date(now.getTime() + 31 * 86400000);
    await pruneMonitorEvents(env, later);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM monitor_events').get().n, 1, 'Una falla abierta no vence');
    const reader = { ADMIN_WEB_MONITOR_DB: env.MONITOR_DB, ADMIN_WEB_MONITOR_ENV: 'preview' };
    assert.equal((await readWebIncidents(reader, later)).rows[0].state, 'confirmed');
    await receiveCheckly(await signed(env, { ...event(2, 'ALERT_RECOVERY'), occurredAt: later.toISOString() }), env, later);
    await pruneMonitorEvents(env, later);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM monitor_events').get().n, 1, 'El historial viejo sí vence');
    assert.equal((await readWebIncidents(reader, later)).rows[0].state, 'recovered');
  } finally { sqlite.close(); }
});
