import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('la home destaca la coordinación de la entrega inmediatamente después del hero', () => {
  const page = read('astro-front/src/pages/index.astro');
  const component = read('astro-front/src/components/DeliveryCoordination.astro');

  assert.match(page, /import DeliveryCoordination/);
  assert.ok(page.indexOf('<DeliveryCoordination />') > page.indexOf('<Hero />'));
  assert.match(component, /El cadete no llega de sorpresa/);
  assert.match(component, /coordinamos contigo la hora o franja/);
  assert.match(component, /Si el cadete llega y no estás, no te preocupes/);
  assert.match(component, /href="\/envios"/);
});

test('envíos y el bloque comercial repiten la tranquilidad sin prometer reentrega gratuita', () => {
  const policy = read('astro-front/src/pages/envios.astro');
  const shipping = read('astro-front/src/components/ShippingPayments.astro');
  const combined = `${policy}\n${shipping}`;

  assert.match(policy, /class="delivery-reassurance"/);
  assert.match(policy, /Si al llegar no estás, no te preocupes/);
  assert.match(shipping, /Coordinamos la hora o franja antes de que salga el cadete/);
  assert.doesNotMatch(combined, /reentrega gratuita|segunda entrega gratis/i);
});
