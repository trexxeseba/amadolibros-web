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
  assert.match(baseLayout, /<script is:inline src="\/analytics-events\.js" defer><\/script>/);
  assert.match(baseLayout, /set:html=\{ANALYTICS_BOOTSTRAP_JS\}/);
  assert.match(brand, /<script src="\/analytics-events\.js" defer><\/script>/);
  assert.match(brand, /\$\{ANALYTICS_BOOTSTRAP_WITH_CONFIG_JS\}/);
});

test('el evento cubre enlaces y aperturas programáticas de WhatsApp', () => {
  assert.match(analytics, /'whatsapp_click'/);
  assert.match(analytics, /'wa\.me'/);
  assert.match(analytics, /'api\.whatsapp\.com'/);
  assert.match(analytics, /'web\.whatsapp\.com'/);
  assert.match(bookRequest, /id="request-wa"[\s\S]*?data-cta-location="book_request_form"/);
  assert.match(cart, /trackWhatsApp\(\{ ctaLocation: 'checkout_order' \}\)/);
  assert.match(searchOverlay, /trackWhatsApp\(\{ ctaLocation: 'search_overlay' \}\)/);
});

test('no envía la URL de WhatsApp, el mensaje, el teléfono ni parámetros de búsqueda a GA4', () => {
  const eventCall = analytics.slice(analytics.indexOf("window.gtag('event', 'whatsapp_click'"));
  assert.doesNotMatch(eventCall, /link_url|searchParams|location\.search|href:|phone/);
  assert.match(analytics, /page_type/);
  assert.match(analytics, /cta_location/);
  assert.match(analytics, /product_id/);
  assert.match(analytics, /topic/);
  assert.match(analytics, /origen/);
  assert.match(analytics, /\bruta\b/);
  assert.match(analytics, /libro_id/);
  assert.match(analytics, /transport_type = 'beacon'/);
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
    origen: 'otro',
    ruta: '/especialidades/oftalmologia',
    libro_id: '',
    transport_type: 'beacon',
  });
  assert.equal(JSON.stringify(params).includes('consulta-privada'), false);
  assert.equal(typeof listeners.click, 'function');
});

// GA4-WHATSAPP-EVENT-1: origen/ruta/libro_id se agregan al whatsapp_click ya
// existente (sin reemplazar page_type/cta_location/product_id/
// availability_type/topic, para no romper nada ya armado en GA4 sobre esos
// campos) y con transport_type=beacon para que el evento llegue aunque el
// clic navegue fuera del sitio de inmediato.
test('el listener delegado detecta los tres dominios de WhatsApp y arma origen/ruta/libro_id con transporte beacon', () => {
  function fireWhatsAppClick(pathname, { href, hasStockBadge = false, inHeader = false } = {}) {
    const listeners = {};
    const window = {
      location: {
        hostname: 'www.amadolibros.com',
        pathname,
        href: `https://www.amadolibros.com${pathname}`,
      },
      dataLayer: [],
    };
    const document = {
      querySelector: (selector) => (selector === '.badge.in-stock' && hasStockBadge ? {} : null),
      createElement: () => ({}),
      head: { appendChild: () => {} },
      addEventListener: (name, handler) => { listeners[name] = handler; },
    };
    runInNewContext(analytics, { document, window, URL, Set, Date, Object, String, encodeURIComponent });

    const anchor = {
      href,
      closest: (selector) => (selector === 'header' && inHeader ? {} : null),
    };
    listeners.click({ target: { closest: (selector) => (selector === 'a[href]' ? anchor : null) } });

    const last = window.dataLayer.at(-1);
    if (!last || Array.from(last)[0] !== 'event') return null;
    const [, eventName, params] = Array.from(last);
    return eventName === 'whatsapp_click' ? { ...params } : null;
  }

  const whatsappHrefs = [
    'https://wa.me/59800000000',
    'https://api.whatsapp.com/send?phone=59800000000',
    'https://web.whatsapp.com/send?phone=59800000000',
  ];
  for (const href of whatsappHrefs) {
    const params = fireWhatsAppClick('/', { href });
    assert.ok(params, `no disparó whatsapp_click para ${href}`);
    assert.equal(params.origen, 'home');
    assert.equal(params.ruta, '/');
    assert.equal(params.libro_id, '');
    assert.equal(params.transport_type, 'beacon');
  }

  // un enlace que no es de WhatsApp no dispara nada.
  assert.equal(fireWhatsAppClick('/', { href: 'https://example.com' }), null);

  assert.equal(
    fireWhatsAppClick('/libros/infantil-juvenil', { href: 'https://wa.me/1' }).origen,
    'catalogo',
  );
  assert.equal(
    fireWhatsAppClick('/catalogo', { href: 'https://wa.me/1' }).origen,
    'catalogo',
  );

  const ficha = fireWhatsAppClick('/libro/MLU1453287196/grandes-clasicos', {
    href: 'https://wa.me/1',
    hasStockBadge: true,
  });
  assert.equal(ficha.origen, 'ficha');
  assert.equal(ficha.libro_id, 'MLU1453287196');
  assert.equal(ficha.ruta, '/libro/MLU1453287196/grandes-clasicos');

  const fichaPausada = fireWhatsAppClick('/libro/MLU1453287196/grandes-clasicos', {
    href: 'https://wa.me/1',
    hasStockBadge: false,
  });
  assert.equal(fichaPausada.origen, 'ficha_pausada');
  assert.equal(fichaPausada.libro_id, 'MLU1453287196');

  const header = fireWhatsAppClick('/libro/MLU1453287196/grandes-clasicos', {
    href: 'https://wa.me/1',
    inHeader: true,
  });
  assert.equal(header.origen, 'header');
  assert.equal(header.libro_id, 'MLU1453287196');

  const otro = fireWhatsAppClick('/contacto', { href: 'https://wa.me/1' });
  assert.equal(otro.origen, 'otro');
  assert.equal(otro.libro_id, '');
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

// BLOQUEANTE PR #310 — punto 1: checkout_error mide en qué etapa se traba
// un comprador, sin ningún dato personal. stage/payment_method/
// delivery_type sólo aceptan valores de una lista cerrada; error_code pasa
// por el mismo safeToken() ya usado en cta_location/topic — nunca se envía
// public_code, nombre, email, teléfono, dirección ni el texto del error.

test('carrito.astro sólo pasa codes internos a trackCheckoutError, nunca error.message ni datos de la orden', () => {
  assert.match(analytics, /'checkout_error'/);
  assert.match(analytics, /CHECKOUT_ERROR_STAGES/);
  assert.match(analytics, /order_create.*preference_create.*transfer_options/);
  assert.match(cart, /trackCheckoutErrorEvent\('order_create', orderData\.code \|\| 'ORDER_CREATE_FAILED', 'mercadopago'\)/);
  assert.match(cart, /trackCheckoutErrorEvent\('order_create', 'NETWORK_ERROR', 'mercadopago'\)/);
  assert.match(cart, /trackCheckoutErrorEvent\('preference_create', mpData\.code \|\| 'PREFERENCE_CREATE_FAILED', 'mercadopago'\)/);
  assert.match(cart, /trackCheckoutErrorEvent\('preference_create', 'NETWORK_ERROR', 'mercadopago'\)/);
  assert.match(cart, /trackCheckoutErrorEvent\(checkoutErrorStage, error && error\.code, 'transfer'\)/);
  // Ninguno de esos llamados pasa error.message, public_code ni datos del comprador.
  const wrapperStart = cart.indexOf('function trackCheckoutErrorEvent');
  const wrapperEnd = cart.indexOf('\n    }', wrapperStart);
  const wrapperBody = cart.slice(wrapperStart, wrapperEnd);
  assert.doesNotMatch(wrapperBody, /\.message|public_code|buyer|email|phone|address/i);
});

test('trackCheckoutError sólo emite con un stage de la lista cerrada, y satura/sanea todo lo demás', () => {
  const window = {
    location: { hostname: 'www.amadolibros.com', pathname: '/carrito', href: 'https://www.amadolibros.com/carrito' },
    dataLayer: [],
  };
  const document = {
    querySelector: () => null,
    createElement: () => ({}),
    head: { appendChild: () => {} },
    addEventListener: () => {},
  };
  runInNewContext(analytics, { document, window, URL, Set, Date, Object, String, encodeURIComponent });

  // stage inválido: no emite nada.
  assert.equal(
    window.AmadoAnalytics.trackCheckoutError({ stage: 'not_a_real_stage', errorCode: 'X' }),
    false,
  );
  assert.equal(window.dataLayer.filter((e) => Array.from(e)[1] === 'checkout_error').length, 0);

  // stage válido, con errorCode/paymentMethod/deliveryType válidos: pasan tal cual.
  assert.equal(window.AmadoAnalytics.trackCheckoutError({
    stage: 'order_create',
    errorCode: 'ORDERS_DB_WRITE_FAILED',
    paymentMethod: 'mercadopago',
    deliveryType: 'pickup',
  }), true);
  const [, eventName, params] = Array.from(window.dataLayer.at(-1));
  assert.equal(eventName, 'checkout_error');
  assert.deepEqual({ ...params }, {
    stage: 'order_create',
    error_code: 'ORDERS_DB_WRITE_FAILED',
    payment_method: 'mercadopago',
    delivery_type: 'pickup',
  });

  // payment_method/delivery_type fuera de la lista cerrada: se omiten, no se inventan.
  window.AmadoAnalytics.trackCheckoutError({
    stage: 'transfer_options',
    errorCode: 'TRANSFER_OPTIONS_FAILED',
    paymentMethod: 'bitcoin',
    deliveryType: 'teletransporte',
  });
  const [, , params2] = Array.from(window.dataLayer.at(-1));
  assert.deepEqual({ ...params2 }, { stage: 'transfer_options', error_code: 'TRANSFER_OPTIONS_FAILED' });

  // Texto libre (no tiene forma de code interno) se descarta ENTERO, no se
  // "limpia" — un sanitizador que preserva dígitos dejaría pasar un
  // teléfono pegado en el medio del texto; acá directamente no hay
  // error_code en el evento.
  window.AmadoAnalytics.trackCheckoutError({
    stage: 'preference_create',
    errorCode: 'no such column: buyer_email at ana@example.com, tel 099123456',
  });
  const [, , params3] = Array.from(window.dataLayer.at(-1));
  assert.equal(JSON.stringify(params3).includes('@'), false);
  assert.equal(JSON.stringify(params3).includes('099123456'), false);
  assert.deepEqual({ ...params3 }, { stage: 'preference_create' });
  assert.equal('error_code' in params3, false);
});

test('expone client_id y session_id anónimos para atribuir la compra server-side', async () => {
  const window = {
    location: {
      hostname: 'www.amadolibros.com',
      pathname: '/carrito',
      href: 'https://www.amadolibros.com/carrito',
    },
    dataLayer: [],
    setTimeout,
    clearTimeout,
    gtag(command, _measurementId, field, callback) {
      if (command !== 'get') return;
      callback(field === 'client_id' ? '123456789.987654321' : 1786921140);
    },
  };
  const document = {
    querySelector: () => ({}),
    createElement: () => ({}),
    head: { appendChild: () => {} },
    addEventListener: () => {},
  };
  runInNewContext(analytics, {
    document, window, URL, Set, Date, Object, String, Number, Math, Array, Promise,
    isFinite, encodeURIComponent,
  });
  assert.deepEqual(
    { ...await window.AmadoAnalytics.getMeasurementContext(500) },
    { client_id: '123456789.987654321', session_id: 1786921140 },
  );
});

// Liquidación y agotados: el botón declara tema e id MLU (data-topic /
// data-mlu) y cta_location (data-cta-location). El evento sigue siendo
// whatsapp_click, el mismo que importa Google Ads.
test('whatsapp_click toma tema, id MLU y cta_location del botón en /liquidacion y en agotados', () => {
  function fire(pathname, attrs) {
    const listeners = {};
    const window = {
      location: { hostname: 'www.amadolibros.com', pathname, href: `https://www.amadolibros.com${pathname}` },
      dataLayer: [],
    };
    const document = {
      querySelector: () => null,
      createElement: () => ({}),
      head: { appendChild: () => {} },
      addEventListener: (name, handler) => { listeners[name] = handler; },
    };
    runInNewContext(analytics, { document, window, URL, Set, Date, Object, String, encodeURIComponent });
    const holder = { getAttribute: name => attrs[name] ?? null };
    const anchor = {
      href: 'https://wa.me/59899841325?text=hola',
      closest: selector => {
        const m = selector.match(/^\[(data-[a-z-]+)\]$/);
        return m && m[1] in attrs ? holder : null;
      },
    };
    listeners.click({ target: { closest: selector => (selector === 'a[href]' ? anchor : null) } });
    const [, eventName, params] = Array.from(window.dataLayer.at(-1));
    assert.equal(eventName, 'whatsapp_click');
    return { ...params };
  }

  const card = fire('/liquidacion', {
    'data-cta-location': 'liquidacion_card',
    'data-mlu': 'mlu1453287196',
    'data-topic': 'psicologia',
  });
  assert.equal(card.cta_location, 'liquidacion_card');
  assert.equal(card.topic, 'psicologia');
  assert.equal(card.product_id, 'MLU1453287196');
  assert.equal(card.libro_id, 'MLU1453287196');
  assert.equal(card.ruta, '/liquidacion');

  const agotados = fire('/libros-agotados-importados-uruguay', {
    'data-cta-location': 'agotados_hero',
    'data-topic': 'libros_agotados_importados',
  });
  assert.equal(agotados.cta_location, 'agotados_hero');
  assert.equal(agotados.topic, 'libros_agotados_importados');
  assert.equal(agotados.libro_id, '');
  assert.equal('product_id' in agotados, false);

  // Un id que no es MLU no viaja.
  const raro = fire('/liquidacion', { 'data-cta-location': 'liquidacion_card', 'data-mlu': '099841325' });
  assert.equal(raro.libro_id, '');
});

test('los CTA de agotados y "Lo quiero" de liquidación declaran sus parámetros', () => {
  const agotadosPage = readFileSync('functions/libros-agotados-importados-uruguay.js', 'utf8');
  assert.match(agotadosPage, /data-cta-location="agotados_hero" data-topic="libros_agotados_importados"/);
  assert.match(agotadosPage, /data-cta-location="agotados_cierre" data-topic="libros_agotados_importados"/);
  assert.doesNotMatch(agotadosPage, /[úu]nicamente|No podemos asegurar/);
});

// ─── Analítica diferida (performance móvil) ─────────────────────────────────
// /analytics-events.js va con defer y gtag.js se descarga después del primer
// pintado. Lo que se prueba acá: (a) ningún script de medición frena el
// render y (b) lo que se dispara antes de que lleguen queda en dataLayer, en
// el mismo orden y con los mismos parámetros.

test('los scripts de medición no bloquean el render en Astro ni en Functions', async () => {
  const { faviconHeadHtml } = await import('../_shared/brand.js');
  const sources = { baseLayout, functionsHead: faviconHeadHtml() };
  for (const [name, html] of Object.entries(sources)) {
    const tags = html.match(/<script\b[^>]*\bsrc=[^>]*>/g) || [];
    const analyticsTags = tags.filter(tag => /analytics-events|googletagmanager/.test(tag));
    assert.ok(analyticsTags.length > 0, `${name}: no encontró la medición`);
    for (const tag of analyticsTags) {
      assert.match(tag, /\s(defer|async)\b/, `${name}: ${tag} bloquea el render`);
    }
    // gtag.js no va en el HTML: lo agrega el arranque después del pintado.
    assert.doesNotMatch(html, /<script[^>]*src=[^>]*googletagmanager/, `${name}: gtag.js sigue en el HTML`);
  }
  // Mismo ID de GA4 que antes.
  assert.match(analytics, /var MEASUREMENT_ID = 'G-SDX45VEPP3';/);
});

function deferredPage(pathname, { readyState = 'loading', hostname = 'www.amadolibros.com' } = {}) {
  const timers = [];
  const listeners = {};
  const docListeners = {};
  const appended = [];
  const on = bag => (name, handler) => { (bag[name] = bag[name] || []).push(handler); };
  const off = bag => (name, handler) => { bag[name] = (bag[name] || []).filter(h => h !== handler); };
  const window = {
    location: { hostname, pathname, href: `https://${hostname}${pathname}?utm_source=x&q=privado` },
    addEventListener: on(listeners),
    removeEventListener: off(listeners),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
  };
  const document = {
    readyState,
    visibilityState: 'visible',
    querySelector: () => null,
    createElement: () => ({}),
    head: { appendChild: node => appended.push(node) },
    addEventListener: on(docListeners),
    removeEventListener: off(docListeners),
  };
  const context = {
    window, document, URL, Set, Date, Object, String, Number, Math, Array, Promise, isFinite,
    encodeURIComponent, setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
  };
  return {
    window, timers, listeners, docListeners,
    run: code => runInNewContext(code, context),
    fire: (bag, name, event = {}) => (bag[name] || []).slice().forEach(h => h(event)),
    gtagScripts: () => appended.filter(n => /googletagmanager\.com\/gtag\/js\?id=G-SDX45VEPP3/.test(n.src)),
  };
}

// JSON: los objetos vienen de otro contexto de vm y deepStrictEqual compara prototipos.
const commands = dataLayer => JSON.parse(JSON.stringify(dataLayer.map(entry => Array.from(entry))));
// El arranque de las páginas de Functions (con js + config incluidos).
const bootstrap = async () => (await import('../../shared/analytics-bootstrap.js')).ANALYTICS_BOOTSTRAP_WITH_CONFIG_JS;
const astroBootstrap = async () => (await import('../../shared/analytics-bootstrap.js')).ANALYTICS_BOOTSTRAP_JS;

test('un evento disparado antes de que cargue gtag.js queda en dataLayer, en orden y sin cambios', async () => {
  const page = deferredPage('/libro/MLU123/un-libro');
  page.run(await bootstrap());

  // Inline de la ficha y de los juegos, antes de analytics-events.js (defer).
  page.window.AmadoAnalytics.trackCommerce('view_item', {
    value: 990, items: [{ item_id: 'MLU123', item_name: 'Un libro', price: 990, quantity: 1 }],
  });
  page.window.gtag('event', 'juego_visto', { juego: 'acertijo' });
  assert.equal(page.gtagScripts().length, 0, 'gtag.js no se pide antes del primer pintado');

  page.run(analytics);
  const sent = commands(page.window.dataLayer);
  // js y config primero (como cuando analytics-events.js era sincrónico);
  // la llamada encolada de view_item se repite al cargar el archivo, así que
  // puede quedar después de un gtag() directo: cada evento sale igual.
  assert.deepEqual(sent.map(c => (c[0] === 'event' ? c[1] : c[0])), ['js', 'config', 'juego_visto', 'view_item']);
  assert.equal(sent[1][1], 'G-SDX45VEPP3');
  assert.equal(sent[1][2].page_location, 'https://www.amadolibros.com/libro/MLU123/un-libro?utm_source=x');
  assert.deepEqual({ ...sent[2][2] }, { juego: 'acertijo' });
  assert.deepEqual(JSON.parse(JSON.stringify(sent[3][2])), {
    currency: 'UYU',
    items: [{
      item_id: 'MLU123', item_name: 'Un libro', item_brand: 'Amado Libros',
      item_category: 'Libros', quantity: 1, price: 990,
    }],
    value: 990,
    availability_type: 'by_request',
  });
  assert.equal(page.window.AmadoAnalytics.__queue, undefined);

  // Todavía sin gtag.js; llega con la primera interacción y una sola vez.
  assert.equal(page.gtagScripts().length, 0);
  page.fire(page.listeners, 'pointerdown');
  page.fire(page.listeners, 'keydown');
  page.timers.forEach(t => t.fn && t.fn());
  assert.equal(page.gtagScripts().length, 1);
  assert.equal(page.gtagScripts()[0].async, true);
});

test('sin interacción, gtag.js llega después de load (momento libre) o por el tope de tiempo', async () => {
  const page = deferredPage('/');
  page.run(await bootstrap());
  page.run(analytics);
  assert.equal(page.gtagScripts().length, 0);
  page.fire(page.listeners, 'load');
  const idle = page.timers.find(t => t.ms === 1500 && t.fn);
  assert.ok(idle, 'sin requestIdleCallback usa un plazo corto después de load');
  idle.fn();
  assert.equal(page.gtagScripts().length, 1);

  const capped = deferredPage('/catalogo');
  capped.run(await bootstrap());
  capped.run(analytics);
  const cap = capped.timers.find(t => t.ms === 6000 && t.fn);
  assert.ok(cap);
  cap.fn();
  assert.equal(capped.gtagScripts().length, 1);
});

test('en /carrito y /pedido gtag.js se pide de inmediato, como antes', async () => {
  for (const path of ['/carrito/', '/carrito', '/pedido/']) {
    const page = deferredPage(path);
    page.run(await astroBootstrap());
    // Lo mismo que hace el inline de BaseLayout con PUBLIC_GA_ID.
    page.window.gtag('js', new Date());
    page.window.gtag('config', 'G-SDX45VEPP3', { page_location: 'x' });
    page.window.AmadoGtag.configured['G-SDX45VEPP3'] = true;
    page.window.AmadoGtag.load('G-SDX45VEPP3');
    assert.equal(page.gtagScripts().length, 1, path);
    page.run(analytics);
    // analytics-events.js no repite js/config ni el script.
    assert.equal(commands(page.window.dataLayer).filter(c => c[0] === 'config').length, 1, path);
    assert.equal(page.gtagScripts().length, 1, path);
  }
});

test('add_to_cart pide gtag.js ya, sin esperar el momento libre', async () => {
  const page = deferredPage('/libro/MLU9/otro');
  page.window.sessionStorage = { getItem: () => null, setItem: () => {} };
  page.run(await bootstrap());
  page.run(analytics);
  assert.equal(page.gtagScripts().length, 0);
  page.window.AmadoAnalytics.trackCommerce('add_to_cart', {
    value: 500, items: [{ item_id: 'MLU9', item_name: 'Otro', price: 500, quantity: 1 }],
  });
  assert.equal(page.gtagScripts().length, 1);
  assert.equal(commands(page.window.dataLayer).at(-1)[1], 'add_to_cart');
});

test('un clic a WhatsApp antes de que cargue analytics-events.js igual se mide, una vez', async () => {
  const page = deferredPage('/');
  page.run(await bootstrap());
  const anchor = { href: 'https://wa.me/59899841325', closest: () => null };
  page.fire(page.docListeners, 'click', { target: { closest: s => (s === 'a[href]' ? anchor : null) } });
  page.run(analytics);
  const events = commands(page.window.dataLayer).filter(c => c[0] === 'event');
  assert.equal(events.length, 1);
  assert.equal(events[0][1], 'whatsapp_click');
  assert.equal(events[0][2].origen, 'home');
  assert.equal(events[0][2].transport_type, 'beacon');
  // El listener temprano se retira: queda sólo el de analytics-events.js.
  assert.equal(page.docListeners.click.length, 1);
});

test('getMeasurementContext nunca deja colgado el checkout si la medición no llega', async () => {
  const page = deferredPage('/carrito/');
  page.run(await bootstrap());
  const pending = page.window.AmadoAnalytics.getMeasurementContext(1200);
  const timer = page.timers.find(t => t.ms === 1200 && t.fn);
  assert.ok(timer);
  timer.fn();
  assert.equal(await pending, null);
});

test('fuera de los dominios productivos el arranque no crea colas ni gtag()', async () => {
  const page = deferredPage('/', { hostname: 'pr-1.amadolibros-web.pages.dev' });
  page.run(await bootstrap());
  assert.equal(page.window.AmadoAnalytics, undefined);
  assert.equal(page.window.gtag, undefined);
  assert.equal(typeof page.window.AmadoGtag.load, 'function');
});
