import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  aggregate,
  rowsFromWrangler,
  summaryMarkdown,
} from '../../scripts/commerce/checkout-funnel-report.mjs';

function row(patch = {}) {
  return {
    date: '2026-08-17',
    delivery_type: 'pickup',
    orders_created: 10,
    orders_value_uyu: 20000,
    payment_selected_count: 8,
    transfer_prepared_count: 6,
    transfer_prepared_value_uyu: 10560,
    mp_prepared_count: 3,
    checkout_approved_count: 2,
    checkout_approved_value_uyu: 4000,
    both_methods_count: 1,
    ...patch,
  };
}

test('normaliza la respuesta JSON de Wrangler sin exponer filas fuera de results', () => {
  const rows = rowsFromWrangler([
    { results: [row()] },
    { results: [row({ date: '2026-08-18' })] },
    { success: true },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].date, '2026-08-18');
});

test('agrega el embudo por fecha y entrega con ratios auditables', () => {
  const result = aggregate([
    row(),
    row({
      delivery_type: 'shipping',
      orders_created: 5,
      orders_value_uyu: 7500,
      payment_selected_count: 4,
      transfer_prepared_count: 2,
      transfer_prepared_value_uyu: 2500,
      mp_prepared_count: 3,
      checkout_approved_count: 1,
      checkout_approved_value_uyu: 1500,
      both_methods_count: 1,
    }),
  ]);

  assert.equal(result.total.ordersCreated, 15);
  assert.equal(result.total.paymentSelected, 12);
  assert.equal(result.total.transferPrepared, 8);
  assert.equal(result.total.mercadoPagoPrepared, 6);
  assert.equal(result.total.checkoutApproved, 3);
  assert.equal(result.total.bothMethods, 2);
  assert.equal(result.total.paymentChoiceRate, 0.8);
  assert.equal(result.total.transferPreparedRate, 0.533333);
  assert.equal(result.total.checkoutApprovalRate, 0.5);
  assert.equal(result.daily.length, 1);
  assert.equal(result.daily[0].ordersCreated, 15);
  assert.deepEqual(result.delivery.map(item => item.label), ['pickup', 'shipping']);
});

test('el resumen diferencia transferencia preparada de pago confirmado', () => {
  const result = aggregate([row()]);
  const markdown = summaryMarkdown(result, {
    startDate: '2026-08-01',
    endDate: '2026-08-17',
  });

  assert.match(markdown, /Transferencia preparada: 6/);
  assert.match(markdown, /No equivale a pago confirmado/);
  assert.match(markdown, /no se inventa un backfill histórico/);
});

test('el workflow consulta sólo agregados no-PII y usa la señal idempotente', () => {
  const workflow = readFileSync('.github/workflows/checkout-funnel-report.yml', 'utf8');
  assert.match(workflow, /transfer_payment_info_viewed/);
  assert.match(workflow, /GROUP BY substr\(o\.created_at,1,10\), o\.delivery_type/);
  assert.doesNotMatch(workflow, /buyer_name|buyer_phone|buyer_email|address|public_code/i);
  assert.match(workflow, /Datos personales: no se consultan ni exportan/);
});
