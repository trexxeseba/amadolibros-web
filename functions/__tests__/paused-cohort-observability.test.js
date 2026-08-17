import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const analytics = readFileSync('astro-front/public/analytics-events.js', 'utf8');
const productPage = readFileSync('functions/libro/[[path]].js', 'utf8');

function storage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
}

function analyticsRuntime({ inStock }) {
  const store = storage();
  const window = {
    location: {
      hostname: 'www.amadolibros.com',
      pathname: '/libro/MLU123/libro-de-prueba',
      href: 'https://www.amadolibros.com/libro/MLU123/libro-de-prueba',
    },
    dataLayer: [],
    localStorage: store,
    sessionStorage: store,
  };
  const document = {
    readyState: 'complete',
    querySelector(selector) {
      if (selector === '.badge.in-stock') return inStock ? {} : null;
      return null;
    },
    createElement: () => ({}),
    head: { appendChild: () => {} },
    addEventListener: () => {},
  };

  runInNewContext(analytics, {
    document, window, URL, Set, Date, Object, String, Number, Math, Array, isFinite,
    encodeURIComponent,
  });
  return window;
}

test('view_item distingue fichas activas de fichas por encargo', () => {
  for (const [inStock, expected] of [[true, 'active'], [false, 'by_request']]) {
    const window = analyticsRuntime({ inStock });
    assert.equal(window.AmadoAnalytics.trackCommerce('view_item', {
      items: [{ item_id: 'MLU123', item_name: 'Libro de prueba', quantity: 1 }],
    }), true);

    const event = window.dataLayer.find(entry => {
      const row = Array.from(entry);
      return row[0] === 'event' && row[1] === 'view_item';
    });
    assert.ok(event, 'debe existir view_item');
    assert.equal(Array.from(event)[2].availability_type, expected);
  }
});

test('whatsapp_click incluye availability_type en fichas sin enviar datos personales', () => {
  const window = analyticsRuntime({ inStock: false });
  window.AmadoAnalytics.trackWhatsApp({ ctaLocation: 'primary' });

  const event = Array.from(window.dataLayer.at(-1));
  assert.equal(event[0], 'event');
  assert.equal(event[1], 'whatsapp_click');
  assert.deepEqual({ ...event[2] }, {
    page_type: 'product',
    cta_location: 'primary',
    product_id: 'MLU123',
    availability_type: 'by_request',
  });
  assert.equal(JSON.stringify(event[2]).includes('@'), false);
});

test('stock_waitlist_created se emite sólo tras un alta nueva confirmada', () => {
  let mutationCallback = null;
  const status = {
    textContent: '',
    classList: {
      contains(name) { return name === 'is-ok'; },
    },
  };
  const window = {
    location: {
      hostname: 'www.amadolibros.com',
      pathname: '/libro/MLU456/libro-agotado',
      href: 'https://www.amadolibros.com/libro/MLU456/libro-agotado',
    },
    dataLayer: [],
    MutationObserver: class {
      constructor(callback) { mutationCallback = callback; }
      observe() {}
    },
  };
  const document = {
    readyState: 'complete',
    querySelector: () => null,
    createElement: () => ({}),
    head: { appendChild: () => {} },
    addEventListener: () => {},
    getElementById(id) {
      if (id === 'aviso-stock') return {};
      if (id === 'waitlist-status') return status;
      return null;
    },
  };

  runInNewContext(analytics, {
    document, window, URL, Set, Date, Object, String, Number, Math, Array, isFinite,
    encodeURIComponent,
  });
  assert.equal(typeof mutationCallback, 'function');

  status.textContent = 'Ya teníamos registrado este correo para este libro.';
  mutationCallback();
  assert.equal(window.dataLayer.filter(entry => Array.from(entry)[1] === 'stock_waitlist_created').length, 0);

  status.textContent = 'Pronto. Te avisaremos cuando vuelva a estar disponible.';
  mutationCallback();
  mutationCallback();

  const events = window.dataLayer.filter(entry => Array.from(entry)[1] === 'stock_waitlist_created');
  assert.equal(events.length, 1, 'una alta nueva debe contarse una sola vez');
  assert.deepEqual({ ...Array.from(events[0])[2] }, {
    page_type: 'product',
    product_id: 'MLU456',
    availability_type: 'by_request',
  });
});

test('el contrato UI diferencia alta nueva de correo ya registrado', () => {
  assert.match(productPage, /Ya teníamos registrado este correo para este libro\./);
  assert.match(productPage, /Pronto\. Te avisaremos cuando vuelva a estar disponible\./);
  assert.match(analytics, /stock_waitlist_created/);
  assert.match(analytics, /availability_type/);
  assert.match(analytics, /\^Ya teníamos registrado/i);
});
