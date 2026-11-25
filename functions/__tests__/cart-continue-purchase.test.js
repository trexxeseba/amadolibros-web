import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../astro-front/public/cart.js', import.meta.url), 'utf8');

function harness({ maxQty = 5, price = 2150 } = {}) {
  const listeners = new Map();
  const storage = new Map();
  const sessions = new Map();
  const timers = [];
  const tracked = [];
  let sequence = 0;
  const label = { textContent: 'Agregar al carrito', dataset: {} };
  const attrs = new Map([['aria-label', 'Agregar este libro al carrito']]);
  const button = {
    dataset: { id: 'MLU697960553', title: 'Libro de prueba', price: String(price), maxQty: String(maxQty) },
    querySelector: () => label,
    getAttribute: name => attrs.has(name) ? attrs.get(name) : null,
    setAttribute: (name, value) => attrs.set(name, value),
  };
  const document = {
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(callback);
    },
    dispatchEvent(event) {
      for (const callback of listeners.get(event.type) || []) callback(event);
    },
    querySelectorAll: () => button.dataset.goCart ? [button] : [],
  };
  const window = {
    location: { pathname: '/libro/MLU697960553', search: '', hash: '', href: '' },
    scrollY: 320,
    addEventListener() {},
    AmadoAnalytics: { trackCommerce: (...args) => tracked.push(args) },
  };
  const storageApi = map => ({
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
  });
  vm.runInNewContext(source, {
    window, document,
    localStorage: storageApi(storage),
    sessionStorage: storageApi(sessions),
    crypto: { randomUUID: () => 'key-' + (++sequence) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    setTimeout: callback => timers.push(callback),
    requestAnimationFrame: callback => callback(),
  });
  return {
    cart: window.AmadoCart, window, label, button, tracked, attrs,
    click() {
      document.dispatchEvent({
        type: 'click',
        target: { closest: selector => selector === '[data-action="add-to-cart"]' ? button : null },
      });
    },
    afterOldTimeout() { while (timers.length) timers.shift()(); },
  };
}

test('continuar después del antiguo temporizador abre el carrito sin duplicar unidades ni eventos', () => {
  const h = harness();
  h.click();
  assert.equal(h.cart.count(), 1);
  const key = h.cart.get().idempotency_key;
  h.afterOldTimeout();
  assert.equal(h.label.textContent, 'Agregado — Ver carrito');
  assert.equal(h.attrs.get('aria-label'), 'Ir al carrito');
  h.click();
  assert.equal(h.window.location.href, '/carrito');
  assert.equal(h.cart.count(), 1);
  assert.equal(h.cart.get().idempotency_key, key);
  assert.equal(h.tracked.length, 1);
  assert.equal(h.tracked[0][0], 'add_to_cart');
  assert.equal(h.window.AmadoMetaQueue.length, 1);
});

test('si se elimina el producto, el botón permite volver a agregarlo', () => {
  const h = harness();
  h.click();
  h.cart.remove('MLU697960553');
  assert.equal(h.label.textContent, 'Agregar al carrito');
  assert.equal(h.button.dataset.goCart, undefined);
  assert.equal(h.attrs.get('aria-label'), 'Agregar este libro al carrito');
  h.click();
  assert.equal(h.cart.count(), 1);
  assert.equal(h.tracked.length, 2);
});

test('al alcanzar el stock máximo se puede ir al carrito sin registrar otra incorporación', () => {
  const h = harness({ maxQty: 1 });
  h.cart.add({ id: 'MLU697960553', title: 'Libro de prueba', price: 2150, max_qty: 1 });
  h.click();
  assert.equal(h.label.textContent, 'Máximo disponible en el carrito — Ver carrito');
  h.afterOldTimeout();
  h.click();
  assert.equal(h.window.location.href, '/carrito');
  assert.equal(h.cart.count(), 1);
  assert.equal(h.tracked.length, 0);
});

test('la edición intencional de cantidades en el carrito conserva su funcionamiento', () => {
  const h = harness();
  h.click();
  h.cart.setQty('MLU697960553', 2);
  h.click();
  assert.equal(h.window.location.href, '/carrito');
  assert.equal(h.cart.count(), 2);
});

test('un precio inválido no anuncia que el libro fue agregado', () => {
  const h = harness({ price: 0 });
  h.click();
  assert.equal(h.cart.count(), 0);
  assert.equal(h.button.dataset.goCart, undefined);
  assert.equal(h.label.textContent, 'Agregar al carrito');
  assert.equal(h.tracked.length, 0);
});
