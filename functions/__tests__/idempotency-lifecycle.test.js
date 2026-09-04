import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

// BLOQUEANTE PR #310 — prueba humana: "Conflicto: el mismo idempotency_key
// fue usado con un pedido diferente." al crear una orden, volver al
// checkout y cambiar el pedido (entrega/datos) antes de reintentar.
//
// Causa raíz: cart.js sólo rotaba idempotency_key ante cambios de ITEMS
// (add/remove/setQty/syncValidated/clear) — nunca ante cambios de
// delivery_type/buyer/shipping, que también forman parte del
// request_fingerprint real (generateFingerprint() en _orders_logic.js).
// carrito.astro sólo rotaba explícitamente al volver desde la pantalla de
// transferencia (btnEditOrder) — cualquier otro camino de vuelta al
// checkout (volver de Mercado Pago, recargar la página) dejaba la MISMA
// key asociada a un fingerprint viejo, y un pedido distinto con esa key
// chocaba con el fail-safe del backend (409).
//
// Esta suite cubre el ciclo de vida centralizado: AmadoCart.
// ensureKeyForFingerprint(fingerprint) decide, antes de cada submit, si la
// key vigente sigue sirviendo para el fingerprint actual o si hay que
// rotar — sin rotar en cada intento (retry de red / doble click deben
// conservar la misma key).

const cartJs = readFileSync('astro-front/public/cart.js', 'utf8');
const carrito = readFileSync('astro-front/src/pages/carrito.astro', 'utf8');
const ordersHandler = readFileSync('functions/api/_orders_handler.js', 'utf8');

function makeStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    _store: store,
  };
}

function loadCart(sharedLocalStorage) {
  const window_ = { location: { pathname: '/carrito' }, addEventListener: () => {} };
  const document_ = {
    dispatchEvent: () => {},
    addEventListener: () => {},
    readyState: 'complete',
  };
  const localStorage = sharedLocalStorage || makeStorage();
  const sessionStorage = makeStorage();
  let uuidCounter = 0;
  const sandbox = {
    window: window_,
    document: document_,
    localStorage,
    sessionStorage,
    crypto: { randomUUID: () => 'uuid-' + (++uuidCounter) },
    CustomEvent: function CustomEvent(name, opts) { this.type = name; this.detail = opts && opts.detail; },
    requestAnimationFrame: () => {},
    Date, Math, Array, JSON, Object, String, Number, isFinite,
  };
  runInNewContext(cartJs, sandbox);
  return { AmadoCart: window_.AmadoCart, localStorage };
}

test('A/B — retry del mismo pedido (red o doble click): misma key, sin rotar', () => {
  const { AmadoCart } = loadCart();
  AmadoCart.add({ id: 'MLU1', price: 500 });
  const key0 = AmadoCart.get().idempotency_key;

  const fp = 'fingerprint-fijo-1';
  const k1 = AmadoCart.ensureKeyForFingerprint(fp);
  assert.equal(k1, key0, 'primer submit: conserva la key con la que se creó el carrito');

  // Reintentos repetidos con el fingerprint idéntico (red, doble click) no
  // deben rotar nunca — ni una sola vez de más.
  for (let i = 0; i < 4; i++) {
    assert.equal(AmadoCart.ensureKeyForFingerprint(fp), key0);
  }
});

test('C/D/E — orden ya creada + cambia entrega/datos/dirección: nueva key', () => {
  const { AmadoCart } = loadCart();
  AmadoCart.add({ id: 'MLU1', price: 500 });
  const key0 = AmadoCart.get().idempotency_key;

  const fpPickup = 'fp-retiro-juan';
  assert.equal(AmadoCart.ensureKeyForFingerprint(fpPickup), key0);

  // C: cambia delivery_type (retiro -> envío)
  const fpShipping = 'fp-envio-juan';
  const keyAfterDeliveryChange = AmadoCart.ensureKeyForFingerprint(fpShipping);
  assert.notEqual(keyAfterDeliveryChange, key0, 'delivery_type distinto debe rotar');

  // Retry inmediato del MISMO fingerprint nuevo: no rota de nuevo.
  assert.equal(AmadoCart.ensureKeyForFingerprint(fpShipping), keyAfterDeliveryChange);

  // D: cambia comprador (nombre/teléfono/email)
  const fpBuyerChanged = 'fp-envio-maria';
  const keyAfterBuyerChange = AmadoCart.ensureKeyForFingerprint(fpBuyerChanged);
  assert.notEqual(keyAfterBuyerChange, keyAfterDeliveryChange, 'comprador distinto debe rotar');

  // E: cambia dirección/barrio/departamento/notas
  const fpAddressChanged = 'fp-envio-maria-direccion-2';
  const keyAfterAddressChange = AmadoCart.ensureKeyForFingerprint(fpAddressChanged);
  assert.notEqual(keyAfterAddressChange, keyAfterBuyerChange, 'dirección distinta debe rotar');
});

test('F — cambiar items ya rota por su cuenta (cart.js); ensureKeyForFingerprint no rota una segunda vez', () => {
  const { AmadoCart } = loadCart();
  AmadoCart.add({ id: 'MLU1', price: 500 });
  const fp1 = 'fp-un-item';
  const key1 = AmadoCart.ensureKeyForFingerprint(fp1);

  // Cambiar el carrito rota la key por su cuenta (ya existía antes de este
  // fix) — sin pasar por ensureKeyForFingerprint todavía.
  AmadoCart.add({ id: 'MLU2', price: 300 });
  const keyAfterItemChange = AmadoCart.get().idempotency_key;
  assert.notEqual(keyAfterItemChange, key1);

  // El siguiente submit calcula un fingerprint distinto (dos items) — pero
  // como la key YA cambió por el propio cart.js, no debe rotar de nuevo.
  const fp2 = 'fp-dos-items';
  const key2 = AmadoCart.ensureKeyForFingerprint(fp2);
  assert.equal(key2, keyAfterItemChange, 'no debe haber una segunda rotación redundante');
});

test('G — volver sin cambiar nada (recarga de página incluida): misma key, reutiliza la orden', () => {
  const shared = makeStorage();
  const { AmadoCart: cartA } = loadCart(shared);
  cartA.add({ id: 'MLU1', price: 500 });
  const fp = 'fp-sin-cambios';
  const key1 = cartA.ensureKeyForFingerprint(fp);

  // Simula un reload: nueva instancia de cart.js sobre el MISMO localStorage.
  const { AmadoCart: cartB } = loadCart(shared);
  const key2 = cartB.ensureKeyForFingerprint(fp);
  assert.equal(key2, key1, 'tras un reload, el mismo fingerprint debe conservar la key');
});

test('I — orden expirada / conflicto inesperado: rotateKey() dispara una key nueva sin doble rotación', () => {
  const { AmadoCart } = loadCart();
  AmadoCart.add({ id: 'MLU1', price: 500 });
  const fp = 'fp-orden-vencida';
  const keyBefore = AmadoCart.ensureKeyForFingerprint(fp);

  // El cliente detecta ORDER_EXPIRED / IDEMPOTENCY_CONFLICT y llama
  // rotateKey() explícitamente (ver carrito.astro).
  const rotated = AmadoCart.rotateKey();
  assert.notEqual(rotated, keyBefore);

  // El próximo intento, aunque calcule el MISMO fingerprint que antes (el
  // comprador no cambió nada, sólo reintenta), no debe rotar una segunda
  // vez — la key ya es nueva.
  const keyRetry = AmadoCart.ensureKeyForFingerprint(fp);
  assert.equal(keyRetry, rotated);
});

test('el fingerprint del cliente nunca incluye el medio de pago (paridad con el backend)', () => {
  // H: cambiar Mercado Pago <-> Transferencia sin tocar el resto del pedido
  // no debe afectar el fingerprint (igual que generateFingerprint() en el
  // backend, que tampoco lo incluye) — así el servidor reconoce el mismo
  // pedido y lo reutiliza en vez de generar un 409.
  assert.match(carrito, /function checkoutFingerprint\(cart, deliveryType, buyer, shipping\)/);
  const start = carrito.indexOf('function checkoutFingerprint(cart, deliveryType, buyer, shipping)');
  const end = carrito.indexOf('\n    }', start);
  const body = carrito.slice(start, end);
  assert.doesNotMatch(body, /payment.?method/i);
});

test('carrito.astro llama a ensureKeyForFingerprint antes de CADA submit a /api/orders (MP y transferencia)', () => {
  assert.match(carrito, /window\.AmadoCart\.ensureKeyForFingerprint\(fingerprint\)/);
  assert.match(carrito, /window\.AmadoCart\.ensureKeyForFingerprint\(prepFingerprint\)/);
  // Ambas llamadas releen el carrito después, para que el payload use la
  // key (posiblemente rotada) y no una copia vieja en memoria.
  const calls = carrito.match(/ensureKeyForFingerprint\([a-zA-Z]+\);\s*\n\s*cart = window\.AmadoCart\.get\(\);/g) || [];
  assert.equal(calls.length, 2);
});

test('backend: 409 por fingerprint distinto trae un code interno de recuperación', () => {
  assert.match(
    ordersHandler,
    /error: 'Conflicto: el mismo idempotency_key fue usado con un pedido diferente\.', code: 'IDEMPOTENCY_CONFLICT'/
  );
});

test('cliente: IDEMPOTENCY_CONFLICT y ORDER_EXPIRED rotan la key y muestran un mensaje humano — nunca el término técnico', () => {
  for (const marker of ["orderData.code === 'IDEMPOTENCY_CONFLICT'", "orderData.code === 'IDEMPOTENCY_CONFLICT' || orderData.code === 'ORDER_EXPIRED'"]) {
    assert.ok(carrito.includes(marker), `falta manejar: ${marker}`);
  }
  assert.match(carrito, /Actualizamos tu pedido para poder continuar\. Intentá nuevamente\./);
  assert.equal((carrito.match(/window\.AmadoCart\.rotateKey\(\)/g) || []).length >= 3, true);

  // El texto técnico del backend nunca debe llegar al cliente para este
  // caso puntual: se reemplaza siempre por el mensaje humano, nunca se
  // reenvía orderData.error cuando code === 'IDEMPOTENCY_CONFLICT'.
  const idempBlockRe = /IDEMPOTENCY_CONFLICT'[\s\S]{0,650}/g;
  const blocks = carrito.match(idempBlockRe) || [];
  assert.ok(blocks.length >= 2);
  for (const block of blocks) {
    assert.doesNotMatch(block.slice(0, 500), /idempotency_key['"]?\s*fue usado/);
  }
});

test('checkout_error se instrumenta para el conflicto de idempotencia, sin PII', () => {
  assert.match(carrito, /trackCheckoutErrorEvent\('order_create', orderData\.code, 'mercadopago'\)/);
  // El code que viaja a GA4 es siempre el code interno (IDEMPOTENCY_CONFLICT
  // / ORDER_EXPIRED), nunca el mensaje ni datos del comprador — mismo
  // contrato que ya prueba functions/__tests__/analytics-events.test.js
  // para trackCheckoutError().
});
