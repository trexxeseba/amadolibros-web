// V1.1 — CHECKOUT GUIDANCE.
//
// Dos cambios sobre el carrito, ambos puramente de guía/UX:
//
//   1. Elegir entrega deja de ser condición para que el CTA de pago esté
//      "disabled" — antes, sin entrega, el click ni siquiera llegaba a
//      requireDeliveryType() (que ya mostraba mensaje/foco/scroll) porque el
//      navegador no dispara "click" en un <button disabled>. Ahora el CTA
//      sigue interactuable cuando la entrega es lo único que falta, y
//      orders-guard.js (que corre en fase capture, antes que el handler de
//      carrito.astro) tampoco debe taparlo pidiendo nombre/teléfono primero.
//   2. #cart-shipping-msg, que existía pero quedaba siempre hidden, ahora se
//      conecta dentro de updateTotals() reusando el subtotal/umbral/fmt ya
//      calculados — sin duplicar la lógica de envío gratis.
//
// Mismo criterio que pickup-cx-1/2 y checkout-single-step: sin DOM real,
// se verifica la estructura del código fuente con regex sobre el archivo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CARRITO = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'pages', 'carrito.astro'),
  'utf8',
);
const GUARD = readFileSync(
  path.join(ROOT, 'astro-front', 'public', 'orders-guard.js'),
  'utf8',
);

// ── 1. Sin entrega elegida, el CTA no queda inerte ──────────────────────────

test('1a. la falta de entrega ya no forma parte del criterio "disabled" de los CTA de pago', () => {
  const start = CARRITO.indexOf('function syncPaymentAvailability');
  assert.notEqual(start, -1);
  const end = CARRITO.indexOf('\n    }', CARRITO.indexOf('deliveryHintEl.hidden', start));
  const fn = CARRITO.slice(start, end);

  // El bloqueo real (validación de stock/carrito vacío) sigue existiendo...
  assert.match(fn, /var technicallyReady = cartValidationReady && !cartValidationFailed &&\s*\n\s*!validationRequest && getSellableItems\(cart\)\.length > 0;/);
  // ...pero ya no exige getDeliveryType() para habilitar el botón.
  assert.doesNotMatch(fn, /technicallyReady[\s\S]{0,40}getDeliveryType/);
  assert.match(fn, /transferButton\.disabled = !technicallyReady/);
  assert.match(fn, /mercadoPagoButton\.disabled = !technicallyReady/);
});

test('1b. los bloqueos técnicos reales (carrito vacío, stock inválido, envío en curso) siguen deshabilitando el CTA', () => {
  const start = CARRITO.indexOf('function syncPaymentAvailability');
  const fn = CARRITO.slice(start, start + 700);
  assert.match(fn, /cartValidationReady && !cartValidationFailed/, 'validación de stock pendiente/inválida');
  assert.match(fn, /getSellableItems\(cart\)\.length > 0/, 'carrito sin ítems pagables');
  assert.match(fn, /!validationRequest/, 'operación de envío/validación ya en curso');
});

test('1c. no se usa cursor:wait para representar una decisión pendiente del cliente', () => {
  assert.doesNotMatch(CARRITO, /cart-delivery-hint[^}]*cursor:\s*wait/s);
  const cssStart = CARRITO.indexOf('.cart-delivery-hint {');
  const cssBlock = CARRITO.slice(cssStart, CARRITO.indexOf('}', cssStart));
  assert.doesNotMatch(cssBlock, /cursor:\s*wait/);
});

test('2. al click sin entrega, requireDeliveryType() corta el flujo antes de cualquier await/fetch — Mercado Pago', () => {
  const handlerStart = CARRITO.indexOf("btnPrepare.addEventListener('click'");
  assert.notEqual(handlerStart, -1);
  const handlerBlock = CARRITO.slice(handlerStart, handlerStart + 3000);

  const guardIdx = handlerBlock.search(/if\s*\(\s*!deliveryType\s*\)\s*\{\s*\n\s*requireDeliveryType\(\);\s*\n\s*return;\s*\n\s*\}/);
  assert.notEqual(guardIdx, -1, 'no se encontró el corte temprano por falta de entrega');

  const firstAwaitIdx = handlerBlock.indexOf('await ');
  const firstOrdersFetchIdx = handlerBlock.indexOf("fetch('/api/orders'");
  const firstPrefsFetchIdx = handlerBlock.indexOf("fetch('/api/preferences'");

  assert.ok(firstAwaitIdx === -1 || guardIdx < firstAwaitIdx, 'requireDeliveryType debe ejecutarse antes de cualquier await');
  assert.ok(firstOrdersFetchIdx === -1 || guardIdx < firstOrdersFetchIdx, 'no debe llamarse /api/orders antes de elegir entrega');
  assert.ok(firstPrefsFetchIdx === -1 || guardIdx < firstPrefsFetchIdx, 'no debe llamarse /api/preferences antes de elegir entrega');
});

test('3. al click sin entrega, requireDeliveryType() corta el flujo antes de cualquier await/fetch — transferencia', () => {
  const fnStart = CARRITO.indexOf('async function createTransferOrder');
  assert.notEqual(fnStart, -1);
  const fnEnd = CARRITO.indexOf('async function getTurnstileTokenForOrder', fnStart);
  const fn = CARRITO.slice(fnStart, fnEnd);

  const guardIdx = fn.indexOf("if (!deliveryType) { requireDeliveryType(); return null; }");
  assert.notEqual(guardIdx, -1);

  const firstAwaitIdx = fn.indexOf('await ');
  const firstOrdersFetchIdx = fn.indexOf("fetch('/api/orders'");

  assert.ok(firstAwaitIdx === -1 || guardIdx < firstAwaitIdx, 'requireDeliveryType debe ejecutarse antes de cualquier await');
  assert.ok(firstOrdersFetchIdx === -1 || guardIdx < firstOrdersFetchIdx, 'no debe llamarse /api/orders antes de elegir entrega');
  assert.doesNotMatch(fn.slice(0, guardIdx), /fetchTransferOptions|transferIdempotencyKey =/, 'no debe pedirse ninguna cuenta antes de elegir entrega');
});

test('4. requireDeliveryType(): mensaje, foco y scroll a la opción de entrega', () => {
  const start = CARRITO.indexOf('function requireDeliveryType');
  const fn = CARRITO.slice(start, start + 700);
  assert.match(fn, /errEl\.textContent = 'Elegí envío o retiro para continuar\.'/);
  assert.match(fn, /errEl\.hidden = false/);
  assert.match(fn, /firstDelivery\.setAttribute\('aria-invalid', 'true'\)/);
  assert.match(fn, /firstDelivery\.focus\(\)/);
  assert.match(fn, /firstDelivery\.scrollIntoView/);
});

test('5. la ayuda visible junto a los CTA existe, es accesible y funciona en desktop y en la barra fija mobile', () => {
  assert.match(CARRITO, /id="cart-delivery-hint"[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden/);
  assert.match(CARRITO, /Elegí envío o retiro para continuar\./);
  // Vive dentro de .checkout-mobile-bar: en flujo normal (desktop) es un
  // <p> más en el flex; en mobile ese contenedor pasa a fixed+grid, así
  // que el mismo elemento se ve en ambos casos sin markup duplicado.
  const barStart = CARRITO.indexOf('class="checkout-mobile-bar"');
  const hintIdx = CARRITO.indexOf('id="cart-delivery-hint"');
  const transferBtnIdx = CARRITO.indexOf('id="btn-transfer-order"');
  assert.ok(barStart !== -1 && barStart < hintIdx && hintIdx < transferBtnIdx,
    'el aviso debe estar dentro de .checkout-mobile-bar, antes de los CTA de pago');
});

test('6. la ayuda no se confunde visualmente con un error real (rojo) ni con éxito (verde)', () => {
  const cssStart = CARRITO.indexOf('.cart-delivery-hint {');
  const cssBlock = CARRITO.slice(cssStart, CARRITO.indexOf('}', cssStart));
  assert.doesNotMatch(cssBlock, /#b42318|#fef2f2|#fecaca/, 'no debe reutilizar la paleta de error');
  assert.doesNotMatch(cssBlock, /#267a42/, 'no debe reutilizar la paleta de éxito de envío gratis');
});

// ── 2. Con retiro o envío elegidos, la ayuda desaparece y el CTA sigue la
//       disponibilidad técnica normal ──────────────────────────────────────

test('7. syncPaymentAvailability oculta la ayuda apenas hay entrega elegida', () => {
  const start = CARRITO.indexOf('function syncPaymentAvailability');
  const end = CARRITO.indexOf('\n    }', start);
  const fn = CARRITO.slice(start, end);
  assert.match(fn, /var hasDelivery = !!getDeliveryType\(\);/);
  assert.match(fn, /deliveryHintEl\.hidden = !\(technicallyReady && !hasDelivery\)/);
});

test('8. cambiar la entrega vuelve a evaluar disponibilidad (retiro y envío, no sólo un caso)', () => {
  const start = CARRITO.indexOf("radio.addEventListener('change', function () {");
  const listener = CARRITO.slice(start, start + 300);
  assert.match(listener, /updateTotals\(\)/);
  assert.match(listener, /syncPaymentAvailability\(\)/);
});

// ── 3. Mensaje de envío gratis ──────────────────────────────────────────────

test('9. #cart-shipping-msg existe en el markup y arranca hidden', () => {
  assert.match(CARRITO, /<p class="cart-shipping-msg" id="cart-shipping-msg" hidden><\/p>/);
});

test('10. carrito vacío / sin entrega: el mensaje de envío gratis queda oculto y sin texto', () => {
  const start = CARRITO.indexOf('function updateTotals');
  const branchEnd = CARRITO.indexOf('if (isPickup)', start);
  const branch = CARRITO.slice(start, branchEnd);
  assert.match(branch, /if \(!deliveryType \|\| subtotal <= 0\)/);
  assert.match(branch, /shippingMsgEl\.hidden = true; shippingMsgEl\.textContent = '';/);
});

test('11. retiro: el mensaje de envío gratis queda oculto y sin texto', () => {
  const start = CARRITO.indexOf('if (isPickup)');
  const end = CARRITO.indexOf('} else {', start);
  const branch = CARRITO.slice(start, end);
  assert.match(branch, /shippingMsgEl\.hidden = true; shippingMsgEl\.textContent = '';/);
});

test('12. envío: reusa exactamente shippingCost/subtotal/FREE_SHIPPING_THRESHOLD_UYU/fmt ya calculados, sin duplicar la lógica', () => {
  const start = CARRITO.indexOf('} else {', CARRITO.indexOf('if (isPickup)'));
  const end = CARRITO.indexOf('\n      }\n    }', start);
  const branch = CARRITO.slice(start, end);

  // El mismo shippingCost que ya decide la línea de costo de envío / total.
  assert.match(branch, /var shippingCost\s*=\s*subtotal < FREE_SHIPPING_THRESHOLD_UYU \? SHIPPING_COST : 0;/);
  assert.match(branch, /shippingMsgEl\.hidden = false;/);
  assert.match(branch, /shippingMsgEl\.textContent = shippingCost === 0/);
  assert.match(branch, /'Tu envío es gratis'/);
  assert.match(branch, /'Te faltan ' \+ fmt\.format\(FREE_SHIPPING_THRESHOLD_UYU - subtotal\) \+ ' para obtener envío gratis'/);

  // No aparece ningún otro umbral/constante hardcodeada dentro de esta rama.
  assert.doesNotMatch(branch, /1500|1\.500/);

  // fmt es el mismo formateador monetario que usa el resto del carrito (no
  // se declara un Intl.NumberFormat nuevo para este mensaje).
  const fmtDeclarations = CARRITO.match(/new Intl\.NumberFormat\('es-UY'/g) || [];
  assert.equal(fmtDeclarations.length, 1, 'debe existir un único formateador monetario, reusado en todo el carrito');
});

test('13. FREE_SHIPPING_THRESHOLD_UYU es la única fuente del umbral (no se hardcodea $1.500 en el nuevo mensaje)', () => {
  assert.match(CARRITO, /FREE_SHIPPING_THRESHOLD_UYU = 1500/);
  const msgIdx = CARRITO.indexOf("shippingMsgEl.textContent = shippingCost === 0");
  const msgBlock = CARRITO.slice(msgIdx, msgIdx + 250);
  assert.match(msgBlock, /FREE_SHIPPING_THRESHOLD_UYU/);
  assert.doesNotMatch(msgBlock, /\$\s*1[.,]?500/);
});

// ── 4. orders-guard.js no debe tapar el aviso de entrega en los CTA de pago ─

test('14. sin entrega elegida, orders-guard.js no intercepta el click de transferencia/Mercado Pago por nombre, teléfono o dirección', () => {
  const fnStart = GUARD.indexOf('function checkoutError');
  assert.notEqual(fnStart, -1);
  const fnBody = GUARD.slice(fnStart, GUARD.indexOf('\n  }', fnStart));

  const bypassIdx = fnBody.search(/if\s*\(\s*!delivery\s*&&\s*isPaymentButton\s*\)\s*return null;/);
  assert.notEqual(bypassIdx, -1, 'debe existir un corte temprano cuando no hay entrega y el botón es uno de pago');

  const nameCheckIdx = fnBody.indexOf("valueOf('buyer-name')");
  assert.ok(nameCheckIdx === -1 || bypassIdx < nameCheckIdx,
    'el corte por falta de entrega debe evaluarse antes que nombre/teléfono/dirección');

  assert.match(fnBody, /isPaymentButton = buttonId === 'btn-transfer-order' \|\| buttonId === 'btn-prepare-order'/);
});

test('15. el click handler global le pasa el id del botón a checkoutError()', () => {
  const idx = GUARD.indexOf("document.addEventListener('click'");
  const block = GUARD.slice(idx, idx + 400);
  assert.match(block, /checkoutError\(button\.id\)/);
});

test('16. el botón de WhatsApp no cambia: sigue pidiendo nombre y teléfono como hasta ahora', () => {
  const fnStart = GUARD.indexOf('function checkoutError');
  const fnBody = GUARD.slice(fnStart, GUARD.indexOf('\n  }', fnStart));
  // btn-wa-order nunca es "isPaymentButton" → nunca activa el bypass; sigue
  // cayendo en las mismas validaciones de nombre/teléfono/dirección.
  assert.doesNotMatch(fnBody, /buttonId === 'btn-wa-order'/);
});

test('17. con entrega ya elegida, orders-guard.js sigue validando nombre/teléfono/dirección exactamente como antes', () => {
  const fnStart = GUARD.indexOf('function checkoutError');
  const fnBody = GUARD.slice(fnStart, GUARD.indexOf('\n  }', fnStart));
  assert.match(fnBody, /if \(!valueOf\('buyer-name'\)\) return \{ message: 'Por favor ingresá tu nombre\.', field: 'buyer-name' \};/);
  assert.match(fnBody, /if \(!valueOf\('buyer-phone'\)\) return \{ message: 'Por favor ingresá tu teléfono o WhatsApp\.', field: 'buyer-phone' \};/);
  assert.match(fnBody, /if \(!delivery \|\| delivery\.value !== 'shipping'\) return null;/);
  assert.match(fnBody, /delivery-address.*Por favor ingresá la dirección de entrega/);
});

// ── 5. Ambos caminos de pago siguen protegidos contra doble envío ──────────

test('18. Mercado Pago: se deshabilita antes de cualquier await, con guarda explícita de reentrancia', () => {
  const handlerStart = CARRITO.indexOf("btnPrepare.addEventListener('click'");
  const handlerBlock = CARRITO.slice(handlerStart, handlerStart + 4000);
  const reentryGuard = CARRITO.slice(handlerStart, handlerStart + 300);
  assert.match(reentryGuard, /if\s*\(\s*btnPrepare\.disabled\s*\)\s*return;/);
  const disableIdx = handlerBlock.indexOf('btnPrepare.disabled = true;');
  const firstAwaitIdx = handlerBlock.indexOf('await ');
  assert.notEqual(disableIdx, -1);
  assert.ok(disableIdx < firstAwaitIdx);
});

test('19. Transferencia: se deshabilita antes de cualquier await, con guarda explícita de reentrancia', () => {
  const handlerStart = CARRITO.indexOf("btnTransfer.addEventListener('click'");
  assert.notEqual(handlerStart, -1);
  const reentryGuard = CARRITO.slice(handlerStart, handlerStart + 200);
  assert.match(reentryGuard, /if\s*\(\s*btnTransfer\.disabled\s*\|\|/);

  const fnStart = CARRITO.indexOf('async function createTransferOrder');
  const fnBlock = CARRITO.slice(fnStart, fnStart + 3000);
  const disableIdx = fnBlock.indexOf('btnTransfer.disabled = true;');
  const firstAwaitIdx = fnBlock.indexOf('await ');
  assert.notEqual(disableIdx, -1);
  assert.ok(disableIdx < firstAwaitIdx);
});

test('20. seguir deshabilitado (aria-busy) evita que syncPaymentAvailability lo reactive a mitad de una operación', () => {
  const start = CARRITO.indexOf('function syncPaymentAvailability');
  const fn = CARRITO.slice(start, start + 700);
  assert.match(fn, /!transferButton\.hasAttribute\('aria-busy'\)/);
  assert.match(fn, /!mercadoPagoButton\.hasAttribute\('aria-busy'\)/);
});
