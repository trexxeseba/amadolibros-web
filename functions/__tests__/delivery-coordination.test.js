import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('la coordinación de Montevideo se explica sin prometer una segunda entrega', () => {
  const component = read('astro-front/src/components/DeliveryCoordination.astro');
  const policy = read('astro-front/src/pages/envios.astro');
  const shipping = read('astro-front/src/components/ShippingPayments.astro');
  const combined = `${component}\n${policy}\n${shipping}`;

  assert.match(component, /El cadete no llega de sorpresa/);
  assert.match(component, /coordinamos contigo la hora o franja/);
  assert.match(component, /Si necesitás cambiarla, avisános antes de que salga el cadete/);
  assert.match(policy, /class="delivery-reassurance"/);
  assert.match(policy, /Si necesitás cambiarla, avisános antes de que salga el cadete/);
  assert.match(shipping, /Coordinamos la hora o franja antes de que salga el cadete/);
  assert.match(shipping, /Si necesitás cambiar la hora o franja coordinada/);
  assert.doesNotMatch(combined, /si (?:el cadete llega|al llegar) y?\s*no estás|volvemos otro día|reentrega gratuita|segunda entrega gratis/i);
});

test('la política conserva costos, cobertura y condiciones verificables', () => {
  const policy = read('astro-front/src/pages/envios.astro');

  assert.match(policy, /19 departamentos de Uruguay/);
  assert.match(policy, /\$250 UYU/);
  assert.match(policy, /gratis desde \$1\.500 UYU/);
  assert.match(policy, /sujeta a disponibilidad, zona, horario y confirmación por WhatsApp/);
  assert.match(policy, /href=\{shippingWhatsApp\}/);
});
