/**
 * Junta de D1 (producción, solo lectura) lo que necesita el informe semanal.
 *
 * Cada consulta corre por separado: si una tabla todavía no existe (las
 * migraciones nuevas se aplican en el deploy), esa sección dice «sin dato» y
 * el resto del informe sale igual. No se lee ningún dato personal: ni nombre,
 * ni teléfono, ni correo, ni dirección. Del aviso de stock sólo el libro.
 *
 * Uso: node scripts/reports/weekly/fetch-d1.mjs  (necesita CLOUDFLARE_API_TOKEN
 * y CLOUDFLARE_ACCOUNT_ID). Escribe WEEKLY_OUTPUT_DIR/d1.json.
 */

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { weeklyPeriods } from './periods.mjs';

const run = promisify(execFile);
const WRANGLER = 'wrangler@3.114.17';

function iso(value) {
  // Las fechas van literales en el SQL (wrangler --command no acepta
  // parámetros). Sólo pasan si tienen forma de ISO: nada externo entra acá.
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/.test(value)) throw new Error(`Fecha inválida: ${value}`);
  return `'${value}'`;
}

/** Las consultas, en función de las ventanas. Exportada para los tests. */
export function weeklyQueries(periods, now = new Date()) {
  const from = periods.previous.startIso;
  const to = periods.current.endIso;
  // Pedidos de las dos semanas, más los últimos 14 días para ver
  // transferencias que siguen sin confirmarse.
  const recent = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const orderScope = `(created_at >= ${iso(from)} AND created_at < ${iso(to)})`
    + ` OR (paid_at >= ${iso(from)} AND paid_at < ${iso(to)})`
    + ` OR created_at >= ${iso(recent)}`;
  return {
    orders: `SELECT id, public_code, status, payment_status, payment_provider, delivery_type,
       products_total_uyu, pickup_discount_uyu, shipping_cost_uyu, payable_total_uyu, paid_amount_uyu,
       created_at, paid_at, expires_at
       FROM orders WHERE ${orderScope}`,
    events: `SELECT order_id, event_type, payload_json, created_at FROM order_events
       WHERE event_type IN ('created','preference_created','transfer_payment_info_viewed','transfer_confirmed',
         'payment_approved','payment_pending','payment_rejected','payment_cancelled','payment_refunded')
         AND order_id IN (SELECT id FROM orders WHERE ${orderScope})`,
    items: `SELECT i.order_id, i.product_id, i.title, i.quantity, i.line_total_uyu
       FROM order_items i JOIN orders o ON o.id = i.order_id
       WHERE o.payment_status = 'approved' AND o.paid_at >= ${iso(from)} AND o.paid_at < ${iso(to)}`,
    waitlist: `SELECT product_id, product_title, status, created_at, notified_at FROM stock_waitlist
       WHERE (created_at >= ${iso(from)} AND created_at < ${iso(to)})
          OR (notified_at >= ${iso(from)} AND notified_at < ${iso(to)})`,
    search_misses: `SELECT date, query, count FROM search_misses
       WHERE date >= ${iso(periods.previous.startDate)} AND date <= ${iso(periods.current.endDate)}`,
    sync_log: `SELECT synced_at, total_items, available_items, added, removed, price_up, price_down,
       out_of_stock, back_in_stock, baseline, samples_json FROM catalog_sync_log
       WHERE synced_at >= ${iso(from)} AND synced_at < ${iso(to)} ORDER BY synced_at`,
    sync_latest: 'SELECT synced_at, total_items, available_items FROM catalog_sync_log ORDER BY synced_at DESC LIMIT 1',
    sync_first: 'SELECT MIN(synced_at) AS first FROM catalog_sync_log',
  };
}

export function rowsFromWrangler(payload) {
  if (Array.isArray(payload)) return payload.flatMap(entry => (Array.isArray(entry?.results) ? entry.results : []));
  return Array.isArray(payload?.results) ? payload.results : [];
}

async function query(sql) {
  const { stdout } = await run('npx', [
    '--yes', WRANGLER, 'd1', 'execute', 'ORDERS_DB', '--env', 'production', '--remote', '--json',
    '--command', sql.replace(/\s+/g, ' ').trim(),
  ], { maxBuffer: 64 * 1024 * 1024, env: process.env });
  return rowsFromWrangler(JSON.parse(stdout));
}

export async function main() {
  const outputDir = process.env.WEEKLY_OUTPUT_DIR || 'artifacts/weekly';
  const now = process.env.WEEKLY_NOW ? new Date(process.env.WEEKLY_NOW) : new Date();
  const periods = weeklyPeriods(now);
  const result = {};
  for (const [name, sql] of Object.entries(weeklyQueries(periods, now))) {
    try {
      result[name] = await query(sql);
      console.log(`${name}: ${result[name].length} filas`);
    } catch (error) {
      // El mensaje de wrangler dice qué tabla o columna falta; nunca trae el token.
      const text = String(error?.stderr || error?.stdout || error?.message || 'error');
      const reason = (text.match(/no such (table|column): [\w.]+/i) || [text.split('\n').find(Boolean) || 'error'])[0];
      result[name] = { error: reason.slice(0, 160) };
      console.log(`${name}: sin dato (${result[name].error})`);
    }
  }
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'd1.json'), `${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { console.error(error); process.exit(1); });
}
