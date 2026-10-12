import assert from 'node:assert/strict';
import test from 'node:test';

import { followUpLinks } from '../_shared/panel-followup.js';

const order = {
  public_code: 'AL-261006-NLFHT2', status: 'open', payment_status: 'not_started',
  buyer_name: 'Ana María Pérez', buyer_phone: '099 123 456', buyer_email: 'ana@example.com',
};
const items = [{ title: 'Cuarenta Ladrones' }];

test('arma el WhatsApp con el teléfono normalizado y un mensaje que pregunta, no apura', () => {
  const links = followUpLinks(order, items);
  assert.match(links.whatsapp, /^https:\/\/wa\.me\/59899123456\?text=/);
  const texto = decodeURIComponent(links.whatsapp.split('?text=')[1]);
  assert.match(texto, /^¡Hola, Ana! 👋 Te escribo de Amado Libros/);
  assert.match(texto, /📚 Cuarenta Ladrones/);
  assert.doesNotMatch(texto, /AL-261006-NLFHT2/);
  assert.match(texto, /¿Todavía querés comprarlos\?/);
  assert.match(texto, /10 % de descuento/);
  assert.doesNotMatch(texto, /cuenta|CBU|transfer/i);
});

test('arma el correo como segunda vía', () => {
  const links = followUpLinks(order, items);
  assert.match(links.mailto, /^mailto:ana@example\.com\?subject=/);
});

test('un pedido pagado o no abierto no lleva seguimiento', () => {
  assert.equal(followUpLinks({ ...order, payment_status: 'approved' }, items), null);
  assert.equal(followUpLinks({ ...order, status: 'paid' }, items), null);
  assert.equal(followUpLinks({ ...order, status: 'expired' }, items), null);
});

test('sin teléfono válido no inventa un WhatsApp, y sin correo no hay mailto', () => {
  const links = followUpLinks({ ...order, buyer_phone: '12', buyer_email: '' }, items);
  assert.equal(links.whatsapp, '');
  assert.equal(links.mailto, '');
});
