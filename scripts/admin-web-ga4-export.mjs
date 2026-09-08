// Exportación de lectura. Reutiliza el token temporal de la integración GA4
// existente. No publica, no despliega y no escribe en Cloudflare.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WEB_HOSTS, WEB_EVENTS, webPeriod, validateWebAnalytics, previousWebPeriod, webDates } from '../functions/_shared/admin-web-data.js';

const PROPERTY = '543434807';
const reports = [
  { id: 'summary', metrics: ['sessions','totalUsers','screenPageViews'], dimensions: [], limit: '1' },
  { id: 'channels', metrics: ['sessions'], dimensions: ['sessionDefaultChannelGroup'], limit: '25' },
  { id: 'devices', metrics: ['sessions'], dimensions: ['deviceCategory'], limit: '25' },
  { id: 'pages', metrics: ['screenPageViews'], dimensions: ['pagePath'], limit: '25' },
  { id: 'events', metrics: ['eventCount'], dimensions: ['eventName'], limit: '25' },
];
const detailReports = [
  { id: 'daily', metrics: ['sessions', 'screenPageViews'], dimensions: ['date'], limit: '31' },
  { id: 'previous', metrics: ['sessions', 'totalUsers', 'screenPageViews'], dimensions: [], limit: '1' },
  { id: 'products', metrics: ['screenPageViews'], dimensions: ['pagePath'], limit: '15' },
];

export function buildAdminGa4Requests(period) {
  return { requests: reports.map(report => ({
    dateRanges: [{ startDate: period.startDate, endDate: period.endDate }],
    dimensions: report.dimensions.map(name => ({ name })),
    metrics: report.metrics.map(name => ({ name })),
    dimensionFilter: { andGroup: { expressions: [
      { filter: { fieldName: 'hostName', inListFilter: { values: WEB_HOSTS, caseSensitive: false } } },
      ...(report.id === 'events' ? [{ filter: { fieldName: 'eventName', inListFilter: { values: WEB_EVENTS } } }] : []),
    ] } },
    orderBys: [{ metric: { metricName: report.metrics[0] }, desc: true }],
    limit: report.limit,
  })) };
}

export function buildAdminGa4DetailRequests(period) {
  return { requests: detailReports.map(report => {
    const range = report.id === 'previous' ? previousWebPeriod(period) : period;
    return { dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      dimensions: report.dimensions.map(name => ({ name })), metrics: report.metrics.map(name => ({ name })),
      dimensionFilter: { andGroup: { expressions: [
        { filter: { fieldName: 'hostName', inListFilter: { values: WEB_HOSTS, caseSensitive: false } } },
        ...(report.id === 'products' ? [{ filter: { fieldName: 'pagePath', stringFilter: { matchType: 'BEGINS_WITH', value: '/libro/', caseSensitive: true } } }] : []),
      ] } },
      orderBys: report.id === 'daily' ? [{ dimension: { dimensionName: 'date' } }] : [{ metric: { metricName: report.metrics[0] }, desc: true }],
      limit: report.limit };
  }) };
}

function checkedReports(body, definitions) {
  if (!Array.isArray(body.reports) || body.reports.length !== definitions.length) throw new Error('GA4_REPORTS_INCOMPLETE');
  if (body.reports.some(r => r.metadata?.timeZone !== 'America/Montevideo')) throw new Error('GA4_TIMEZONE_NOT_VERIFIED');
  if (body.reports.some(r => r.metadata?.subjectToThresholding || r.metadata?.dataLossFromOtherRow || r.metadata?.samplingMetadatas?.length)) throw new Error('GA4_LIMITED_REPORT');
  return body.reports.map((r, i) => rowsFor(r, definitions[i]));
}

function rowsFor(response, config) {
  if (JSON.stringify((response.metricHeaders || []).map(x => x.name)) !== JSON.stringify(config.metrics) ||
      JSON.stringify((response.dimensionHeaders || []).map(x => x.name)) !== JSON.stringify(config.dimensions)) throw new Error('GA4_HEADERS_INVALID');
  return (response.rows || []).map(row => {
    const values = (row.metricValues || []).map(x => Number(x.value));
    if (values.length !== config.metrics.length || !values.every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('GA4_COUNTS_INVALID');
    return { label: String(row.dimensionValues?.[0]?.value || ''), values };
  });
}

export async function exportAdminGa4({ token, days = 7, now = new Date(), fetchFn = fetch, enrich = false }) {
  if (!token) throw new Error('Falta GA4_ACCESS_TOKEN temporal de la conexión existente.');
  const period = webPeriod(days, now);
  const response = await fetchFn(`https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY}:batchRunReports`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(buildAdminGa4Requests(period)), redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`GA4 respondió HTTP ${response.status}; no se generó un informe.`);
  const body = await response.json();
  if (!Array.isArray(body.reports) || body.reports.length !== reports.length) throw new Error('GA4_REPORTS_INCOMPLETE');
  if (body.reports.some(r => r.metadata?.timeZone !== 'America/Montevideo')) throw new Error('GA4_TIMEZONE_NOT_VERIFIED');
  if (body.reports.some(r => r.metadata?.subjectToThresholding || r.metadata?.dataLossFromOtherRow || r.metadata?.samplingMetadatas?.length)) {
    throw new Error('GA4_LIMITED_REPORT: informe con umbrales, agrupación o muestreo; requiere revisión, no publicar como completo.');
  }
  const data = body.reports.map((r, i) => rowsFor(r, reports[i]));
  const totals = data[0][0]?.values || [0, 0, 0];
  const events = Object.fromEntries(WEB_EVENTS.map(name => [name, 0]));
  for (const row of data[4]) if (WEB_EVENTS.includes(row.label)) events[row.label] = row.values[0];
  const snapshot = { version: 1, scope: 'web-only', property: PROPERTY, hosts: WEB_HOSTS,
    period: { startDate: period.startDate, endDate: period.endDate, timeZone: period.timeZone },
    extractedAt: now.toISOString(), summary: { sessions: totals[0], users: totals[1], views: totals[2] }, events,
    channels: data[1].map(r => ({ label: r.label, count: r.values[0] })),
    devices: data[2].map(r => ({ label: r.label, count: r.values[0] })),
    pages: data[3].map(r => ({ label: r.label.split(/[?#]/)[0], count: r.values[0] })),
  };
  if (!validateWebAnalytics(snapshot, period, now)) throw new Error('GA4_SNAPSHOT_INVALID');
  if (enrich) {
    const detailResponse = await fetchFn(`https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY}:batchRunReports`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(buildAdminGa4DetailRequests(period)), redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    if (!detailResponse.ok) throw new Error('GA4_DETAIL_UNAVAILABLE');
    const detailData = checkedReports(await detailResponse.json(), detailReports);
    const dates = webDates(period);
    const daily = new Map();
    for (const row of detailData[0]) {
      if (!/^\d{8}$/.test(row.label)) throw new Error('GA4_DAY_INVALID');
      const date = `${row.label.slice(0, 4)}-${row.label.slice(4, 6)}-${row.label.slice(6)}`;
      if (!dates.includes(date) || daily.has(date)) throw new Error('GA4_DAY_INVALID');
      daily.set(date, { date, sessions: row.values[0], views: row.values[1] });
    }
    const before = previousWebPeriod(period);
    const totalsBefore = detailData[1][0]?.values || [0, 0, 0];
    snapshot.detail = { version: 1,
      previous: { startDate: before.startDate, endDate: before.endDate,
        summary: { sessions: totalsBefore[0], users: totalsBefore[1], views: totalsBefore[2] } },
      daily: dates.map(date => daily.get(date) || { date, sessions: 0, views: 0 }),
      products: detailData[2].map(row => ({ path: row.label.split(/[?#]/)[0], views: row.values[0] })) };
    if (!validateWebAnalytics(snapshot, period, now)) throw new Error('GA4_DETAIL_INVALID');
  }
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const output = resolve(process.env.ADMIN_WEB_OUTPUT_DIR || 'artifacts/admin-web-private');
    // No persistir el token. Este directorio no debe commitearse ni servirse como asset.
    const snapshots = await Promise.all([7, 30].map(days => exportAdminGa4({ token: process.env.GA4_ACCESS_TOKEN, days })));
    await mkdir(output, { recursive: true });
    for (let i = 0; i < snapshots.length; i++) await writeFile(join(output, `ga4-web-${[7, 30][i]}d.json`), JSON.stringify(snapshots[i], null, 2) + '\n', { mode: 0o600 });
    console.log('Exportación de 7 y 30 días completada. No se publicó ni modificó la web.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
