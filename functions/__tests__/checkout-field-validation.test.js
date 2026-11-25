import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { contactValidation } from '../../shared/contact-validation.js';

const source = readFileSync('astro-front/src/pages/carrito.astro', 'utf8');
const start = source.indexOf('    function checkoutFieldErrors(');
const end = source.indexOf("    document.querySelectorAll('#checkout-edit-step input", start);
const validation = source.slice(start, end);

function setup() {
  const fields = new Map();
  let focused = null;
  function field(id) {
    if (!fields.has(id)) fields.set(id, { id, value: '', hidden: true, textContent: '', attrs: {},
      setAttribute(key, value) { this.attrs[key] = value; },
      removeAttribute(key) { delete this.attrs[key]; },
      focus() { focused = id; }, scrollIntoView() {},
    });
    return fields.get(id);
  }
  const state = { delivery: '', payment: '', pickup: false };
  const context = {
    window: { AmadoContactValidation: contactValidation },
    getDeliveryType: () => state.delivery,
    getPaymentMethod: () => state.payment,
    isPickupAccepted: () => state.pickup,
    clearFieldErrors() { for (const element of fields.values()) if (element.id.startsWith('err-')) element.hidden = true; },
    showFieldError(id, message) { Object.assign(field('err-' + id), { hidden: false, textContent: message }); field(id).attrs['aria-invalid'] = 'true'; },
    document: {
      getElementById: field,
      querySelector: () => null,
      querySelectorAll: selector => selector === '.field-error' ? [...fields.values()].filter(x => x.id.startsWith('err-')) : [],
    },
  };
  runInNewContext(validation, context);
  return { field, state, context, focused: () => focused };
}

test('checkout shows all errors in visible order and focuses the first missing field', () => {
  const flow = setup();
  flow.state.delivery = 'shipping';
  assert.equal(flow.context.validateCheckoutFields(true), false);
  assert.deepEqual(Array.from(flow.context.checkoutFieldErrors(true), x => x.field), [
    'delivery-address', 'delivery-barrio', 'delivery-departamento', 'buyer-name', 'buyer-phone', 'buyer-email', 'payment-method',
  ]);
  assert.equal(flow.focused(), 'delivery-address');
  assert.equal(flow.field('err-buyer-phone').hidden, false);
});

test('correcting one field clears its error while other errors remain', () => {
  const flow = setup();
  flow.state.delivery = 'pickup';
  flow.context.validateCheckoutFields(true);
  flow.field('buyer-phone').value = 'abc';
  flow.context.clearCorrectedFieldErrors();
  assert.equal(flow.field('err-buyer-phone').hidden, false);
  flow.field('buyer-phone').value = '099 123 456';
  flow.context.clearCorrectedFieldErrors();
  assert.equal(flow.field('err-buyer-phone').hidden, true);
  assert.equal(flow.field('buyer-phone').attrs['aria-invalid'], undefined);
  assert.equal(flow.field('err-buyer-email').hidden, false);
});

test('both payment flows accept valid contact only after pickup acknowledgement', () => {
  const flow = setup();
  Object.assign(flow.state, { delivery: 'pickup', payment: 'transfer' });
  flow.field('buyer-name').value = 'Ana';
  flow.field('buyer-phone').value = '+598 99 123 456';
  flow.field('buyer-email').value = 'ana@example.test';
  assert.equal(flow.context.validateCheckoutFields(), false);
  flow.state.pickup = true;
  assert.equal(flow.context.validateCheckoutFields(), true);
  flow.state.payment = 'mercadopago';
  assert.equal(flow.context.validateCheckoutFields(true), true);
});
