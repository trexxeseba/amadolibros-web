// Ensayo reproducible de desarrollo: Chromium + workerd + D1 efímero.
// Sólo fixtures locales. No contacta la tienda, Checkly ni clientes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { installImageSensor } from './admin-web-image-sensor.mjs';
import { readWebIncidents } from '../functions/_shared/admin-web-incidents.js';
import { renderAdminWeb } from '../functions/_shared/admin-web-view.js';
import { webPeriod } from '../functions/_shared/admin-web-data.js';

const { chromium } = await import(pathToFileURL(resolve(process.argv[2])).href);
const { Miniflare } = await import(pathToFileURL(resolve(process.argv[3])).href);
const root = fileURLToPath(new URL('../', import.meta.url));
const checkId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const secret = crypto.randomUUID() + crypto.randomUUID();
const monitorHost = 'monitor-e2e.example.test';
const mf = new Miniflare({ compatibilityDate: '2024-09-23',
  modules: [{ type: 'ESModule', path: resolve(root, 'monitor-e2e.js'), contents:
    `import worker from './worker-monitor/index.js';
     export default {fetch(request, env) {return worker.fetch(request, {...env,
       MONITOR_RATE_LIMITER: {limit: async()=>({success:true})}});}};` },
    { type: 'ESModule', path: resolve(root, 'worker-monitor/index.js'), contents: await readFile(resolve(root, 'worker-monitor/index.js'), 'utf8') }],
  d1Databases: { MONITOR_DB: 'admin-monitor-e2e' },
  bindings: { MONITOR_HOST: monitorHost, MONITOR_ENV: 'preview', MONITOR_ENABLED: 'true', CHECKLY_WEBHOOK_SECRET: secret,
    MONITOR_CHECKS_JSON: JSON.stringify({ [checkId]: { environment: 'preview', component: 'portadas', path: '/prueba' } }) },
  outboundService: () => { throw new Error('NO_EXTERNAL_NETWORK'); },
});
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNYYKDwHwAEVAHwiIEm0gAAAABJRU5ErkJggg==', 'base64');
let panelHtml = ''; let fixed = false;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/panel') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(panelHtml); return; }
  if (url.pathname === '/api/probe') { res.writeHead(fixed ? 200 : 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: fixed })); return; }
  if (url.pathname.endsWith('.png')) {
    if (!fixed && url.pathname === '/broken.png') { res.writeHead(404).end(); return; }
    if (!fixed && url.pathname === '/invalid.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end('invalid image bytes'); return; }
    const send = () => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); };
    if (!fixed && url.pathname === '/slow.png') setTimeout(send, 900); else send();
    return;
  }
  if (url.pathname !== '/prueba') { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="es"><meta charset="utf-8"><title>Prueba aislada de imágenes</title>
    <h1>Prueba aislada; sin datos de clientes</h1>
    <img id="broken" width="90" height="120" alt="Portada de prueba" src="/broken.png" onerror="this.onerror=null;this.src='/logo.png'">
    <img id="invalid" width="90" height="120" alt="Archivo inválido de prueba" src="/invalid.png">
    <img id="slow" width="90" height="120" alt="Portada lenta de prueba" src="/slow.png">
    <div style="height:50000px"></div><img id="lazy" width="90" height="120" loading="lazy" alt="Portada fuera de pantalla" src="/lazy.png"></html>`);
});
let browser;
try {
  const db = await mf.getD1Database('MONITOR_DB');
  const schema = (await readFile(resolve(root, 'worker-monitor/schema.sql'), 'utf8')).replace(/^--.*$/gm, '');
  for (const statement of schema.split(';').filter(x => x.trim())) await db.prepare(statement).run();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
  await page.route('**/*', route => new URL(route.request().url()).origin === origin && route.request().method() === 'GET'
    ? route.continue() : route.abort());
  await page.addInitScript(installImageSensor, { slowMs: 120 });
  await page.goto(`${origin}/prueba`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__amadoImageMonitor.events.some(e => e.resource === '/slow.png' && e.state === 'loaded_after_delay'));
  const observations = await page.evaluate(() => window.__amadoImageMonitor.events);
  assert.ok(observations.some(e => e.resource === '/broken.png' && e.state === 'broken'));
  assert.ok(observations.some(e => e.resource === '/invalid.png' && e.state === 'broken'));
  assert.ok(observations.some(e => e.resource === '/slow.png' && e.state === 'slow'));
  assert.ok(observations.some(e => e.resource === '/logo.png' && e.state === 'fallback_loaded'));
  assert.ok(!observations.some(e => e.resource === '/broken.png' && e.state === 'recovered'));
  assert.ok(!observations.some(e => e.resource === '/lazy.png'));
  assert.equal(await page.evaluate(async () => (await fetch('/api/probe')).status), 500);

  const started = Date.now() - 10000;
  async function deliver(number, alertType, seconds, valid = true) {
    const body = JSON.stringify({ version: 1, checkId, resultId: `bbbbbbbb-bbbb-bbbb-bbbb-${String(number).padStart(12, '0')}`,
      alertType, occurredAt: new Date(started + seconds * 1000).toISOString() });
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))).toString('hex');
    return mf.dispatchFetch(`https://${monitorHost}/webhooks/checkly`, { method: 'POST', body,
      headers: { 'content-type': 'application/json', 'x-checkly-signature': valid ? signature : '0'.repeat(64) } });
  }
  const read = () => readWebIncidents({ ADMIN_WEB_MONITOR_DB: db, ADMIN_WEB_MONITOR_ENV: 'preview' });
  assert.equal((await deliver(1, 'ALERT_FAILURE', 0)).status, 202);
  let incidents = await read(); assert.equal(incidents.rows[0].state, 'confirmed');
  panelHtml = renderAdminWeb({ view: 'estado', period: webPeriod(7), incidents, environment: 'preview', checkedAt: new Date().toISOString() });
  await page.goto(`${origin}/panel`);
  assert.equal(await page.getByText('Falla confirmada por el monitor', { exact: true }).count(), 1);

  fixed = true;
  await page.goto(`${origin}/prueba`, { waitUntil: 'load' });
  const checked = await page.locator('#broken, #invalid, #slow').evaluateAll(images => images.every(img => img.complete && img.naturalWidth > 0 && !img.currentSrc.endsWith('/logo.png')));
  assert.equal(checked, true);
  assert.deepEqual(await page.evaluate(() => window.__amadoImageMonitor.events.filter(e => e.state === 'broken')), []);
  assert.equal(await page.evaluate(async () => (await fetch('/api/probe')).status), 200);
  assert.equal((await deliver(2, 'ALERT_RECOVERY', 2)).status, 202);
  assert.equal((await deliver(2, 'ALERT_RECOVERY', 2)).status, 202);
  assert.equal((await deliver(3, 'ALERT_FAILURE', 1)).status, 202);
  assert.equal((await deliver(4, 'ALERT_FAILURE', 3, false)).status, 401);
  incidents = await read(); assert.equal(incidents.rows[0].state, 'recovered'); assert.equal(incidents.rows[0].events, 3);
  panelHtml = renderAdminWeb({ view: 'estado', period: webPeriod(7), incidents, environment: 'preview', checkedAt: new Date().toISOString() });
  await page.goto(`${origin}/panel`);
  assert.equal(await page.getByText('Recuperado en la comprobación', { exact: true }).count(), 1);
  console.log(JSON.stringify({ status: 'monitoring_e2e_verified', mode: 'controlled_local_fixtures', browser: 'Chromium',
    receiver: 'workerd', database: 'ephemeral_D1', scenarios: ['broken_image', 'invalid_200_image', 'visible_slow_image',
      'fallback_is_not_recovery', 'lazy_offscreen_no_false_alert', 'api_500_and_recovery', 'signed_incident_rendered',
      'recovery_rendered', 'duplicate_idempotency', 'late_event_ordering', 'forged_signature_rejected'], productionActivated: false }));
} finally {
  await browser?.close(); await mf.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
