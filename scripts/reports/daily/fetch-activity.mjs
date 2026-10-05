/**
 * Lo que hizo la gente ayer en la web, para el informe diario.
 *
 * GA4: visitas, páginas y libros más vistos, carrito, origen, dispositivo,
 * ciudad y acciones (WhatsApp, avisos, «Pedir un libro»). Ayer y el mismo día
 * de la semana anterior, para comparar sin el efecto del día de la semana.
 * D1 (solo lectura): los pedidos de ayer con sus libros, los avisos de stock
 * y las búsquedas sin resultados. Sin nombres, teléfonos, correos ni
 * direcciones.
 *
 * Cada fuente que falla queda como { error } y el informe dice «sin dato».
 * Escribe DAILY_OUTPUT_DIR/activity.json.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ga4Rows, postJson } from '../weekly/fetch-google.mjs';
import { query } from '../weekly/fetch-d1.mjs';

const OFFSET_MS = 3 * 60 * 60 * 1000; // Montevideo, UTC-3
const DAY_MS = 24 * 60 * 60 * 1000;

const GA4_EVENTS = [
  'view_item', 'add_to_cart', 'begin_checkout', 'purchase',
  'whatsapp_click', 'stock_waitlist_created', 'book_request_submitted', 'checkout_error',
];

/** Ayer y el mismo día de la semana anterior, en hora de Montevideo. */
export function dailyPeriods(now = new Date()) {
  const local = new Date(now.getTime() - OFFSET_MS);
  const todayStartMs = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + OFFSET_MS;
  const day = startMs => ({
    date: new Date(startMs - OFFSET_MS).toISOString().slice(0, 10),
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(startMs + DAY_MS).toISOString(),
  });
  return { yesterday: day(todayStartMs - DAY_MS), lastWeek: day(todayStartMs - 8 * DAY_MS) };
}

function iso(value) {
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/.test(value)) throw new Error(`Fecha inválida: ${value}`);
  return `'${value}'`;
}

/** Consultas a D1 del día. Exportada para los tests (sin datos personales). */
export function dailyQueries({ yesterday }) {
  const inDay = column => `${column} >= ${iso(yesterday.startIso)} AND ${column} < ${iso(yesterday.endIso)}`;
  return {
    orders: `SELECT id, public_code, status, payment_status, payment_provider, delivery_type, department,
       payable_total_uyu, paid_amount_uyu, created_at, paid_at FROM orders
       WHERE ${inDay('created_at')} OR ${inDay('paid_at')}`,
    items: `SELECT i.order_id, i.title, i.quantity FROM order_items i JOIN orders o ON o.id = i.order_id
       WHERE ${inDay('o.created_at')} OR ${inDay('o.paid_at')}`,
    events: `SELECT order_id, event_type FROM order_events
       WHERE event_type IN ('preference_created','transfer_payment_info_viewed','payment_rejected','transfer_confirmed')
         AND order_id IN (SELECT id FROM orders WHERE ${inDay('created_at')} OR ${inDay('paid_at')})`,
    waitlist: `SELECT product_title, created_at FROM stock_waitlist WHERE ${inDay('created_at')}`,
    search_misses: `SELECT query, count FROM search_misses WHERE date = ${iso(yesterday.date)} ORDER BY count DESC LIMIT 20`,
  };
}

const GA4_REPORTS = {
  totals: { metrics: ['sessions', 'totalUsers', 'newUsers', 'screenPageViews'] },
  pages: { dimensions: ['pagePath', 'pageTitle'], metrics: ['screenPageViews'], order: 'screenPageViews', limit: 15 },
  landing: { dimensions: ['landingPage'], metrics: ['sessions'], order: 'sessions', limit: 10 },
  channels: { dimensions: ['sessionDefaultChannelGroup'], metrics: ['sessions'], order: 'sessions', limit: 10 },
  sources: { dimensions: ['sessionSource'], metrics: ['sessions'], order: 'sessions', limit: 8 },
  devices: { dimensions: ['deviceCategory'], metrics: ['sessions'], order: 'sessions', limit: 5 },
  cities: { dimensions: ['city'], metrics: ['sessions'], order: 'sessions', limit: 8 },
  items: { dimensions: ['itemName'], metrics: ['itemsViewed', 'itemsAddedToCart'], order: 'itemsViewed', limit: 15 },
  events: {
    dimensions: ['eventName'], metrics: ['eventCount'],
    filter: { filter: { fieldName: 'eventName', inListFilter: { values: GA4_EVENTS } } },
  },
};

async function ga4Day({ property, token, date }) {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`;
  const entries = await Promise.all(Object.entries(GA4_REPORTS).map(async ([name, report]) => {
    const response = await postJson(url, token, {
      dateRanges: [{ startDate: date, endDate: date }],
      dimensions: (report.dimensions || []).map(name => ({ name })),
      metrics: report.metrics.map(name => ({ name })),
      ...(report.filter ? { dimensionFilter: report.filter } : {}),
      ...(report.order ? { orderBys: [{ metric: { metricName: report.order }, desc: true }] } : {}),
      limit: String(report.limit || 100),
    });
    return [name, ga4Rows(response)];
  }));
  return Object.fromEntries(entries);
}

export async function main() {
  const outputDir = process.env.DAILY_OUTPUT_DIR || 'artifacts/commerce';
  const now = process.env.DAILY_NOW ? new Date(process.env.DAILY_NOW) : new Date();
  const periods = dailyPeriods(now);
  const token = process.env.GOOGLE_ACCESS_TOKEN || '';
  const property = String(process.env.GA4_PROPERTY_ID || '').replace(/^properties\//, '');

  let ga4;
  if (!token) ga4 = { error: 'no se obtuvo token de Google' };
  else if (!/^\d+$/.test(property)) ga4 = { error: 'falta GA4_PROPERTY_ID' };
  else {
    try {
      ga4 = {
        yesterday: await ga4Day({ property, token, date: periods.yesterday.date }),
        lastWeek: await ga4Day({ property, token, date: periods.lastWeek.date }),
      };
    } catch (error) {
      ga4 = { error: `GA4 ${error.message}` };
    }
  }
  console.log(`GA4: ${ga4.error || 'ok'}`);

  const d1 = {};
  for (const [name, sql] of Object.entries(dailyQueries(periods))) {
    try {
      d1[name] = await query(sql);
    } catch (error) {
      const text = String(error?.stderr || error?.message || 'error');
      d1[name] = { error: ((text.match(/no such (table|column): [\w.]+/i) || [text.split('\n').find(Boolean) || 'error'])[0]).slice(0, 160) };
    }
    console.log(`${name}: ${d1[name].error || `${d1[name].length} filas`}`);
  }

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'activity.json'), `${JSON.stringify({ periods, ga4, d1 }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { console.error(error); process.exit(1); });
}
