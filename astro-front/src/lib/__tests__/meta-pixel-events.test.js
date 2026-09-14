// Prueba el archivo REAL que se sirve en /analytics-events.js, no una copia de
// su lógica. Es un IIFE que habla con `window` y `document` globales, así que
// se ejecuta dentro de un vm con lo mínimo que toca. Si mañana alguien mueve
// el espejo a Meta, esta prueba se entera; una copia del mapeo acá adentro no
// se enteraría de nada.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const FUENTE = readFileSync(
  fileURLToPath(new URL('../../../public/analytics-events.js', import.meta.url)),
  'utf8',
);

function almacenamiento() {
  const datos = new Map();
  return {
    getItem: key => (datos.has(key) ? datos.get(key) : null),
    setItem: (key, value) => datos.set(key, String(value)),
  };
}

function cargar({ conPixel = true, pathname = '/carrito' } = {}) {
  const gtagCalls = [];
  const fbqCalls = [];

  const documento = {
    readyState: 'complete',
    head: { appendChild() {} },
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ set src(_v) {}, get src() { return ''; } }),
    addEventListener() {},
  };

  const ventana = {
    location: {
      hostname: 'www.amadolibros.com',
      href: 'https://www.amadolibros.com' + pathname,
      pathname,
    },
    document: documento,
    localStorage: almacenamiento(),
    sessionStorage: almacenamiento(),
    MutationObserver: function () { this.observe = () => {}; },
    setTimeout: () => 0,
    clearTimeout: () => {},
    gtag: (...args) => gtagCalls.push(args),
  };
  if (conPixel) ventana.fbq = (...args) => fbqCalls.push(args);

  const contexto = createContext({ window: ventana, document: documento, console, URL });
  runInContext(FUENTE, contexto);

  return { api: ventana.AmadoAnalytics, gtagCalls, fbqCalls, ventana };
}

const LIBRO = { item_id: 'MLU123', item_name: 'Cómo dejar de pensar demasiado', price: 890, quantity: 1 };

function eventosMeta(fbqCalls) {
  return fbqCalls.filter(call => call[0] === 'track');
}

test('una compra llega a Meta con monto, moneda y los ids del pedido', () => {
  const { api, fbqCalls } = cargar();

  assert.equal(
    api.trackCommerce('purchase', { items: [LIBRO], value: 890, transactionId: 'AL-260914-ABC123' }),
    true,
  );

  const [nombre, evento, payload, opciones] = eventosMeta(fbqCalls)[0];
  assert.equal(nombre, 'track');
  assert.equal(evento, 'Purchase');
  assert.equal(payload.value, 890);
  assert.equal(payload.currency, 'UYU');
  assert.equal(payload.content_type, 'product');
  assert.equal(payload.content_ids.length, 1);
  assert.equal(payload.content_ids[0], 'MLU123');
  assert.equal(payload.contents.length, 1);
  assert.equal(payload.contents[0].id, 'MLU123');
  assert.equal(payload.contents[0].quantity, 1);
  assert.equal(payload.contents[0].item_price, 890);
  // Sin esto, el día que la compra se mande también desde el servidor se
  // contaría dos veces.
  assert.equal(opciones.eventID, 'AL-260914-ABC123');
});

test('el embudo entero queda espejado con los nombres que Meta entiende', () => {
  for (const [propio, deMeta] of [
    ['view_item', 'ViewContent'],
    ['add_to_cart', 'AddToCart'],
    ['begin_checkout', 'InitiateCheckout'],
  ]) {
    const { api, fbqCalls } = cargar();
    assert.equal(api.trackCommerce(propio, { items: [LIBRO] }), true);
    assert.equal(eventosMeta(fbqCalls)[0][1], deMeta, propio + ' → ' + deMeta);
  }
});

test('la misma compra no se le cuenta dos veces a Meta', () => {
  const { api, fbqCalls } = cargar();
  const compra = { items: [LIBRO], value: 890, transactionId: 'AL-260914-REPE' };

  assert.equal(api.trackCommerce('purchase', compra), true);
  assert.equal(api.trackCommerce('purchase', compra), false);

  assert.equal(eventosMeta(fbqCalls).length, 1, 'la segunda vez no le llega nada a Meta');
});

test('un clic a WhatsApp le llega a Meta como Contact', () => {
  const { api, fbqCalls } = cargar({ pathname: '/libro/MLU123/libro' });

  api.trackWhatsApp({ ctaLocation: 'primary' });

  const contacto = eventosMeta(fbqCalls).find(call => call[1] === 'Contact');
  assert.ok(contacto, 'Meta recibe el clic a WhatsApp');
  assert.equal(contacto[2].content_category, 'product');
});

test('sin píxel cargado, GA4 sigue midiendo igual y nada explota', () => {
  const { api, gtagCalls, fbqCalls, ventana } = cargar({ conPixel: false });

  assert.equal(ventana.fbq, undefined);
  assert.equal(
    api.trackCommerce('purchase', { items: [LIBRO], value: 890, transactionId: 'AL-SIN-PIXEL' }),
    true,
    'la compra se sigue midiendo en GA4',
  );
  assert.ok(gtagCalls.some(call => call[0] === 'event' && call[1] === 'purchase'));
  assert.equal(fbqCalls.length, 0);
});

test('un evento que no es de compra no inventa nada en Meta', () => {
  const { api, fbqCalls } = cargar();
  assert.equal(api.trackMetaCommerce('checkout_error', { items: [], currency: 'UYU' }), false);
  assert.equal(eventosMeta(fbqCalls).length, 0);
});

test('mientras el id del píxel esté vacío, no se le pide nada a Facebook', () => {
  // El interruptor: META_PIXEL_ID vacío en analytics-events.js. Es lo único
  // que falta para que el píxel empiece a medir, y hasta entonces el sitio se
  // comporta como si Meta no existiera.
  const { api, ventana } = cargar({ conPixel: false });

  assert.equal(api.ensureMetaPixel(), false);
  assert.equal(ventana.fbq, undefined, 'no se define fbq ni se carga fbevents.js');
});
