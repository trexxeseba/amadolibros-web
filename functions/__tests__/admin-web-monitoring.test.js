import test from 'node:test';
import assert from 'node:assert/strict';
import { readWebHealth, WEB_STATUS_URL, webPeriod } from '../_shared/admin-web-data.js';
import { renderAdminWeb } from '../_shared/admin-web-view.js';

const now = new Date('2026-09-08T22:00:00Z');
const body = () => ({ status: 'ok', healthy: true, env: 'prod', checked_at: now.toISOString(),
  worker: { has_error: false, sync_fresh: true, in_progress: false, possibly_stuck: false,
    last_started: '2026-09-08T06:00:00Z', last_ok: '2026-09-08T06:10:00Z' },
  catalog: { available: true, meta_available: true, total_items: 120, last_updated: '2026-09-08T06:10:00Z' } });
const read = (value, status = 200) => readWebHealth(async (url, options) => {
  assert.equal(url, WEB_STATUS_URL);
  assert.equal(options.redirect, 'manual');
  assert.equal(options.headers, undefined);
  return Response.json(value, { status });
}, now);

test('diagnóstico distingue 503 verificable, estado sano acotado y falta de cobertura de fotos', async () => {
  const normal = await read(body());
  assert.equal(normal.status, 'ok');
  const raw = body(); raw.healthy = false; raw.status = 'degraded'; raw.worker.possibly_stuck = true;
  raw.worker.has_error = true; raw.warnings = ['sync_possibly_stuck', 'sync_error'];
  raw.private_payload = 'NEVER_RENDER';
  const health = await read(raw, 503);
  assert.equal(health.status, 'degraded');
  assert.deepEqual(health.warnings, ['sync_possibly_stuck', 'sync_error']);
  assert.doesNotMatch(JSON.stringify(health), /NEVER_RENDER/);
  const annotated = body(); annotated.worker.last_ok = 'Tue, 08 Sep 2026 06:10:00 GMT (private@example.test)';
  const normalized = await read(annotated);
  assert.equal(normalized.worker.lastOk, '2026-09-08T06:10:00.000Z');
  assert.doesNotMatch(JSON.stringify(normalized), /private@example/);
  const html = renderAdminWeb({ view: 'estado', period: webPeriod(7, now), health });
  assert.match(html, /podría haberse trancado/);
  assert.match(html, /Fotos y banners: detección pendiente de conexión/);
  assert.doesNotMatch(html, /Todas las fotos funcionan|Sin alertas en esta comprobación/);
});

test('diagnóstico caído, respuesta vieja o inconsistente nunca aparecen como salud verificada', async () => {
  for (const change of [r => r.checked_at = '2026-09-07T00:00:00Z', r => r.checked_at = '2026-10-01T00:00:00Z',
    r => r.env = 'preview', r => r.worker.has_error = 'false', r => delete r.worker, r => r.warnings = 'secret']) {
    const raw = body(); change(raw);
    assert.equal((await read(raw)).status, 'unavailable');
  }
  assert.equal((await read(body(), 503)).status, 'unavailable');
  assert.equal((await readWebHealth(async () => { throw new Error('offline'); }, now)).status, 'unavailable');
  assert.equal((await readWebHealth(async () => new Response(null, { status: 302 }), now)).status, 'unavailable');
  const empty = body(); empty.catalog.total_items = 0;
  assert.deepEqual((await read(empty)).warnings, ['catalog_empty']);
  for (const [code, status, state] of [['kv_unavailable', 503, 'degraded'], ['status_internal_error', 500, 'error']]) {
    assert.equal((await read({ code, status: state, healthy: false, checked_at: now.toISOString() }, status)).status, 'degraded');
  }
});
