import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { verifyAdminAccess } from '../_shared/admin-web-auth.js';
import { WEB_HOSTS, WEB_EVENTS, webPeriod, readWebOrders, readWebEmails, readWebCatalog, readWebSync,
  validateWebAnalytics, readWebAnalytics } from '../_shared/admin-web-data.js';
import { renderAdminWeb } from '../_shared/admin-web-view.js';
import { onRequest } from '../admin.js';
import { buildAdminGa4Requests, exportAdminGa4 } from '../../scripts/admin-web-ga4-export.mjs';
import { buildAdminWebReview } from '../../scripts/admin-web-review.mjs';

const fixedNow = new Date('2026-09-07T23:00:00Z');
const period = webPeriod(7, fixedNow);
const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', keys.publicKey), kid: 'admin-test-key', alg: 'RS256', use: 'sig' };
const env = { APP_ENV: 'preview', ADMIN_WEB_ENABLED: 'true', ADMIN_WEB_HOST: 'pr-admin.amadolibros-web.pages.dev',
  ADMIN_WEB_ACCESS_TEAM: 'amado-admin-test.cloudflareaccess.com', ADMIN_WEB_ACCESS_AUD: 'test-audience',
  ADMIN_WEB_ALLOWED_EMAILS: 'owner@example.test' };
const certs = async () => Response.json({ keys: [jwk] });
const encode = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
async function signed(claimChanges = {}, headerChanges = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: `https://${env.ADMIN_WEB_ACCESS_TEAM}`, aud: [env.ADMIN_WEB_ACCESS_AUD],
    email: 'owner@example.test', sub: 'test-user', iat: now - 1, exp: now + 60, ...claimChanges };
  const body = `${encode({ alg: 'RS256', kid: jwk.kid, ...headerChanges })}.${encode(payload)}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(body));
  return `${body}.${Buffer.from(signature).toString('base64url')}`;
}
const request = (token, suffix = '', method = 'GET') => new Request(`https://${env.ADMIN_WEB_HOST}/admin${suffix}`,
  { method, headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {} });

function snapshot() {
  return { version: 1, property: '543434807', scope: 'web-only', hosts: WEB_HOSTS,
    period: { startDate: period.startDate, endDate: period.endDate, timeZone: period.timeZone },
    extractedAt: fixedNow.toISOString(), summary: { sessions: 12, users: 10, views: 30 },
    events: Object.fromEntries(WEB_EVENTS.map(k => [k, 0])), channels: [], devices: [], pages: [] };
}

test('períodos cerrados respetan medianoche de Uruguay, meses y años', () => {
  assert.equal(period.start, '2026-08-31T03:00:00.000Z');
  assert.equal(period.end, '2026-09-07T03:00:00.000Z');
  assert.equal(period.endDate, '2026-09-06');
  assert.equal(webPeriod(7, new Date('2027-01-01T01:00:00Z')).endDate, '2026-12-30');
  assert.throws(() => webPeriod(365), /INVALID_PERIOD/);
});

test('Access exige firma válida, audiencia, emisor, vigencia y correo autorizado', async () => {
  assert.equal(await verifyAdminAccess(request(await signed()), env, { fetchFn: certs }), true);
  for (const change of [{ aud: ['other'] }, { iss: 'https://other.cloudflareaccess.com' }, { email: 'other@example.test' },
    { exp: 1 }, { exp: '9999999999' }, { iat: 9999999999 }, { nbf: 9999999999 }, { sub: '' }]) {
    assert.equal(await verifyAdminAccess(request(await signed(change)), env, { fetchFn: certs }), false, JSON.stringify(change));
  }
  const valid = await signed();
  const parts = valid.split('.');
  parts[2] = encode('firma falsa');
  assert.equal(await verifyAdminAccess(request(parts.join('.')), env, { fetchFn: certs }), false);
  assert.equal(await verifyAdminAccess(request(await signed({}, { alg: 'none' })), env, { fetchFn: certs }), false);
  assert.equal(await verifyAdminAccess(request(valid), { ...env, ADMIN_WEB_ALLOWED_EMAILS: '' }), false);
  assert.equal(await verifyAdminAccess(request(valid), { ...env, ADMIN_WEB_ACCESS_TEAM: 'evil.test/path' }), false);
});

test('desactivado o anónimo: rechaza antes de leer D1 o GA4; cabecera email no autoriza', async () => {
  const protectedEnv = { ...env, get ORDERS_DB() { assert.fail('No debe leer pedidos'); },
    get ADMIN_WEB_ANALYTICS_KV() { assert.fail('No debe leer GA4'); } };
  const off = await onRequest({ request: request(), env: { ...env, ADMIN_WEB_ENABLED: 'false' } });
  assert.equal(off.status, 404);
  const anon = request();
  anon.headers.set('Cf-Access-Authenticated-User-Email', 'owner@example.test');
  assert.equal((await onRequest({ request: anon, env: protectedEnv })).status, 403);
  assert.equal((await onRequest({ request: request(), env: { ...env, ADMIN_WEB_HOST: 'other.test' } })).status, 404);
  assert.match(off.headers.get('Cache-Control'), /no-store/);
  assert.equal(off.headers.get('X-Frame-Options'), 'DENY');
});

test('HTML/JSON protegidos; métodos de escritura y filtros abusivos bloqueados', async () => {
  const token = await signed();
  // Certificado firmado real; sólo se sustituye la red externa de certificados.
  const previous = globalThis.fetch;
  globalThis.fetch = certs;
  try {
    const post = await onRequest({ request: request(token, '', 'POST'), env });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('Allow'), 'GET, HEAD');
    for (const query of ['?days=365', '?page=-1', '?view=secrets', '?page=1.2']) {
      assert.equal((await onRequest({ request: request(token, query), env })).status, 400);
    }
    const html = await onRequest({ request: request(token, '?view=visitas'), env });
    assert.equal(html.status, 200);
    assert.match(await html.text(), /Sin conectar/);
    const json = await onRequest({ request: request(token, '?view=visitas&format=json'), env });
    assert.equal((await json.json()).analytics.status, 'unavailable');
    assert.match(json.headers.get('Content-Security-Policy'), /default-src 'none'/);
    assert.match(json.headers.get('Cache-Control'), /private, no-store/);
  } finally { globalThis.fetch = previous; }
});

test('consultas reales SQLite: límites temporales, pagos distintos, correos y cero escrituras', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE orders (public_code TEXT,status TEXT,payment_status TEXT,delivery_type TEXT,
    created_at TEXT,expires_at TEXT,buyer_name TEXT,buyer_email TEXT);
    CREATE TABLE order_events (event_type TEXT,payload_json TEXT,created_at TEXT);`);
  const insert = db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 55; i++) insert.run(`TEST-${i}`, 'open', i === 0 ? 'approved' : i === 1 ? 'rejected' : 'pending',
    'pickup', '2026-09-01T04:00:00Z', '2099-01-01T00:00:00Z', 'PRIVATE_NAME', 'PRIVATE_EMAIL');
  insert.run('EXCLUDED-BEFORE', 'open', 'pending', 'shipping', '2026-08-31T02:59:59Z', '2099-01-01', 'PRIVATE_NAME', 'PRIVATE_EMAIL');
  insert.run('EXCLUDED-TODAY', 'open', 'approved', 'shipping', period.end, '2099-01-01', 'PRIVATE_NAME', 'PRIVATE_EMAIL');
  db.prepare('INSERT INTO order_events VALUES (?,?,?)').run('customer_order_email', '{"status":"failed","email":"PRIVATE_EMAIL"}', '2026-09-01T04:00:00Z');
  db.prepare('INSERT INTO order_events VALUES (?,?,?)').run('customer_order_email', 'malformed', '2026-09-01T04:00:00Z');
  db.exec('PRAGMA query_only=ON');
  const adapter = { prepare(sql) { assert.match(sql.trim(), /^SELECT/); return { bind(...args) {
    return { first: async () => db.prepare(sql).get(...args), all: async () => ({ results: db.prepare(sql).all(...args), success: true }) };
  } }; } };
  const orders = await readWebOrders({ ORDERS_DB: adapter }, period);
  assert.equal(orders.status, 'ok');
  assert.equal(orders.summary.total, 55);
  assert.equal(orders.summary.approved, 1);
  assert.equal(orders.summary.rejected, 1);
  assert.equal(orders.summary.pending, 53);
  assert.equal(orders.rows.length, 50);
  assert.doesNotMatch(JSON.stringify(orders), /PRIVATE_|buyer_|EXCLUDED/);
  const emails = await readWebEmails({ ORDERS_DB: adapter }, period);
  assert.deepEqual(emails.rows, [{ state: 'failed', total: 1 }, { state: 'unknown', total: 1 }]);
  assert.doesNotMatch(JSON.stringify(emails), /PRIVATE_/);
  db.close();
});

test('fallas parciales se muestran sin inventar ceros', async () => {
  const broken = { ORDERS_DB: { prepare() { throw new Error('PRIVATE_TOKEN'); } } };
  const orders = await readWebOrders(broken, period);
  assert.equal(orders.status, 'unavailable');
  assert.equal(orders.summary, undefined);
  assert.doesNotMatch(JSON.stringify(orders), /PRIVATE_TOKEN/);
  const unavailable = await readWebAnalytics({}, period, fixedNow);
  assert.equal(unavailable.summary, undefined);
  assert.equal((await readWebSync(async () => { throw new Error('offline'); })).status, 'unavailable');
});

test('GA4 rechaza otra propiedad, web, período, datos futuros o conteos inválidos', async () => {
  assert.equal(validateWebAnalytics(snapshot(), period, fixedNow).status, 'ok');
  for (const changes of [{ property: '999' }, { hosts: ['preview.pages.dev'] }, { scope: 'all-channels' },
    { period: { ...snapshot().period, endDate: '2026-09-05' } }, { extractedAt: '2099-01-01' },
    { summary: { sessions: -1, users: 2, views: 3 } }, { events: {} }]) {
    assert.equal(validateWebAnalytics({ ...snapshot(), ...changes }, period, fixedNow), null);
  }
  let key;
  const read = await readWebAnalytics({ APP_ENV: 'preview', ADMIN_WEB_ANALYTICS_KV: { get: async k => { key = k; return snapshot(); } } }, period, fixedNow);
  assert.equal(read.status, 'ok');
  assert.equal(key, 'preview:ga4:web:v1:7d');
});

test('catálogo: paginación, búsqueda por identificador y fuente caída', async () => {
  const items = Array.from({ length: 28 }, (_, i) => ({ id: `MLU${i}`, title: `Libro ${i}`, price: 300, available_quantity: 2, status: 'active' }));
  const catalog = await readWebCatalog('', 1, async () => Response.json({ items }));
  assert.equal(catalog.rows.length, 3);
  assert.equal(catalog.total, 28);
  assert.equal((await readWebCatalog('MLU27', 0, async () => Response.json({ items }))).matched, 1);
  assert.equal((await readWebCatalog('', 0, async () => new Response('', { status: 503 }))).status, 'unavailable');
});

test('GA4 exporta únicamente la web, sin queries/PII ni credenciales en el snapshot', async () => {
  const spec = buildAdminGa4Requests(period);
  assert.equal(spec.requests.length, 5);
  for (const r of spec.requests) assert.deepEqual(r.dimensionFilter.andGroup.expressions[0].filter.inListFilter.values, WEB_HOSTS);
  let called;
  const fake = async (url, options) => {
    called = { url, method: options.method };
    return Response.json({ reports: spec.requests.map((r, i) => ({
      metadata: { timeZone: 'America/Montevideo' }, metricHeaders: r.metrics, dimensionHeaders: r.dimensions,
      rows: i === 0 ? [{ metricValues: [{ value: '12' }, { value: '10' }, { value: '30' }] }] : [],
    })) });
  };
  const exported = await exportAdminGa4({ token: 'PRIVATE_TOKEN', now: fixedNow, fetchFn: fake });
  assert.equal(called.method, 'POST');
  assert.match(called.url, /properties\/543434807:batchRunReports/);
  assert.equal(exported.summary.sessions, 12);
  assert.doesNotMatch(JSON.stringify(exported), /PRIVATE_TOKEN/);
  assert.equal(exported.events.checkout_error, 0);
});

test('HTML escapa contenido, conserva sin datos y no afirma recepción de emails', () => {
  const html = renderAdminWeb({ view: 'productos', period, checkedAt: fixedNow.toISOString(),
    catalog: { status: 'ok', source: 'Public', total: 1, matched: 1, pages: 1, page: 0,
      rows: [{ id: 'MLU1', title: '<script>alert(1)</script>', price: null, stock: null }] }, query: '" onfocus="alert(1)' });
  assert.doesNotMatch(html, /<script>|value="" onfocus/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Sin datos/);
  const emails = renderAdminWeb({ view: 'estado', period, checkedAt: fixedNow.toISOString(),
    emails: { status: 'ok', rows: [{ state: 'sent', total: 2 }], note: 'No confirma recepción' }, sync: { status: 'unavailable' } });
  assert.match(emails, /Aceptado por proveedor/);
});

test('revisión descargable: cada enlace existe en el mismo archivo aun sin JavaScript', () => {
  const html = buildAdminWebReview({ now: fixedNow });
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'IDs únicos entre todas las vistas');
  const screenIds = [...html.matchAll(/class="review-screen" id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(screenIds.length, 12);
  assert.equal(screenIds.at(-1), 'resumen-7', 'Resumen por defecto, último hermano');
  assert.doesNotMatch(html, /<script\b|<form\b|\bonclick=|href="\/admin/);
  const internal = [...html.matchAll(/href="#([^"]+)"/g)].map(match => match[1]);
  assert.equal(internal.length, 96);
  for (const target of internal) assert.ok(screenIds.includes(target), `Destino presente: ${target}`);
  for (const view of ['resumen','visitas','compra','pedidos','productos','estado']) {
    for (const days of [7, 30]) assert.ok(internal.includes(`${view}-${days}`));
  }
  assert.match(html, /\.review-screen:target~\.review-screen:last-child\{display:none\}/);
});
