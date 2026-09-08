// Exportación de lectura. Reutiliza el token temporal de la integración GA4
// existente. No publica, no despliega y no escribe en Cloudflare.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WEB_HOSTS, WEB_EVENTS, webPeriod, validateWebAnalytics } from '../functions/_shared/admin-web-data.js';

const PROPERTY = '543434807';
const reports = [
  { id: 'summary', metrics: ['sessions','totalUsers','screenPageViews'], dimensions: [], limit: '1' },
  { id: 'channels', metrics: ['sessions'], dimensions: ['sessionDefaultChannelGroup'], limit: '25' },
  { id: 'devices', metrics: ['sessions'], dimensions: ['deviceCategory'], limit: '25' },
  { id: 'pages', metrics: ['screenPageViews'], dimensions: ['pagePath'], limit: '25' },
  { id: 'events', metrics: ['eventCount'], dimensions: ['eventName'], limit: '25' },
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

function rowsFor(response, config) {
  if (JSON.stringify((response.metricHeaders || []).map(x => x.name)) !== JSON.stringify(config.metrics) ||
      JSON.stringify((response.dimensionHeaders || []).map(x => x.name)) !== JSON.stringify(config.dimensions)) throw new Error('GA4_HEADERS_INVALID');
  return (response.rows || []).map(row => {
    const values = (row.metricValues || []).map(x => Number(x.value));
    if (values.length !== config.metrics.length || !values.every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('GA4_COUNTS_INVALID');
    return { label: String(row.dimensionValues?.[0]?.value || ''), values };
  });
}

export async function exportAdminGa4({ token, days = 7, now = new Date(), fetchFn = fetch }) {
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
