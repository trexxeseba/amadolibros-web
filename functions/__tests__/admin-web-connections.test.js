import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { connectionD1, checkAdminConnections } from '../../scripts/admin-web-connections.mjs';

const now = new Date('2026-09-08T15:00:00Z');
const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'PRIVATE_TOKEN', GA4_ACCESS_TOKEN: 'PRIVATE_GA4' };

test('diagnóstico ejecuta lectores reales sobre SQLite read-only y no devuelve datos del negocio', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE orders (public_code TEXT,status TEXT,payment_status TEXT,delivery_type TEXT,created_at TEXT,expires_at TEXT);
    CREATE TABLE order_events(event_type TEXT,payload_json TEXT,created_at TEXT);
    INSERT INTO orders VALUES ('PRIVATE_ORDER','open','approved','pickup','2026-09-07T12:00:00Z','2099-01-01');
    INSERT INTO order_events VALUES ('customer_order_email','{"status":"sent","email":"PRIVATE_EMAIL"}','2026-09-07T12:00:00Z');
    PRAGMA query_only=ON;`);
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push(url);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    const { sql, params } = JSON.parse(options.body);
    assert.match(sql.trim(), /^SELECT/);
    return Response.json({ success: true, result: [{ success: true, results: db.prepare(sql).all(...params), meta: { rows_written: 0, changed_db: false } }] });
  };
  const result = await checkAdminConnections({ source: 'cloudflare', env, now, fetchFn });
  assert.deepEqual(result.checks, [{ name: 'orders_preview', status: 'ok' }, { name: 'orders_production', status: 'ok' }]);
  assert.equal(calls.length, 6);
  assert.equal(new Set(calls).size, 2, 'bases distintas por entorno');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|approved|summary|rows|total/);
  db.close();
});

test('D1 bloquea escritura, SQL múltiple, entorno desconocido y respuesta de modificación', async () => {
  const config = { accountId: env.CLOUDFLARE_ACCOUNT_ID, token: env.CLOUDFLARE_API_TOKEN, environment: 'preview' };
  assert.throws(() => connectionD1({ ...config, environment: 'other' }), /CONFIG/);
  assert.throws(() => connectionD1({ ...config, accountId: '../bad' }), /CONFIG/);
  const db = connectionD1({ ...config, fetchFn: async () => Response.json({ success: true,
    result: [{ success: true, results: [], meta: { rows_written: 1, changed_db: true } }] }) });
  for (const sql of ['DELETE FROM orders', 'SELECT 1; DELETE FROM orders', 'PRAGMA query_only=OFF', 'SELECT 1 -- comment']) {
    assert.throws(() => db.prepare(sql), /READ_ONLY/);
  }
  await assert.rejects(db.prepare('SELECT 1').bind().all(), /RESPONSE_INVALID/);
  const denied = await checkAdminConnections({ source: 'cloudflare', env, now,
    fetchFn: async () => new Response('PRIVATE_ERROR_WITH_TOKEN', { status: 403 }) });
  assert.ok(denied.checks.every(c => c.status === 'unavailable'));
  assert.doesNotMatch(JSON.stringify(denied), /PRIVATE_/);
});

test('GA4 comprueba ambos períodos sin guardar ni imprimir las métricas', async () => {
  const periods = [];
  const result = await checkAdminConnections({ source: 'ga4', env, now, fetchFn: async (url, options) => {
    assert.equal(new URL(url).host, 'analyticsdata.googleapis.com');
    const { requests } = JSON.parse(options.body);
    periods.push(requests[0].dateRanges[0]);
    return Response.json({ reports: requests.map(r => ({ metricHeaders: r.metrics, dimensionHeaders: r.dimensions,
      metadata: { timeZone: 'America/Montevideo' }, rows: [] })) });
  } });
  assert.deepEqual(result.checks, [{ name: 'ga4_7d', status: 'ok' }, { name: 'ga4_30d', status: 'ok' }]);
  assert.deepEqual(periods, [{ startDate: '2026-09-01', endDate: '2026-09-07' }, { startDate: '2026-08-09', endDate: '2026-09-07' }]);
  assert.doesNotMatch(JSON.stringify(result), /sessions|users|events|PRIVATE_/);
  assert.ok((await checkAdminConnections({ source: 'ga4', env: {}, now })).checks.every(c => c.status === 'unavailable'));
});

test('workflow restringido a rama exacta, sin despliegue, cron ni artifacts públicos', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/admin-web-connections.yml', import.meta.url), 'utf8');
  assert.equal(workflow.split("github.ref == 'refs/heads/codex/admin-web-observability'").length - 1, 3);
  assert.doesNotMatch(workflow, /upload-artifact|wrangler|schedule:|contents: write|pull_request_target|ADMIN_WEB_ENABLED/);
  assert.match(workflow, /analytics\.readonly/);
});
