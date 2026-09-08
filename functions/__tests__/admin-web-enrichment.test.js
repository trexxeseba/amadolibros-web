import test from 'node:test';
import assert from 'node:assert/strict';
import { webPeriod, previousWebPeriod, webDates, WEB_HOSTS, validateWebAnalytics, readWebCatalog } from '../_shared/admin-web-data.js';
import { buildAdminGa4DetailRequests, exportAdminGa4 } from '../../scripts/admin-web-ga4-export.mjs';
import { adminAnalyticsBundle, refreshAdminAnalytics } from '../../scripts/admin-web-refresh.mjs';
import { renderAdminWeb } from '../_shared/admin-web-view.js';

const now = new Date('2026-09-08T21:00:00Z');
const period = webPeriod(7, now);
const fake = async (_url, options) => {
  const { requests } = JSON.parse(options.body);
  return Response.json({ reports: requests.map(r => {
    let rows = [];
    const row = (dimensions, metrics) => ({ dimensionValues: dimensions.map(value => ({ value })), metricValues: metrics.map(value => ({ value: String(value) })) });
    if (!r.dimensions.length) rows = [row([], r.dateRanges[0].endDate === '2026-09-07' ? [12, 9, 20] : [8, 7, 11])];
    else if (r.dimensions[0].name === 'date') rows = [row(['20260901'], [12, 20])];
    else if (r.dimensionFilter.andGroup.expressions.some(f => f.filter.fieldName === 'pagePath')) rows = [row(['/libro/MLU123/libro-real'], [16])];
    return { metricHeaders: r.metrics, dimensionHeaders: r.dimensions, metadata: { timeZone: 'America/Montevideo' }, rows };
  }) });
};

test('comparación usa el período completo anterior sin solaparse y conserva filtros web', () => {
  const prior = previousWebPeriod(period);
  assert.equal(prior.end, period.start);
  assert.deepEqual([prior.startDate, prior.endDate], ['2026-08-25', '2026-08-31']);
  assert.equal(webDates(webPeriod(30, new Date('2028-03-01T12:00:00Z'))).at(-1), '2028-02-29');
  const requests = buildAdminGa4DetailRequests(period).requests;
  assert.ok(requests.length <= 5);
  for (const r of requests) assert.deepEqual(r.dimensionFilter.andGroup.expressions[0].filter.inListFilter.values, WEB_HOSTS);
  assert.equal(requests[2].dimensionFilter.andGroup.expressions[1].filter.stringFilter.value, '/libro/');
  assert.equal(requests[2].limit, '15');
});

test('extracción enriquecida conserva fechas, ceros reportados y métricas independientes de usuarios', async () => {
  const snapshot = await exportAdminGa4({ token: 'PRIVATE_TOKEN', now, fetchFn: fake, enrich: true });
  assert.equal(snapshot.detail.daily.length, 7);
  assert.deepEqual(snapshot.detail.daily[1], { date: '2026-09-02', sessions: 0, views: 0 });
  assert.equal(snapshot.detail.daily.reduce((sum, r) => sum + r.sessions, 0), snapshot.summary.sessions);
  assert.equal(snapshot.detail.previous.summary.sessions, 8);
  assert.equal(snapshot.detail.products[0].views, 16);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_TOKEN/);
  const other = await exportAdminGa4({ token: 'x', days: 30, now, fetchFn: fake, enrich: true });
  snapshot.detail.privateToken = 'PRIVATE_VALUE';
  const bundle = adminAnalyticsBundle([snapshot, other], now);
  assert.equal(bundle.snapshots[7].detail.products[0].views, 16);
  assert.doesNotMatch(JSON.stringify(bundle), /PRIVATE_VALUE|privateToken/);
  for (const change of [d => d.daily.pop(), d => d.daily[0].date = '2025-01-01', d => d.previous.endDate = period.endDate,
    d => d.products[0].path = '//evil.test/', d => d.products[0].views = -1, d => d.products.push(d.products[0])]) {
    const invalid = structuredClone(snapshot); change(invalid.detail);
    assert.equal(validateWebAnalytics(invalid, period, now), null);
  }
});

test('una comparación caída no sobrescribe el snapshot anterior ni toca Cloudflare', async () => {
  let calls = 0;
  await assert.rejects(refreshAdminAnalytics({ env: { GA4_ACCESS_TOKEN: 'PRIVATE_TOKEN' }, now, fetchFn: async (url, options) => {
    assert.ok(url.startsWith('https://analyticsdata.googleapis.com/'));
    calls++;
    if (JSON.parse(options.body).requests.length === 3) return new Response('PRIVATE_ERROR', { status: 503 });
    return fake(url, options);
  } }), /GA4_DETAIL_UNAVAILABLE/);
  assert.ok(calls >= 3);
});

test('ranking resuelve títulos del catálogo actual sin confundir vistas con ventas', async () => {
  const snapshot = await exportAdminGa4({ token: 'x', now, fetchFn: fake, enrich: true });
  const a = validateWebAnalytics(snapshot, period, now);
  const catalog = await readWebCatalog('', 0, async () => Response.json({ items: [{ id: 'MLU123', title: 'Libro <real>', available_quantity: 2, price: 300 }] }), a.detail.products);
  assert.equal(catalog.interest[0].title, 'Libro <real>');
  const html = renderAdminWeb({ view: 'productos', period, analytics: a, catalog });
  assert.match(html, /Libro &lt;real&gt;/);
  assert.match(html, /https:\/\/www.amadolibros.com\/libro\/MLU123\/libro-real/);
  assert.match(html, /Una vista no equivale a una compra/);
  const visits = renderAdminWeb({ view: 'visitas', period, analytics: a });
  assert.match(visits, /\+50% · antes 8/);
  assert.match(visits, /Ver los valores diarios/);
  a.detail.previous.summary.sessions = 0;
  assert.match(renderAdminWeb({ view: 'visitas', period, analytics: a }), /sin base para calcular un porcentaje/);
});

test('avisos distinguen error confirmado, falta de datos y tarea comercial', () => {
  const html = renderAdminWeb({ view: 'resumen', period, analytics: { status: 'unavailable' },
    orders: { status: 'ok', summary: { total: 3, pending: 2, approved: 1 }, rows: [] },
    emails: { status: 'ok', rows: [{ state: 'failed', total: 1 }] }, sync: { status: 'stale' } });
  assert.match(html, /2 pedidos pendientes de pago/);
  assert.match(html, /no un error técnico/);
  assert.match(html, /1 fallas de correo registradas/);
  assert.match(html, /view=compra&days=7/);
  assert.doesNotMatch(html, /0 errores de compra registrados/);
});
