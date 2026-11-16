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
import { fetchAirtablePedidos } from './cross-sales.mjs';

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
  // Los últimos 7 días hasta ayer inclusive, para el cruce entre canales.
  const weekStartMs = todayStartMs - 7 * DAY_MS;
  const week = {
    startDate: new Date(weekStartMs - OFFSET_MS).toISOString().slice(0, 10),
    endDate: new Date(todayStartMs - DAY_MS - OFFSET_MS).toISOString().slice(0, 10),
    startIso: new Date(weekStartMs).toISOString(),
    endIso: new Date(todayStartMs).toISOString(),
    startMs: weekStartMs,
    endMs: todayStartMs,
  };
  return { yesterday: day(todayStartMs - DAY_MS), lastWeek: day(todayStartMs - 8 * DAY_MS), week };
}

function iso(value) {
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/.test(value)) throw new Error(`Fecha inválida: ${value}`);
  return `'${value}'`;
}

function ms(value) {
  if (!Number.isSafeInteger(value)) throw new Error(`Milisegundos inválidos: ${value}`);
  return String(value);
}

/** Consultas a D1 del día. Exportada para los tests (sin datos personales). */
export function dailyQueries({ yesterday, week }) {
  const inDay = column => `${column} >= ${iso(yesterday.startIso)} AND ${column} < ${iso(yesterday.endIso)}`;
  const crossQueries = week ? {
    // Ventas de Mercado Libre de los últimos 7 días, por publicación.
    ml_sales_week: `SELECT i.item_id, MAX(i.title) AS title, MAX(i.isbn) AS isbn, SUM(i.quantity) AS quantity,
       MAX(o.date_created) AS last_date FROM ml_sales_items i JOIN ml_sales_orders o ON o.order_id = i.order_id
       WHERE o.date_created_ms >= ${ms(week.startMs)} AND o.date_created_ms < ${ms(week.endMs)}
         AND o.status <> 'cancelled' GROUP BY i.item_id`,
    // Pedidos de la web de los últimos 7 días, por libro.
    web_orders_week: `SELECT i.product_id, MAX(i.title) AS title, SUM(i.quantity) AS quantity,
       MAX(CASE WHEN o.payment_status = 'approved' THEN 1 ELSE 0 END) AS paid
       FROM order_items i JOIN orders o ON o.id = i.order_id
       WHERE o.created_at >= ${iso(week.startIso)} AND o.created_at < ${iso(week.endIso)} GROUP BY i.product_id`,
  } : {};
  return {
    ...crossQueries,
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

/** Libros vistos en la web en los últimos 7 días, con su ID de publicación. */
async function ga4WeekItems({ property, token, week }) {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`;
  const response = await postJson(url, token, {
    dateRanges: [{ startDate: week.startDate, endDate: week.endDate }],
    dimensions: [{ name: 'itemId' }, { name: 'itemName' }],
    metrics: [{ name: 'itemsViewed' }, { name: 'itemsAddedToCart' }],
    orderBys: [{ metric: { metricName: 'itemsViewed' }, desc: true }],
    limit: '200',
  });
  return ga4Rows(response);
}

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
      try {
        ga4.weekItems = await ga4WeekItems({ property, token, week: periods.week });
      } catch (error) {
        ga4.weekItems = { error: `GA4 ${error.message}` };
      }
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

  // WhatsApp e Instagram: lo que Gaby carga en Airtable (sin datos personales).
  let airtable;
  try {
    airtable = await fetchAirtablePedidos({ token: process.env.AIRTABLE_TOKEN || '', sinceDate: periods.week.startDate });
  } catch (error) {
    airtable = { error: `Airtable ${String(error?.message || error).slice(0, 120)}` };
  }
  console.log(`Airtable: ${airtable.error || `${airtable.length} consultas`}`);

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'activity.json'), `${JSON.stringify({ periods, ga4, d1, airtable }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { console.error(error); process.exit(1); });
}
