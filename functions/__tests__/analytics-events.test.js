import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const analytics = readFileSync('astro-front/public/analytics-events.js', 'utf8');
const baseLayout = readFileSync('astro-front/src/layouts/BaseLayout.astro', 'utf8');
const brand = readFileSync('functions/_shared/brand.js', 'utf8');
const bookRequest = readFileSync('astro-front/src/pages/pedir-libro.astro', 'utf8');
const cart = readFileSync('astro-front/src/pages/carrito.astro', 'utf8');
const orderStatus = readFileSync('astro-front/src/pages/pedido.astro', 'utf8');
const searchOverlay = readFileSync('astro-front/src/components/SearchOverlay.astro', 'utf8');

test('carga la medición compartida en páginas Astro y SSR', () => {
  assert.match(baseLayout, /<script is:inline src="\/analytics-events\.js"><\/script>/);
  assert.match(brand, /<script src="\/analytics-events\.js"><\/script>/);
});

test('el evento cubre enlaces y aperturas programáticas de WhatsApp', () => {
  assert.match(analytics, /'whatsapp_click'/);
  assert.match(analytics, /'wa\.me'/);
  assert.match(analytics, /'api\.whatsapp\.com'/);
  assert.match(bookRequest, /trackWhatsApp\(\{[\s\S]*book_request_form/);
  assert.match(cart, /trackWhatsApp\(\{ ctaLocation: 'checkout_order' \}\)/);
  assert.match(searchOverlay, /trackWhatsApp\(\{ ctaLocation: 'search_overlay' \}\)/);
});

test('no envía la URL de WhatsApp, el mensaje ni parámetros de búsqueda a GA4', () => {
  const eventCall = analytics.slice(analytics.indexOf("window.gtag('event', 'whatsapp_click'"));
  assert.doesNotMatch(eventCall, /link_url|searchParams|location\.search|href:/);
  assert.match(analytics, /page_type/);
  assert.match(analytics, /cta_location/);
  assert.match(analytics, /product_id/);
  assert.match(analytics, /topic/);
  assert.match(analytics, /allowedParameters/);
  assert.match(baseLayout, /allowedParameters/);
});

test('GA4 queda apagado fuera de los dominios productivos', () => {
  assert.match(analytics, /PRODUCTION_HOSTS/);
  assert.match(analytics, /if \(!PRODUCTION_HOSTS\.has\(window\.location\.hostname\)\) return/);
});

test('mide carrito y pedido, ambos noindex, para reconstruir el embudo sin indexarlos', () => {
  assert.match(cart, /indexable=\{false\}[\s\S]*analytics=\{true\}/);
  assert.match(orderStatus, /indexable=\{false\}[\s\S]*analytics=\{true\}/);
  assert.match(baseLayout, /analyticsProp !== undefined \? analyticsProp : indexable/);
});

test('implementa el embudo GA4 recomendado con item_id y compra deduplicada', () => {
  for (const eventName of ['view_item', 'add_to_cart', 'view_cart', 'begin_checkout', 'purchase']) {
    assert.match(analytics, new RegExp(`'${eventName}'`));
  }
  assert.match(analytics, /item_id:/);
  assert.match(analytics, /transaction_id/);
  assert.match(analytics, /currency: 'UYU'/);
  assert.match(orderStatus, /trackCommerce\('purchase'/);
});

test('el payload real usa contexto estable y descarta la query sensible', () => {
  const listeners = {};
  const window = {
    location: {
      hostname: 'www.amadolibros.com',
      pathname: '/especialidades/oftalmologia',
      href: 'https://www.amadolibros.com/especialidades/oftalmologia?q=consulta-privada&utm_source=chatgpt.com',
    },
    dataLayer: [],
  };
  const document = {
    querySelector: () => null,
    createElement: () => ({}),
    head: { appendChild: () => {} },
    addEventListener: (name, handler) => { listeners[name] = handler; },
  };

  runInNewContext(analytics, { document, window, URL, Set, Date, Object, String, encodeURIComponent });
  const [, , config] = Array.from(window.dataLayer.find((entry) => Array.from(entry)[0] === 'config'));
  assert.equal(
    config.page_location,
    'https://www.amadolibros.com/especialidades/oftalmologia?utm_source=chatgpt.com',
  );
  window.AmadoAnalytics.trackWhatsApp({ ctaLocation: 'hero principal' });

  const [eventCommand, eventName, params] = Array.from(window.dataLayer.at(-1));
  assert.equal(eventCommand, 'event');
  assert.equal(eventName, 'whatsapp_click');
  assert.deepEqual({ ...params }, {
    page_type: 'specialty',
    cta_location: 'hero_principal',
    topic: 'oftalmologia',
  });
  assert.equal(JSON.stringify(params).includes('consulta-privada'), false);
  assert.equal(typeof listeners.click, 'function');
});

test('trackCommerce normaliza el producto y no duplica purchase al recargar', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  const window = {
    location: {
      hostname: 'www.amadolibros.com',
      pathname: '/pedido',
      href: 'https://www.amadolibros.com/pedido?code=secreto',
    },
    dataLayer: [],
    localStorage: storage,
    sessionStorage: storage,
  };
  const document = {
    querySelector: () => null,
    createElement: () => ({}),
    head: { appendChild: () => {} },
    addEventListener: () => {},
  };

  runInNewContext(analytics, {
    document, window, URL, Set, Date, Object, String, Number, Math, Array, isFinite,
    encodeURIComponent,
  });
  const payload = {
    transactionId: 'AL-001',
    value: 1290,
    shipping: 190,
    items: [{ product_id: 'MLU123', title: 'Libro', unit_price_uyu: 1100, quantity: 1 }],
  };
  assert.equal(window.AmadoAnalytics.trackCommerce('purchase', payload), true);
  assert.equal(window.AmadoAnalytics.trackCommerce('purchase', payload), false);

  const purchaseEvents = window.dataLayer.filter(
    entry => Array.from(entry)[0] === 'event' && Array.from(entry)[1] === 'purchase',
  );
  assert.equal(purchaseEvents.length, 1);
  const params = Array.from(purchaseEvents[0])[2];
  assert.equal(params.transaction_id, 'AL-001');
  assert.equal(params.currency, 'UYU');
  assert.equal(params.items[0].item_id, 'MLU123');
  assert.equal(params.items[0].price, 1100);
});
