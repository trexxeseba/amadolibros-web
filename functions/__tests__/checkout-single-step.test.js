// Pruebas de contrato del rediseño single-step del checkout (2-N-I1 v2).
//
// carrito.astro y pedido.astro son componentes Astro con script inline — no
// hay forma de importarlos como módulo ES y ejecutar su JS aislado con
// node --test. Siguiendo el mismo criterio ya establecido en
// wrangler-config.test.js (leer el archivo fuente como texto y verificar su
// estructura con regex), estos tests comprueban que el rediseño preserva las
// reglas de negocio obligatorias sin necesitar un navegador real.
//
// Ninguno de estos tests llama a /api/orders, /api/preferences, al servicio
// real de Turnstile ni a Mercado Pago — son puramente estructurales sobre el
// código fuente.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const carritoAstro = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'pages', 'carrito.astro'),
  'utf8',
);
const pedidoAstro = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'pages', 'pedido.astro'),
  'utf8',
);
const ordersGuardJs = readFileSync(
  path.join(ROOT, 'astro-front', 'public', 'orders-guard.js'),
  'utf8',
);

const REQUIRED_FIELD_IDS = [
  'buyer-name',
  'buyer-phone',
  'delivery-address',
  'delivery-barrio',
  'delivery-departamento',
  'delivery-date',
  'delivery-from',
  'delivery-to',
];

// ── Una sola pantalla, un solo botón principal ──────────────────────────────

test('carrito.astro: el checkout de dos pasos (order-result / btn-pay-mp) ya no existe', () => {
  assert.doesNotMatch(carritoAstro, /id="order-result"/);
  assert.doesNotMatch(carritoAstro, /id="btn-pay-mp"/);
  assert.doesNotMatch(carritoAstro, /getElementById\('btn-pay-mp'\)/);
});

test('carrito.astro: exactamente un botón principal id="btn-prepare-order" en el markup', () => {
  const matches = carritoAstro.match(/id="btn-prepare-order"/g) || [];
  assert.equal(matches.length, 1);
});

test('carrito.astro: el CTA principal dice "Continuar a Mercado Pago"', () => {
  assert.match(carritoAstro, /Continuar a Mercado Pago/);
});

test('carrito.astro: un solo listener de click maneja todo el pago (no hay un segundo botón/handler de "pagar")', () => {
  const clickListeners = carritoAstro.match(/btnPrepare\.addEventListener\('click'/g) || [];
  assert.equal(clickListeners.length, 1);
  assert.doesNotMatch(carritoAstro, /btnPayMp\.addEventListener/);
});

test('carrito.astro: el mismo click crea la orden y la preferencia, sin un segundo clic', () => {
  const handlerStart = carritoAstro.indexOf("btnPrepare.addEventListener('click'");
  assert.notEqual(handlerStart, -1);
  const handlerBlock = carritoAstro.slice(handlerStart, handlerStart + 6000);
  assert.match(handlerBlock, /fetch\('\/api\/orders'/);
  assert.match(handlerBlock, /fetch\('\/api\/preferences'/);
  // El orden importa: primero se crea/recupera la orden, después la preferencia.
  const ordersIdx = handlerBlock.indexOf("fetch('/api/orders'");
  const prefsIdx  = handlerBlock.indexOf("fetch('/api/preferences'");
  assert.ok(ordersIdx < prefsIdx, '/api/orders debe llamarse antes que /api/preferences');
});

// ── WhatsApp subordinado, no competidor ─────────────────────────────────────

test('carrito.astro: con checkout ON, WhatsApp usa estilo secundario (no compite con el CTA principal)', () => {
  assert.match(carritoAstro, /class="btn-wa-secondary"/);
});

test('carrito.astro: con checkout OFF, WhatsApp sigue siendo la única acción disponible', () => {
  assert.match(carritoAstro, /class="btn-wa-order"/);
});

// ── Validación inline y accesibilidad ───────────────────────────────────────

for (const fieldId of REQUIRED_FIELD_IDS) {
  test(`carrito.astro: el campo #${fieldId} tiene su span de error inline asociado`, () => {
    assert.match(carritoAstro, new RegExp(`id="err-${fieldId}"`));
    assert.match(carritoAstro, new RegExp(`id="${fieldId}"[^>]*aria-describedby="err-${fieldId}"`));
  });
}

test('carrito.astro: ya no usa alert() para errores de validación de campos', () => {
  const handlerStart = carritoAstro.indexOf("btnPrepare.addEventListener('click'");
  const handlerBlock = carritoAstro.slice(handlerStart, handlerStart + 3000);
  assert.doesNotMatch(handlerBlock, /alert\(\s*'Por favor/);
});

test('carrito.astro: showFieldError enfoca el campo y lo desplaza a la vista (scrollIntoView)', () => {
  assert.match(carritoAstro, /function showFieldError/);
  const fnStart = carritoAstro.indexOf('function showFieldError');
  const fnBody = carritoAstro.slice(fnStart, fnStart + 700);
  assert.match(fnBody, /scrollIntoView/);
  assert.match(fnBody, /\.focus\(\)/);
  assert.match(fnBody, /aria-invalid/);
});

test('carrito.astro: expone el hook de error inline en window para que orders-guard.js lo use', () => {
  assert.match(carritoAstro, /window\.__amadoCheckoutShowFieldError\s*=\s*showFieldError/);
});

test('orders-guard.js: usa el hook inline en vez de alert() como primera opción', () => {
  const idx = ordersGuardJs.indexOf("document.addEventListener('click'");
  assert.notEqual(idx, -1);
  const block = ordersGuardJs.slice(idx, idx + 900);
  assert.match(block, /window\.__amadoCheckoutShowFieldError/);
  // alert() se conserva solo como respaldo, no como camino principal.
  assert.match(block, /else\s*\{[\s\S]*window\.alert/);
});

// ── Prevención de doble envío / creación duplicada ──────────────────────────

test('carrito.astro: el botón se deshabilita antes de cualquier operación async', () => {
  const handlerStart = carritoAstro.indexOf("btnPrepare.addEventListener('click'");
  const handlerBlock = carritoAstro.slice(handlerStart, handlerStart + 4000);
  const disableIdx = handlerBlock.indexOf('btnPrepare.disabled = true;');
  const firstAwaitIdx = handlerBlock.indexOf('await ');
  assert.notEqual(disableIdx, -1, 'no se encontró "btnPrepare.disabled = true;"');
  assert.notEqual(firstAwaitIdx, -1, 'no se encontró ningún await en el handler');
  assert.ok(disableIdx < firstAwaitIdx, 'el botón debe deshabilitarse antes del primer await');
});

test('carrito.astro: guarda explícita de reentrancia al inicio del handler', () => {
  const handlerStart = carritoAstro.indexOf("btnPrepare.addEventListener('click'");
  const handlerBlock = carritoAstro.slice(handlerStart, handlerStart + 300);
  assert.match(handlerBlock, /if\s*\(\s*btnPrepare\.disabled\s*\)\s*return;/);
});

// ── Turnstile sigue protegiendo la creación del pago ────────────────────────

test('carrito.astro: turnstileBlocked sigue impidiendo el envío sin verificación', () => {
  assert.match(carritoAstro, /if\s*\(\s*turnstileBlocked\s*\)\s*\{/);
});

test('carrito.astro: cf_turnstile_response sigue viajando en el payload de /api/orders', () => {
  assert.match(carritoAstro, /cf_turnstile_response:\s*cfTsResponse/);
});

// ── Sin secretos ─────────────────────────────────────────────────────────

test('carrito.astro: no expone TURNSTILE_SECRET_KEY, MP_ACCESS_TOKEN ni MP_WEBHOOK_SECRET', () => {
  assert.doesNotMatch(carritoAstro, /TURNSTILE_SECRET_KEY/);
  assert.doesNotMatch(carritoAstro, /MP_ACCESS_TOKEN/);
  assert.doesNotMatch(carritoAstro, /MP_WEBHOOK_SECRET/);
});

// ── Barra inferior persistente (mobile) ─────────────────────────────────────

test('carrito.astro: la barra de pago usa position: fixed en mobile, condicionada a checkout ON', () => {
  assert.match(
    carritoAstro,
    /\.cart-page\[data-online-checkout="enabled"\]\s+\.checkout-mobile-bar\s*\{[^}]*position:\s*fixed/,
  );
});

test('carrito.astro: el total se refleja en la barra mobile (mismo valor que el resumen, sin recalcular)', () => {
  assert.match(carritoAstro, /id="checkout-sticky-total-value"/);
  assert.match(carritoAstro, /stickyTotalEl\.textContent\s*=\s*fmt\.format/);
});

test('carrito.astro: la barra mobile se oculta frente al teclado o el footer', () => {
  assert.match(carritoAstro, /window\.visualViewport\.height\s*<\s*window\.innerHeight\s*-\s*140/);
  assert.match(carritoAstro, /new IntersectionObserver/);
  assert.match(carritoAstro, /data-overlay-suppressed="true"/);
});

test('carrito.astro: el bubble flotante de WhatsApp no compite con la barra mobile', () => {
  assert.match(
    carritoAstro,
    /\.cart-page\[data-online-checkout="enabled"\]\s*~\s*:global\(\.wa-float\)\s*\{\s*display:\s*none;/,
  );
});

// ── Claridad retiro / envío ─────────────────────────────────────────────────

test('carrito.astro: los campos de envío ocultos no son forzados a display flex', () => {
  assert.match(carritoAstro, /\.shipping-fields\[hidden\]\s*\{\s*display:\s*none;/);
});

test('carrito.astro: retiro oculta y deshabilita todos los controles de envío', () => {
  const fnStart = carritoAstro.indexOf('function syncShippingFields');
  assert.notEqual(fnStart, -1);
  const fnBody = carritoAstro.slice(fnStart, fnStart + 1300);
  assert.match(fnBody, /shippingFieldsEl\.hidden\s*=\s*!shippingSelected/);
  assert.match(fnBody, /querySelectorAll\('input, select, textarea'\)/);
  assert.match(fnBody, /controls\[i\]\.disabled\s*=\s*!shippingSelected/);
  assert.match(carritoAstro, /syncShippingFields\(\);\s*\n\s*updateTotals\(\);/);
  const initialSync = carritoAstro.indexOf('syncShippingFields();', fnStart);
  const mobileBar = carritoAstro.indexOf('// ── Barra mobile', initialSync);
  assert.ok(initialSync > fnStart && mobileBar > initialSync,
    'los campos de envío deben sincronizarse antes de inicializar la barra mobile');
});

// ── Carrito conservado antes de pago aprobado (2-N-I1 v2) ───────────────────

test('carrito.astro: el flujo de pago nunca vacía el carrito (ni al hacer click, ni en ningún retorno)', () => {
  const handlerStart = carritoAstro.indexOf("btnPrepare.addEventListener('click'");
  const handlerEnd = carritoAstro.indexOf('renderCart();', handlerStart);
  const handlerBlock = carritoAstro.slice(handlerStart, handlerEnd);
  assert.doesNotMatch(handlerBlock, /AmadoCart\.clear\(\)/);
});

test('carrito.astro: AmadoCart.clear() solo se llama desde el botón manual "Vaciar carrito"', () => {
  const matches = [...carritoAstro.matchAll(/AmadoCart\.clear\(\)/g)];
  assert.equal(matches.length, 1);
  const idx = matches[0].index;
  const before = carritoAstro.slice(Math.max(0, idx - 400), idx);
  assert.match(before, /btnClear\.addEventListener\('click'/);
});

test('pedido.astro: el carrito se vacía únicamente en la rama de pago aprobado', () => {
  const fnStart = pedidoAstro.indexOf('function applyFinalState');
  assert.notEqual(fnStart, -1);
  const fnEnd = pedidoAstro.indexOf('\n      }\n\n      function onTimeout', fnStart);
  const fnBody = pedidoAstro.slice(fnStart, fnEnd === -1 ? fnStart + 1500 : fnEnd);

  const branches = {
    approved:  fnBody.slice(fnBody.indexOf("'approved'"), fnBody.indexOf("'rejected'") > -1 ? fnBody.indexOf("} else if (paymentStatus === 'rejected'") : undefined),
  };
  assert.match(branches.approved, /AmadoCart\.clear\(\)/);

  // Fuera de la rama approved (rejected/cancelled/refunded), nunca se limpia.
  const rejectedOnward = fnBody.slice(fnBody.indexOf("paymentStatus === 'rejected'"));
  assert.doesNotMatch(rejectedOnward, /AmadoCart\.clear\(\)/);
});

test('pedido.astro: el regreso del navegador (?result=) nunca por sí solo dispara el vaciado', () => {
  // El bloque que reacciona a ?result= al cargar la página (antes del
  // polling) es puramente informativo ("Estamos verificando…") y no debe
  // contener ninguna limpieza de carrito — solo applyFinalState(), llamado
  // exclusivamente desde el resultado real del polling a /api/orders/status,
  // puede hacerlo.
  const urlBlockStart = pedidoAstro.indexOf("if (result === 'success' || result === 'pending')");
  const urlBlockEnd   = pedidoAstro.indexOf('// ── Polling de estado real en D1');
  assert.notEqual(urlBlockStart, -1);
  assert.notEqual(urlBlockEnd, -1);
  const urlBlock = pedidoAstro.slice(urlBlockStart, urlBlockEnd);
  assert.doesNotMatch(urlBlock, /AmadoCart\.clear\(\)/);
});

test('pedido.astro: el vaciado depende del estado real leído de D1, no del parámetro de URL', () => {
  assert.match(pedidoAstro, /fetch\('\/api\/orders\/status'/);
  const pollIdx = pedidoAstro.indexOf("fetch('/api/orders/status'");
  assert.ok(pollIdx > 0);
});
