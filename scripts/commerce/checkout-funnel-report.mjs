import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const INPUT = process.env.CHECKOUT_FUNNEL_INPUT || 'artifacts/commerce/checkout-funnel-raw.json';
const OUTPUT_DIR = process.env.CHECKOUT_FUNNEL_OUTPUT_DIR || 'artifacts/commerce';
const START_DATE = process.env.CHECKOUT_FUNNEL_START_DATE || '';
const END_DATE = process.env.CHECKOUT_FUNNEL_END_DATE || '';
const DELIVERY_ORDER = ['pickup', 'shipping', 'unknown'];

export function rowsFromWrangler(payload) {
  if (Array.isArray(payload)) {
    return payload.flatMap(entry => Array.isArray(entry?.results) ? entry.results : []);
  }
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rate(numerator, denominator) {
  return denominator > 0
    ? Number((numerator / denominator).toFixed(6))
    : null;
}

function emptyBucket(label) {
  return {
    label,
    ordersCreated: 0,
    ordersValueUyu: 0,
    paymentSelected: 0,
    transferPrepared: 0,
    transferPreparedValueUyu: 0,
    mercadoPagoPrepared: 0,
    checkoutApproved: 0,
    checkoutApprovedValueUyu: 0,
    bothMethods: 0,
  };
}

function addRow(bucket, row) {
  bucket.ordersCreated += number(row.orders_created);
  bucket.ordersValueUyu += number(row.orders_value_uyu);
  bucket.paymentSelected += number(row.payment_selected_count);
  bucket.transferPrepared += number(row.transfer_prepared_count);
  bucket.transferPreparedValueUyu += number(row.transfer_prepared_value_uyu);
  bucket.mercadoPagoPrepared += number(row.mp_prepared_count);
  bucket.checkoutApproved += number(row.checkout_approved_count);
  bucket.checkoutApprovedValueUyu += number(row.checkout_approved_value_uyu);
  bucket.bothMethods += number(row.both_methods_count);
}

function finalize(bucket) {
  return {
    ...bucket,
    paymentChoiceRate: rate(bucket.paymentSelected, bucket.ordersCreated),
    transferPreparedRate: rate(bucket.transferPrepared, bucket.ordersCreated),
    mercadoPagoPreparedRate: rate(bucket.mercadoPagoPrepared, bucket.ordersCreated),
    checkoutApprovalRate: rate(bucket.checkoutApproved, bucket.mercadoPagoPrepared),
    checkoutApprovedFromCreatedRate: rate(bucket.checkoutApproved, bucket.ordersCreated),
    bothMethodsRate: rate(bucket.bothMethods, bucket.ordersCreated),
    averageCreatedOrderValueUyu: bucket.ordersCreated
      ? Number((bucket.ordersValueUyu / bucket.ordersCreated).toFixed(2))
      : null,
  };
}

function deliveryKey(value) {
  return ['pickup', 'shipping'].includes(value) ? value : 'unknown';
}

export function aggregate(rows = []) {
  const total = emptyBucket('total');
  const byDate = new Map();
  const byDelivery = new Map();

  for (const row of rows) {
    const date = String(row.date || 'unknown');
    const delivery = deliveryKey(String(row.delivery_type || 'unknown'));

    if (!byDate.has(date)) byDate.set(date, emptyBucket(date));
    if (!byDelivery.has(delivery)) byDelivery.set(delivery, emptyBucket(delivery));

    addRow(total, row);
    addRow(byDate.get(date), row);
    addRow(byDelivery.get(delivery), row);
  }

  const daily = [...byDate.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(finalize);
  const delivery = [...byDelivery.values()]
    .sort((a, b) => {
      const aIndex = DELIVERY_ORDER.indexOf(a.label);
      const bIndex = DELIVERY_ORDER.indexOf(b.label);
      return aIndex - bIndex || a.label.localeCompare(b.label);
    })
    .map(finalize);

  return { total: finalize(total), daily, delivery };
}

function csvValue(value) {
  return value == null ? '' : String(value);
}

function bucketsCsv(buckets, firstColumn) {
  const header = [
    firstColumn,
    'orders_created',
    'orders_value_uyu',
    'payment_selected',
    'payment_choice_rate',
    'transfer_prepared',
    'transfer_prepared_rate',
    'transfer_prepared_value_uyu',
    'mercado_pago_prepared',
    'mercado_pago_prepared_rate',
    'checkout_approved',
    'checkout_approval_rate',
    'checkout_approved_from_created_rate',
    'checkout_approved_value_uyu',
    'both_methods',
    'both_methods_rate',
    'average_created_order_value_uyu',
  ];
  const lines = [header.join(',')];
  for (const bucket of buckets) {
    lines.push([
      bucket.label,
      bucket.ordersCreated,
      bucket.ordersValueUyu,
      bucket.paymentSelected,
      csvValue(bucket.paymentChoiceRate),
      bucket.transferPrepared,
      csvValue(bucket.transferPreparedRate),
      bucket.transferPreparedValueUyu,
      bucket.mercadoPagoPrepared,
      csvValue(bucket.mercadoPagoPreparedRate),
      bucket.checkoutApproved,
      csvValue(bucket.checkoutApprovalRate),
      csvValue(bucket.checkoutApprovedFromCreatedRate),
      bucket.checkoutApprovedValueUyu,
      bucket.bothMethods,
      csvValue(bucket.bothMethodsRate),
      csvValue(bucket.averageCreatedOrderValueUyu),
    ].join(','));
  }
  return `${lines.join('\n')}\n`;
}

function percentage(value) {
  return value == null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function money(value) {
  return `$ ${Math.round(number(value)).toLocaleString('es-UY')}`;
}

export function summaryMarkdown({ total, delivery }, { startDate = '', endDate = '' } = {}) {
  const period = startDate && endDate ? `${startDate} a ${endDate}` : 'período solicitado';
  const lines = [
    '## Embudo de checkout',
    '',
    `- Período UTC: ${period}`,
    `- Órdenes creadas: ${total.ordersCreated}`,
    `- Llegaron a elegir un medio: ${total.paymentSelected} (${percentage(total.paymentChoiceRate)})`,
    `- Transferencia preparada: ${total.transferPrepared} (${percentage(total.transferPreparedRate)})`,
    `- Mercado Pago preparado: ${total.mercadoPagoPrepared} (${percentage(total.mercadoPagoPreparedRate)})`,
    `- Pagos aprobados por checkout: ${total.checkoutApproved} (${percentage(total.checkoutApprovedFromCreatedRate)} de las órdenes creadas)`,
    `- Valor aprobado: ${money(total.checkoutApprovedValueUyu)}`,
    `- Probaron ambos medios: ${total.bothMethods} (${percentage(total.bothMethodsRate)})`,
    '',
    '### Por entrega',
    '',
    '| Entrega | Órdenes | Transferencia preparada | Mercado Pago preparado | Aprobadas |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  for (const bucket of delivery) {
    lines.push(`| ${bucket.label} | ${bucket.ordersCreated} | ${bucket.transferPrepared} | ${bucket.mercadoPagoPrepared} | ${bucket.checkoutApproved} |`);
  }
  lines.push(
    '',
    '> “Transferencia preparada” significa que la orden autenticada recibió los datos de cobro. No equivale a pago confirmado.',
    '',
    '> La señal de transferencia empieza a acumularse desde el despliegue de esta instrumentación; no se inventa un backfill histórico.',
  );
  return `${lines.join('\n')}\n`;
}

export async function main() {
  const payload = JSON.parse(await readFile(INPUT, 'utf8'));
  const rows = rowsFromWrangler(payload);
  const result = aggregate(rows);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    period: { startDate: START_DATE || null, endDate: END_DATE || null },
    definitions: {
      ordersCreated: 'órdenes persistidas en D1',
      paymentSelected: 'orden con transferencia preparada o preferencia de Mercado Pago creada',
      transferPrepared: 'evento idempotente transfer_payment_info_viewed; no confirma el pago',
      mercadoPagoPrepared: 'evento preference_created',
      checkoutApproved: 'payment_status=approved; actualmente proviene del webhook validado de Mercado Pago',
      bothMethods: 'orden que llegó a preparar ambos medios de pago',
    },
    sourceRows: rows.length,
    ...result,
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await Promise.all([
    writeFile(path.join(OUTPUT_DIR, 'checkout-funnel-summary.json'), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(path.join(OUTPUT_DIR, 'checkout-funnel-daily.csv'), bucketsCsv(result.daily, 'date')),
    writeFile(path.join(OUTPUT_DIR, 'checkout-funnel-delivery.csv'), bucketsCsv(result.delivery, 'delivery_type')),
    writeFile(
      path.join(OUTPUT_DIR, 'report-summary.md'),
      summaryMarkdown(result, { startDate: START_DATE, endDate: END_DATE }),
    ),
  ]);

  console.log(JSON.stringify(result.total));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
