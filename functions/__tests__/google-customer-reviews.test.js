import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const helperSource = readFileSync(
  path.join(ROOT, 'astro-front', 'public', 'google-customer-reviews.js'),
  'utf8',
);
const baseLayout = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'layouts', 'BaseLayout.astro'),
  'utf8',
);

function makeHarness({ enabled = true, pathName = '/otro', headingText = '', draft = null, gapi = null } = {}) {
  const storage = new Map();
  const appendedScripts = [];
  const configNode = {
    getAttribute(name) {
      if (name === 'data-enabled') return enabled ? 'true' : 'false';
      if (name === 'data-merchant-id') return '5330457716';
      return null;
    },
  };
  const heading = { textContent: headingText };

  if (draft) storage.set('amado-checkout-draft-v2', JSON.stringify(draft));

  const sessionStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
  };
  const document = {
    readyState: 'complete',
    querySelector(selector) { return selector === 'meta[name="amado-gcr-config"]' ? configNode : null; },
    getElementById(id) {
      if (id === 'pedido-h1') return heading;
      if (id === 'amado-gcr-platform') return appendedScripts.find((s) => s.id === id) || null;
      return null;
    },
    createElement(tag) { return { tagName: tag.toUpperCase() }; },
    head: {
      appendChild(node) { appendedScripts.push(node); },
    },
    addEventListener() {},
  };

  class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
  }

  const window = {
    location: { pathname: pathName, search: '?result=success&code=AL-MP-1' },
    gapi,
  };
  window.window = window;

  const context = vm.createContext({
    window,
    document,
    sessionStorage,
    MutationObserver,
    URLSearchParams,
    Date,
    Number,
    String,
    Math,
  });
  vm.runInContext(helperSource, context);
  return { window, appendedScripts, storage, heading };
}

const validDraft = {
  delivery_type: 'shipping',
  values: {
    'buyer-email': 'cliente@example.com',
    'delivery-departamento': 'Montevideo',
  },
};

test('BaseLayout carga Customer Reviews únicamente en /pedido y detrás de flag', () => {
  assert.match(baseLayout, /const gcrPath = Astro\.url\.pathname === '\/pedido';/);
  assert.doesNotMatch(baseLayout, /Astro\.url\.pathname === '\/carrito' \|\|/);
  assert.match(baseLayout, /PUBLIC_GCR_ENABLED === 'true'/);
  assert.match(baseLayout, /PUBLIC_GCR_MERCHANT_ID \|\| '5330457716'/);
  assert.match(baseLayout, /google-customer-reviews\.js/);
});

test('flag OFF: no carga platform.js de Google ni inicia opt-in', () => {
  const h = makeHarness({ enabled: false, draft: validDraft });
  const result = h.window.AmadoGoogleCustomerReviews.requestForOrder('AL-1');
  assert.equal(result.started, false);
  assert.equal(result.reason, 'disabled');
  assert.equal(h.appendedScripts.length, 0);
});

test('flag ON: carga platform.js únicamente cuando existe una orden y email válidos', () => {
  const h = makeHarness({ enabled: true, draft: validDraft });
  assert.equal(h.appendedScripts.length, 0, 'navegación normal no debe llamar a Google');
  const result = h.window.AmadoGoogleCustomerReviews.requestForOrder('AL-1');
  assert.equal(result.started, true);
  assert.equal(result.via, 'lazy_script');
  assert.equal(h.appendedScripts.length, 1);
  assert.equal(h.appendedScripts[0].src, 'https://apis.google.com/js/platform.js?onload=renderOptIn');
});

test('sin email válido: fail-open y 0 requests a Google', () => {
  const h = makeHarness({
    enabled: true,
    draft: { delivery_type: 'shipping', values: { 'buyer-email': 'no-es-email' } },
  });
  const result = h.window.AmadoGoogleCustomerReviews.requestForOrder('AL-2');
  assert.equal(result.started, false);
  assert.equal(result.reason, 'email');
  assert.equal(h.appendedScripts.length, 0);
});

test('gapi existente: payload contiene todos los campos requeridos por Google', () => {
  let rendered = null;
  const gapi = {
    load(name, callback) {
      assert.equal(name, 'surveyoptin');
      callback();
    },
    surveyoptin: {
      render(payload) { rendered = payload; },
    },
  };
  const h = makeHarness({ enabled: true, draft: validDraft, gapi });
  const result = h.window.AmadoGoogleCustomerReviews.requestForOrder('AL-3');
  assert.equal(result.started, true);
  assert.equal(result.via, 'existing_gapi');
  assert.equal(rendered.merchant_id, 5330457716);
  assert.equal(rendered.order_id, 'AL-3');
  assert.equal(rendered.email, 'cliente@example.com');
  assert.equal(rendered.delivery_country, 'UY');
  assert.equal(rendered.opt_in_style, 'CENTER_DIALOG');
  assert.match(rendered.estimated_delivery_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(h.window.___gcfg.lang, 'es-419');
});

test('una orden no muestra el opt-in dos veces en la misma sesión', () => {
  const gapi = {
    load(_name, callback) { callback(); },
    surveyoptin: { render() {} },
  };
  const h = makeHarness({ enabled: true, draft: validDraft, gapi });
  assert.equal(h.window.AmadoGoogleCustomerReviews.requestForOrder('AL-4').started, true);
  const second = h.window.AmadoGoogleCustomerReviews.requestForOrder('AL-4');
  assert.equal(second.started, false);
  assert.equal(second.reason, 'already_shown');
});

test('/pedido sólo dispara automáticamente después de confirmación real del pago', () => {
  const pending = makeHarness({
    enabled: true,
    pathName: '/pedido',
    headingText: 'Estamos verificando el pago…',
    draft: validDraft,
  });
  assert.equal(pending.appendedScripts.length, 0);

  const approved = makeHarness({
    enabled: true,
    pathName: '/pedido',
    headingText: 'Pago confirmado',
    draft: validDraft,
  });
  assert.equal(approved.appendedScripts.length, 1);
});

test('/carrito y transferencia quedan fuera de fase 1', () => {
  const h = makeHarness({ enabled: true, pathName: '/carrito', draft: validDraft });
  assert.equal(h.appendedScripts.length, 0);
  assert.doesNotMatch(helperSource, /btn-transfer-whatsapp/);
  assert.doesNotMatch(helperSource, /transfer-order-code/);
});

test('fase 1 no inventa GTINs/product reviews: sólo store review', () => {
  assert.doesNotMatch(helperSource, /products\s*:/);
  assert.doesNotMatch(helperSource, /gtin\s*:/);
});
