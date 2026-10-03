/**
 * Junta de GA4 (API de datos) y de Search Console lo que necesita el informe
 * semanal, para la semana del informe y la anterior. Solo lectura.
 *
 * Si una de las dos fuentes falla (token, permisos, cuota), su archivo queda
 * con { error } y el informe dice «sin dato»: nunca frena el correo.
 *
 * Variables: GOOGLE_ACCESS_TOKEN (scopes analytics.readonly y
 * webmasters.readonly), GA4_PROPERTY_ID, GSC_SITE_URL (opcional).
 * Escribe WEEKLY_OUTPUT_DIR/ga4.json y gsc.json.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { weeklyPeriods } from './periods.mjs';

const GA4_EVENTS = [
  'view_item', 'add_to_cart', 'view_cart', 'begin_checkout', 'purchase',
  'whatsapp_click', 'book_request_submitted', 'stock_waitlist_created',
];

async function postJson(url, token, body) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.ok) return response.json();
    const text = (await response.text()).replace(/\s+/g, ' ').slice(0, 200);
    lastError = new Error(`HTTP ${response.status}: ${text}`);
    if (![429, 500, 502, 503, 504].includes(response.status)) break;
    await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
  }
  throw lastError;
}

function ga4Rows(response) {
  const dims = (response.dimensionHeaders || []).map(h => h.name);
  const mets = (response.metricHeaders || []).map(h => h.name);
  return (response.rows || []).map(row => Object.fromEntries([
    ...dims.map((name, i) => [name, row.dimensionValues?.[i]?.value ?? '']),
    ...mets.map((name, i) => [name, Number(row.metricValues?.[i]?.value ?? 0)]),
  ]));
}

async function ga4Window({ property, token, win }) {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`;
  const dateRanges = [{ startDate: win.startDate, endDate: win.endDate }];
  const [events, sessions] = await Promise.all([
    postJson(url, token, {
      dateRanges,
      dimensions: [{ name: 'eventName' }, { name: 'deviceCategory' }, { name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: GA4_EVENTS } } },
      limit: '10000',
    }),
    postJson(url, token, {
      dateRanges,
      dimensions: [{ name: 'deviceCategory' }, { name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }],
      limit: '10000',
    }),
  ]);
  return { events: ga4Rows(events), sessions: ga4Rows(sessions) };
}

function gscRows(response, dimension) {
  return (response.rows || []).map(row => ({
    ...(dimension ? { [dimension]: row.keys?.[0] ?? '' } : {}),
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    position: row.position ?? 0,
  }));
}

async function gscWindow({ siteUrl, token, win }) {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const base = { startDate: win.startDate, endDate: win.endDate, dataState: 'final' };
  const [totals, pages, queries] = await Promise.all([
    postJson(url, token, base),
    postJson(url, token, { ...base, dimensions: ['page'], rowLimit: 1000 }),
    postJson(url, token, { ...base, dimensions: ['query'], rowLimit: 1000 }),
  ]);
  return { totals: gscRows(totals), pages: gscRows(pages, 'page'), queries: gscRows(queries, 'query') };
}

export async function main() {
  const outputDir = process.env.WEEKLY_OUTPUT_DIR || 'artifacts/weekly';
  const now = process.env.WEEKLY_NOW ? new Date(process.env.WEEKLY_NOW) : new Date();
  const periods = weeklyPeriods(now);
  const token = process.env.GOOGLE_ACCESS_TOKEN || '';
  const property = String(process.env.GA4_PROPERTY_ID || '').replace(/^properties\//, '');
  const siteUrl = process.env.GSC_SITE_URL || 'sc-domain:amadolibros.com';
  await mkdir(outputDir, { recursive: true });

  let ga4;
  if (!token) ga4 = { error: 'no se obtuvo token de Google' };
  else if (!/^\d+$/.test(property)) ga4 = { error: 'falta GA4_PROPERTY_ID' };
  else {
    try {
      ga4 = {
        current: await ga4Window({ property, token, win: periods.current }),
        previous: await ga4Window({ property, token, win: periods.previous }),
      };
    } catch (error) {
      ga4 = { error: `GA4 ${error.message}` };
    }
  }
  await writeFile(path.join(outputDir, 'ga4.json'), `${JSON.stringify(ga4, null, 2)}\n`);
  console.log(`GA4: ${ga4.error || 'ok'}`);

  let gsc;
  if (!token) gsc = { error: 'no se obtuvo token de Google' };
  else {
    try {
      gsc = {
        current: await gscWindow({ siteUrl, token, win: periods.gsc.current }),
        previous: await gscWindow({ siteUrl, token, win: periods.gsc.previous }),
      };
    } catch (error) {
      gsc = { error: `Search Console ${error.message}` };
    }
  }
  await writeFile(path.join(outputDir, 'gsc.json'), `${JSON.stringify(gsc, null, 2)}\n`);
  console.log(`Search Console: ${gsc.error || 'ok'}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { console.error(error); process.exit(1); });
}
