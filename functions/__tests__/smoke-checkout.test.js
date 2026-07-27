// Tests de la verificación de estado del checkout que hace
// scripts/smoke-production.js sobre el HTML servido de /carrito/.
//
// Vive en functions/__tests__/ (y no en scripts/__tests__/) a propósito: CI ya
// ejecuta `node --test functions/__tests__/*.test.js`, así que estos tests
// corren sin tener que tocar .github/workflows/ci.yml, que está fuera del
// alcance de 2-N-H1. Es el mismo criterio con el que wrangler-config.test.js
// —que verifica wrangler.toml y deploy.yml— ya vive en esta carpeta.
//
// Todo se ejercita con fixtures en memoria: no hay red, no se toca Producción,
// no se envía ningún POST y no se llama a Mercado Pago ni a Turnstile.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeCartCheckoutState,
  resolveCheckoutExpectation,
  hasRenderedElementWithId,
  TURNSTILE_SITE_KEY_PRODUCTION,
  TURNSTILE_SITE_KEY_PREVIEW,
} from '../../scripts/smoke-production.js';

// Los fixtures replican la forma real del build de Astro, incluidos los
// atributos data-astro-cid-* y —clave para estos tests— las referencias
// INERTES dentro del <script>: el bloque JS menciona 'cf-ts-container',
// 'btn-prepare-order' y la URL de challenges.cloudflare.com incluso cuando el
// checkout está apagado y esos elementos nunca se renderizan.
const INERT_SCRIPT = `<script>var turnstileSiteKey = "${TURNSTILE_SITE_KEY_PRODUCTION}";
var turnstileAllowedHosts = ["amadolibros.com","www.amadolibros.com"];
var container = document.getElementById('cf-ts-container');
var btnPrepare = document.getElementById('btn-prepare-order');
var btnPayMp = document.getElementById('btn-pay-mp');
_tsScript.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__tsOnLoad&render=explicit';</script>`;

const WHATSAPP_BUTTON =
  '<button type="button" id="btn-wa-order" class="btn-wa-order" data-astro-cid-ymxsigk2>Enviar pedido por WhatsApp</button>';

function cartHtml({ enabled }) {
  const payControls = enabled
    ? '<div id="cf-ts-container" data-astro-cid-ymxsigk2></div>' +
      '<button type="button" id="btn-prepare-order" class="btn-prepare-order" data-astro-cid-ymxsigk2>Preparar pago online</button>'
    : '';
  return (
    '<!DOCTYPE html><html><body>' +
    `<main class="cart-page" data-online-checkout="${enabled ? 'enabled' : 'disabled'}" data-astro-cid-ymxsigk2>` +
    '<section class="cart-pay-section" data-astro-cid-ymxsigk2>' +
    payControls +
    WHATSAPP_BUTTON +
    '</section></main>' +
    INERT_SCRIPT +
    '</body></html>'
  );
}

const HTML_ENABLED  = cartHtml({ enabled: true });
const HTML_DISABLED = cartHtml({ enabled: false });

// ── Matriz principal: el smoke distingue los cuatro cruces ───────────────────

test('smoke-1: HTML disabled pasa con expectativa disabled', () => {
  const r = analyzeCartCheckoutState(HTML_DISABLED, 'disabled');
  assert.equal(r.ok, true, r.reason);
});

test('smoke-2: HTML disabled FALLA con expectativa enabled', () => {
  const r = analyzeCartCheckoutState(HTML_DISABLED, 'enabled');
  assert.equal(r.ok, false);
  assert.match(r.reason, /data-online-checkout="enabled"/);
});

test('smoke-3: HTML enabled pasa con expectativa enabled', () => {
  const r = analyzeCartCheckoutState(HTML_ENABLED, 'enabled');
  assert.equal(r.ok, true, r.reason);
});

test('smoke-4: HTML enabled FALLA con expectativa disabled', () => {
  const r = analyzeCartCheckoutState(HTML_ENABLED, 'disabled');
  assert.equal(r.ok, false);
  assert.match(r.reason, /data-online-checkout="disabled"/);
});

// ── La trampa de la cadena inerte ────────────────────────────────────────────

test('smoke-5: una URL de Turnstile presente solo como string inerte no cuenta como evidencia', () => {
  // El fixture apagado contiene la URL de challenges.cloudflare.com y las
  // referencias a los ids dentro del <script>, pero ningún elemento real.
  assert.ok(HTML_DISABLED.includes('challenges.cloudflare.com'));
  assert.ok(HTML_DISABLED.includes("getElementById('cf-ts-container')"));
  assert.ok(HTML_DISABLED.includes("getElementById('btn-prepare-order')"));
  // Aun así se considera correctamente apagado.
  assert.equal(analyzeCartCheckoutState(HTML_DISABLED, 'disabled').ok, true);
  // Y jamás alcanza para darlo por encendido.
  assert.equal(analyzeCartCheckoutState(HTML_DISABLED, 'enabled').ok, false);
});

test('smoke-6: hasRenderedElementWithId separa la etiqueta real de la cadena en JS', () => {
  assert.equal(hasRenderedElementWithId("<div id=\"cf-ts-container\"></div>", 'cf-ts-container'), true);
  assert.equal(hasRenderedElementWithId("<div id='cf-ts-container'></div>", 'cf-ts-container'), true);
  assert.equal(
    hasRenderedElementWithId('<button type="button" id="btn-prepare-order">x</button>', 'btn-prepare-order'),
    true,
  );
  assert.equal(hasRenderedElementWithId("getElementById('cf-ts-container')", 'cf-ts-container'), false);
  assert.equal(hasRenderedElementWithId('<script>var x = "cf-ts-container";</script>', 'cf-ts-container'), false);
});

// ── Controles válidos en ambos estados ───────────────────────────────────────

test('smoke-7: la Site key de Preview en Producción falla en ambos estados', () => {
  for (const [html, expectation] of [[HTML_ENABLED, 'enabled'], [HTML_DISABLED, 'disabled']]) {
    const contaminated = html.replace(TURNSTILE_SITE_KEY_PRODUCTION, TURNSTILE_SITE_KEY_PREVIEW);
    const r = analyzeCartCheckoutState(contaminated, expectation);
    assert.equal(r.ok, false, `esperaba fallo con la key de Preview (${expectation})`);
    assert.match(r.reason, /Preview/);
  }
});

test('smoke-8: un marcador de secreto falla y el motivo nunca incluye el valor', () => {
  // Construido en runtime (nunca escrito literal) para que un secret scanner
  // no lo confunda con una credencial real filtrada en el repo.
  const fakeSecretMarker = 'APP_' + 'USR-' + '1234567890-abcdef';
  const leaked = HTML_ENABLED.replace('</body>', `<!-- ${fakeSecretMarker} --></body>`);
  const r = analyzeCartCheckoutState(leaked, 'enabled');
  assert.equal(r.ok, false);
  assert.match(r.reason, /posible secreto expuesto/);
  assert.equal(r.reason.includes('1234567890'), false);
  assert.equal(r.reason.includes('abcdef'), false);
});

test('smoke-9: si desaparece el cierre por WhatsApp falla en ambos estados', () => {
  for (const [html, expectation] of [[HTML_ENABLED, 'enabled'], [HTML_DISABLED, 'disabled']]) {
    const r = analyzeCartCheckoutState(html.replace(WHATSAPP_BUTTON, ''), expectation);
    assert.equal(r.ok, false);
    assert.match(r.reason, /WhatsApp/);
  }
});

test('smoke-10: falta la Site key Production con el checkout encendido → falla', () => {
  const r = analyzeCartCheckoutState(HTML_ENABLED.replace(TURNSTILE_SITE_KEY_PRODUCTION, ''), 'enabled');
  assert.equal(r.ok, false);
  assert.match(r.reason, /Site key de Turnstile Production/);
});

test('smoke-11: body vacío falla', () => {
  assert.equal(analyzeCartCheckoutState('', 'enabled').ok, false);
  assert.equal(analyzeCartCheckoutState('   ', 'disabled').ok, false);
});

// ── Validación de SMOKE_EXPECT_CHECKOUT ──────────────────────────────────────

test('smoke-12: SMOKE_EXPECT_CHECKOUT solo acepta "enabled" o "disabled"', () => {
  assert.deepEqual(resolveCheckoutExpectation('enabled'), { ok: true, value: 'enabled' });
  assert.deepEqual(resolveCheckoutExpectation('disabled'), { ok: true, value: 'disabled' });
  assert.deepEqual(resolveCheckoutExpectation('  enabled  '), { ok: true, value: 'enabled' });

  for (const invalid of [undefined, '', 'true', 'false', 'ENABLED', 'on', 'sí', null, 1]) {
    const r = resolveCheckoutExpectation(invalid);
    assert.equal(r.ok, false, `esperaba rechazo para ${JSON.stringify(invalid)}`);
    assert.match(r.reason, /SMOKE_EXPECT_CHECKOUT/);
  }
});

test('smoke-13: una expectativa inválida nunca aprueba un HTML', () => {
  for (const invalid of ['', 'true', 'ENABLED']) {
    assert.equal(analyzeCartCheckoutState(HTML_ENABLED, invalid).ok, false);
    assert.equal(analyzeCartCheckoutState(HTML_DISABLED, invalid).ok, false);
  }
});
