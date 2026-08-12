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

test('mide el carrito noindex sin habilitar Analytics en el estado del pedido', () => {
  assert.match(cart, /indexable=\{false\}[\s\S]*analytics=\{true\}/);
  assert.match(orderStatus, /indexable=\{false\}/);
  assert.doesNotMatch(orderStatus, /analytics=\{true\}/);
  assert.match(baseLayout, /analyticsProp !== undefined \? analyticsProp : indexable/);
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
