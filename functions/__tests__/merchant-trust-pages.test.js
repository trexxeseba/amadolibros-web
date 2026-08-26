import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('merchant trust pages exist as Astro routes with canonical URLs', () => {
  for (const page of ['politicas', 'envios', 'devoluciones', 'terminos', 'privacidad', 'contacto']) {
    const path = `astro-front/src/pages/${page}.astro`;
    assert.equal(existsSync(new URL(path, root)), true, `${path} missing`);
    assert.match(read(path), new RegExp(`canonical="https://www\\.amadolibros\\.com/${page}/"`));
  }
});

test('return policy states the statutory window and who pays return shipping', () => {
  const page = read('astro-front/src/pages/devoluciones.astro');
  assert.match(page, /5 días hábiles/);
  assert.match(page, /gastos de retorno son de cargo del comprador/i);
  assert.match(page, /mismo medio utilizado para pagar/i);
});

test('shipping policy matches checkout cost and free-shipping threshold', () => {
  const page = read('astro-front/src/pages/envios.astro');
  const logic = read('functions/api/_orders_logic.js');
  assert.match(page, /\$250 UYU/);
  assert.match(page, /gratis desde \$1\.500 UYU/);
  assert.match(logic, /FREE_SHIPPING_THRESHOLD = 1500/);
  assert.match(logic, /SHIPPING_COST\s+= 250/);
});

test('footer and checkout expose trust links before purchase', () => {
  const footer = read('astro-front/src/components/Footer.astro');
  const cart = read('astro-front/src/pages/carrito.astro');
  for (const href of ['/envios/', '/devoluciones/', '/terminos/', '/privacidad/', '/contacto/']) {
    assert.match(footer, new RegExp(`href="${href}"`));
  }
  assert.match(cart, /href="\/terminos"/);
  assert.match(cart, /href="\/envios"/);
  assert.match(cart, /href="\/devoluciones"/);
});
