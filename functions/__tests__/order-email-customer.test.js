import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomerOrderEmail } from '../api/_order_email.js';
import { TRANSFER_ACCOUNTS } from '../api/_transfer_options_handler.js';

const items = [{ title: 'La Reina Descalza', quantity: 1, line_total_uyu: 2750 }];
const transferPayment = { method: 'bank_transfer', transfer_discount_uyu: 330, total_uyu: 2420 };
const baseOrder = {
  public_code: 'AL-TEST-1', buyer_name: 'Ana Prueba', buyer_email: 'ana@example.com',
  delivery_type: 'shipping', address: 'Av. Italia 2000', locality: 'Pocitos', department: 'Montevideo',
  products_total_uyu: 2750, shipping_cost_uyu: 0, pickup_discount_uyu: 0, payable_total_uyu: 2750,
};

test('correo por transferencia: trae cuentas, importe exacto, WhatsApp con número y enlace', () => {
  const { text, html } = buildCustomerOrderEmail({ order: baseOrder, items, payment: transferPayment, accounts: TRANSFER_ACCOUNTS });
  for (const account of TRANSFER_ACCOUNTS) {
    assert.ok(text.includes(account.account_number), `falta la cuenta ${account.id}`);
    assert.ok(html.includes(account.account_number), `falta la cuenta ${account.id} en el HTML`);
  }
  assert.match(text, /Importe exacto: \$2\.420 UYU/);
  assert.match(text, /099 841 325/);
  assert.match(html, /href="https:\/\/wa\.me\/59899841325\?text=/);
  assert.match(text, /AL-TEST-1/);
  assert.match(text, /hacemos lo imposible por resolverte cualquier problema/);
});

test('correo: plazo según destino y sin cuentas cuando el pago ya es con Mercado Pago', () => {
  const interior = buildCustomerOrderEmail({
    order: { ...baseOrder, department: 'Salto' }, items, payment: transferPayment, accounts: TRANSFER_ACCOUNTS,
  });
  assert.match(interior.text, /2 a 5 días hábiles/);
  const montevideo = buildCustomerOrderEmail({ order: baseOrder, items, payment: transferPayment, accounts: TRANSFER_ACCOUNTS });
  assert.match(montevideo.text, /en el día/);
  const pickup = buildCustomerOrderEmail({
    order: { ...baseOrder, delivery_type: 'pickup' }, items, payment: transferPayment, accounts: TRANSFER_ACCOUNTS,
  });
  assert.match(pickup.text, /listo para retirar/);
  const mp = buildCustomerOrderEmail({
    order: baseOrder, items, payment: { method: 'mercado_pago' }, accounts: TRANSFER_ACCOUNTS,
  });
  assert.doesNotMatch(mp.text, /Cómo pagar por transferencia/);
  assert.doesNotMatch(mp.text, new RegExp(TRANSFER_ACCOUNTS[0].account_number));
});

test('correo: escapa HTML en el nombre del cliente', () => {
  const { html } = buildCustomerOrderEmail({
    order: { ...baseOrder, buyer_name: '<script>x</script>' }, items, payment: transferPayment, accounts: TRANSFER_ACCOUNTS,
  });
  assert.doesNotMatch(html, /<script>x<\/script>/);
});
