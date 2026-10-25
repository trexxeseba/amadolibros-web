/**
 * PANEL-DATOS-1 — visitas (GA4) y búsquedas en Google (Search Console) para el
 * panel interno.
 *
 * El Worker del panel no tiene credencial de Google y no conviene dársela: la
 * cuenta de servicio ga4-reporter ya se usa desde GitHub Actions sin claves
 * guardadas (Workload Identity Federation). Este script corre ahí, arma un
 * resumen chico y lo deja en KV (panel:google); el panel sólo lo lee.
 *
 * El repo es público: por consola sale sólo «ok» o el error, nunca los datos.
 *
 * Variables: GOOGLE_ACCESS_TOKEN, GA4_PROPERTY_ID, GSC_SITE_URL (opcional),
 * PANEL_GOOGLE_OUTPUT (archivo de salida).
 */

import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { ga4Rows, postJson } from '../reports/weekly/fetch-google.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const FUNNEL_EVENTS = [
  'view_item', 'add_to_cart', 'view_cart', 'begin_checkout', 'purchase',
  'whatsapp_click', 'book_request_submitted', 'stock_waitlist_created',
];

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Ventana de 28 días que termina ayer, y la de 28 días anterior. */
export function panelWindows(now = new Date(), lagDays = 1) {
  const end = now.getTime() - lagDays * DAY_MS;
  return {
    current: { startDate: isoDay(end - 27 * DAY_MS), endDate: isoDay(end) },
    previous: { startDate: isoDay(end - 55 * DAY_MS), endDate: isoDay(end - 28 * DAY_MS) },
  };
}

async function ga4(property, token, win) {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`;
  const report = body => postJson(url, token, body).then(ga4Rows);
  const both = [win.current, win.previous];
  const one = [win.current];
  const [totales, diario, canales, fuentes, landings, paginas, dispositivos, ciudades, eventos] = await Promise.all([
    report({
      dateRanges: both,
      metrics: ['activeUsers', 'newUsers', 'sessions', 'engagedSessions', 'screenPageViews', 'averageSessionDuration']
        .map(name => ({ name })),
    }),
    report({ dateRanges: one, dimensions: [{ name: 'date' }], metrics: [{ name: 'activeUsers' }, { name: 'sessions' }],
      orderBys: [{ dimension: { dimensionName: 'date' } }], limit: '60' }),
    report({ dateRanges: one, dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'engagedSessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: '20' }),
    report({ dateRanges: one, dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
      metrics: [{ name: 'sessions' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: '15' }),
    report({ dateRanges: one, dimensions: [{ name: 'landingPage' }],
      metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: '25' }),
    report({ dateRanges: one, dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: '25' }),
    report({ dateRanges: one, dimensions: [{ name: 'deviceCategory' }], metrics: [{ name: 'sessions' }] }),
    report({ dateRanges: one, dimensions: [{ name: 'city' }], metrics: [{ name: 'activeUsers' }],
      orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }], limit: '12' }),
    report({ dateRanges: both, dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }],
      dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: FUNNEL_EVENTS } } } }),
  ]);

  // Con dos rangos, GA4 agrega la dimensión dateRange: date_range_0 y _1.
  const porRango = (rows, rango) => rows.filter(r => (r.dateRange || 'date_range_0') === rango);
  const sinRango = row => Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'dateRange'));
  const eventosDe = rango => Object.fromEntries(porRango(eventos, rango).map(r => [r.eventName, r.eventCount]));

  return {
    totals: sinRango(porRango(totales, 'date_range_0')[0] || {}),
    previousTotals: sinRango(porRango(totales, 'date_range_1')[0] || {}),
    daily: diario.map(r => ({ day: `${r.date.slice(0, 4)}-${r.date.slice(4, 6)}-${r.date.slice(6, 8)}`,
      users: r.activeUsers, sessions: r.sessions })),
    channels: canales,
    sources: fuentes,
    landings,
    pages: paginas,
    devices: dispositivos,
    cities: ciudades,
    events: eventosDe('date_range_0'),
    previousEvents: eventosDe('date_range_1'),
  };
}

function gscRows(response, dimension) {
  return (response.rows || []).map(row => ({
    ...(dimension ? { [dimension]: row.keys?.[0] ?? '' } : {}),
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: row.ctr ?? 0,
    position: row.position ?? 0,
  }));
}

async function gsc(siteUrl, token, win) {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const q = (range, extra = {}) => postJson(url, token, { ...range, dataState: 'all', ...extra });
  const [totales, anteriores, diario, consultas, paginas] = await Promise.all([
    q(win.current),
    q(win.previous),
    q(win.current, { dimensions: ['date'], rowLimit: 60 }),
    q(win.current, { dimensions: ['query'], rowLimit: 30 }),
    q(win.current, { dimensions: ['page'], rowLimit: 25 }),
  ]);
  return {
    totals: gscRows(totales)[0] || {},
    previousTotals: gscRows(anteriores)[0] || {},
    daily: gscRows(diario, 'day'),
    queries: gscRows(consultas, 'query'),
    pages: gscRows(paginas, 'page'),
  };
}

export async function main() {
  const token = process.env.GOOGLE_ACCESS_TOKEN || '';
  const property = String(process.env.GA4_PROPERTY_ID || '').replace(/^properties\//, '');
  const siteUrl = process.env.GSC_SITE_URL || 'sc-domain:amadolibros.com';
  const output = process.env.PANEL_GOOGLE_OUTPUT || 'panel-google.json';
  const now = new Date();
  const out = { generatedAt: now.toISOString() };

  if (!token) {
    out.ga4 = { error: 'no se obtuvo token de Google' };
    out.gsc = { error: 'no se obtuvo token de Google' };
  } else {
    const ga4Win = panelWindows(now, 1);
    out.ga4Window = ga4Win;
    if (!/^\d+$/.test(property)) out.ga4 = { error: 'falta GA4_PROPERTY_ID' };
    else {
      try { out.ga4 = await ga4(property, token, ga4Win); } catch (error) { out.ga4 = { error: `GA4 ${error.message}` }; }
    }
    // Search Console llega con 2-3 días de atraso: se corre la ventana.
    const gscWin = panelWindows(now, 3);
    out.gscWindow = gscWin;
    try { out.gsc = await gsc(siteUrl, token, gscWin); } catch (error) { out.gsc = { error: `Search Console ${error.message}` }; }
  }

  await writeFile(output, JSON.stringify(out));
  console.log(`GA4: ${out.ga4.error ? 'error' : 'ok'} · Search Console: ${out.gsc.error ? 'error' : 'ok'}`);
  if (out.ga4.error && out.gsc.error) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
