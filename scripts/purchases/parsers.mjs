// Lectores de PDF de proveedores (texto de `pdftotext -layout`). Puros: reciben el
// texto y devuelven un documento para POST /purchases/import, o fallan con un
// error claro. Nunca importan algo que no cuadra: cada factura se verifica
// contra sus propios totales (unidades y monto) antes de devolverse.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const money = v => Number(String(v).replace(/\./g, '').replace(',', '.'));
const isoDate = (d, m, y) => `${y}-${m}-${d}`;
const near = (a, b, tolerance = 0.06) => Math.abs(a - b) <= tolerance;

export async function pdfText(path) {
  const { stdout } = await run('pdftotext', ['-layout', path, '-'], { maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

// Factura de Celesa (Centro de exportación de Libros Españoles). El número sale
// "CF10256" en el PDF y "CF-10256" en el asunto del mail: se normaliza con guion.
export function parseCelesaText(text, { reference = null } = {}) {
  const head = text.match(/\b(BILL|CREDIT\w*|ABONO\w*)\s+(\d{2})\/(\d{2})\/(\d{4})\s+([A-Z]{1,4}\d+)/);
  if (!head) throw new Error('celesa_cabecera_no_encontrada');
  if (head[1] !== 'BILL') throw new Error('celesa_tipo_no_soportado');
  const number = head[5].replace(/^([A-Z]+)(\d+)$/, '$1-$2');
  const items = [];
  let shipping = 0;
  for (const line of text.split('\n')) {
    const item = line.match(/^\s*(\d{12,13})\s{2,}(.+?)\s{2,}(\d+)\s(\S.*?)\s{2,}([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s*$/);
    if (item) {
      items.push({ isbn: item[1], publisher: item[2].trim(), quantity: Number(item[3]), title: item[4].trim(), unit_price: money(item[5]), discount_pct: money(item[6]), line_total: money(item[8]) });
      continue;
    }
    const ship = line.match(/GASTOS DE ENV\w+.*?([\d.]+,\d{2})\s+[\d.]+,\d{2}\s+([\d.]+,\d{2})\s*$/);
    if (ship) shipping += money(ship[2]);
  }
  if (!items.length) throw new Error('celesa_sin_lineas');
  const at = text.search(/\bUnits\b/);
  const totals = at >= 0 ? text.slice(at).split('\n').map(l => l.match(/^\s*(\d+)\s+.*?([\d.]+,\d{2})\s*€\s*$/)).find(Boolean) : null;
  if (!totals) throw new Error('celesa_totales_no_encontrados');
  const units = Number(totals[1]), total = money(totals[2]);
  if (items.reduce((n, i) => n + i.quantity, 0) !== units) throw new Error('celesa_unidades_no_cuadran');
  if (!near(items.reduce((n, i) => n + i.line_total, 0) + shipping, total)) throw new Error('celesa_total_no_cuadra');
  return { supplier: 'CELESA', document_type: 'invoice', document_number: number, document_date: isoDate(head[2], head[3], head[4]),
    currency: 'EUR', total_amount: total, source_type: 'pdf', source_reference: reference, items };
}

// Notificación de pedido de SBS Distribuidora (PE). Los pedidos a SBS se hacen
// cuando un cliente compra una oferta AMADO-AR, así que van como encargo y no
// suman al stock propio.
export function parseSbsText(text, { reference = null } = {}) {
  const num = text.match(/Numero\s*:\s*\d+\s*-\s*(\d+)/), date = text.match(/Fecha\s*:\s*(\d{2})\/(\d{2})\/(\d{4})/);
  if (!num || !date) throw new Error('sbs_cabecera_no_encontrada');
  const items = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:[A-Z]\s+)?(\d+)\s+(\d{12,13})\s+(.+?)\s{2,}\$([\d.,]+)\s+%([\d.,]+)\s+\$([\d.,]+)\s+\d{2}\/\d{2}\/\d{4}/);
    if (m) items.push({ isbn: m[2], quantity: Number(m[1]), title: m[3].trim(), unit_price: money(m[4]), discount_pct: money(m[5]), line_total: money(m[6]) });
  }
  if (!items.length) throw new Error('sbs_sin_lineas');
  const sub = text.match(/Subtotal\s+\$([\d.,]+)/);
  if (!sub) throw new Error('sbs_totales_no_encontrados');
  const subtotal = money(sub[1]);
  if (!near(items.reduce((n, i) => n + i.line_total, 0), subtotal, 0.5)) throw new Error('sbs_total_no_cuadra');
  return { supplier: 'SBS', document_type: 'order', supplier_order_id: `PE-${Number(num[1])}`, document_date: isoDate(date[1], date[2], date[3]),
    currency: 'ARS', total_amount: subtotal, purpose: 'encargo_cliente', source_type: 'pdf', source_reference: reference, items };
}

export const PARSERS = Object.freeze({ celesa: parseCelesaText, sbs: parseSbsText });
