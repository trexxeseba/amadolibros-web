// V1.1 — REDISEÑO PROFUNDO DEL CHECKOUT.
//
// Cubre lo que el lote anterior (v1.1-checkout-guidance.test.js) no tocaba:
// layout de 2 columnas, selector de medio de pago + CTA único, preview
// "Pagás $X" de transferencia (con paridad real contra el backend, no sólo
// regex), el disclosure del resumen, y los ajustes de copy aprobados.
//
// Mismo criterio que el resto de la suite para lo estructural: sin DOM real,
// se lee el archivo fuente y se verifica con regex/índices. Para la paridad
// del preview de transferencia SÍ se ejecuta la lógica real (importando
// calculateTransferTotals del backend) contra la misma fórmula que declara
// el archivo fuente — no basta con que el texto "se parezca".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { calculateTotals, calculateTransferTotals, qualifiesForPickupDiscount } from '../api/_orders_logic.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CARRITO = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'pages', 'carrito.astro'),
  'utf8',
);

// ── 1. Cabecera ──────────────────────────────────────────────────────────

test('1. título "Finalizar compra" y línea comercial visibles desde el primer viewport (checkout ON)', () => {
  assert.match(CARRITO, /<h1 class="cart-h1">Finalizar compra<\/h1>/);
  assert.match(CARRITO, /class="cart-commercial-line">Transferencia 12% menos · Mercado Pago hasta 12 cuotas</);
  // La línea comercial es condicional a checkoutEnabled, igual que el resto
  // de la UI de pago — no debe aparecer incondicionalmente.
  const idx = CARRITO.indexOf('cart-commercial-line');
  const before = CARRITO.slice(Math.max(0, idx - 200), idx);
  assert.match(before, /\{checkoutEnabled && \(/);
});

test('2. "Seguir comprando" sigue siendo un enlace secundario, no protagonista', () => {
  assert.match(CARRITO, /id="btn-back-to-shopping" class="btn-context-back"/);
});

// ── 2. Layout de 2 columnas ──────────────────────────────────────────────

test('3. grid de 2 columnas sólo a partir de ~960px; mobile es una sola columna por defecto', () => {
  const baseStart = CARRITO.indexOf('.checkout-layout {');
  const baseBlock = CARRITO.slice(baseStart, CARRITO.indexOf('}', baseStart));
  assert.match(baseBlock, /display:\s*flex/, 'por defecto (mobile) es flex de una columna, no grid');

  const mqStart = CARRITO.indexOf('@media (min-width: 960px)', baseStart);
  assert.notEqual(mqStart, -1);
  const mqBlock = CARRITO.slice(mqStart, mqStart + 600);
  assert.match(mqBlock, /grid-template-columns:\s*60fr 38fr/);
  assert.match(mqBlock, /\.checkout-left\s*\{[^}]*grid-column:\s*1/);
  assert.match(mqBlock, /\.checkout-summary\s*\{[^}]*grid-column:\s*2/);
  assert.match(mqBlock, /position:\s*sticky/);
});

test('4. el resumen va primero en el DOM (orden natural mobile) y sólo por CSS pasa a la derecha en desktop', () => {
  const summaryIdx = CARRITO.indexOf('class="checkout-summary"');
  const leftIdx = CARRITO.indexOf('class="checkout-left"');
  assert.notEqual(summaryIdx, -1);
  assert.notEqual(leftIdx, -1);
  assert.ok(summaryIdx < leftIdx, 'en el DOM, el resumen debe preceder a Entrega/Datos/Pago (orden mobile)');
});

test('5. no se tocó el breakpoint mobile existente (640px) de la barra sticky', () => {
  assert.match(CARRITO, /@media \(max-width: 640px\)/);
  const mqIdx = CARRITO.indexOf('@media (max-width: 640px)');
  const mqBlock = CARRITO.slice(mqIdx, mqIdx + 1600);
  assert.match(mqBlock, /position:\s*fixed/);
});

// ── 3. Selector de medio de pago ─────────────────────────────────────────

test('6. "¿Cómo querés pagar?" con dos radios reales, sin preselección', () => {
  assert.match(CARRITO, /¿Cómo querés pagar\?/);
  const sectionStart = CARRITO.indexOf('class="payment-method-section');
  const sectionEnd = CARRITO.indexOf('</div>', CARRITO.indexOf('err-payment-method', sectionStart));
  const section = CARRITO.slice(sectionStart, sectionEnd);
  const radios = section.match(/<input type="radio" name="payment-method"[^>]*>/g) || [];
  assert.equal(radios.length, 2);
  for (const radio of radios) assert.doesNotMatch(radio, /\schecked(?:\s|>)/);
  assert.match(section, /value="transfer"/);
  assert.match(section, /value="mercadopago"/);
});

test('7. transferencia aparece primero (prioridad comercial) y con badge "12% menos"', () => {
  const transferIdx = CARRITO.indexOf('value="transfer"');
  const mpIdx = CARRITO.indexOf('value="mercadopago"');
  assert.ok(transferIdx < mpIdx, 'transferencia debe listarse antes que Mercado Pago');
  const badgeWindow = CARRITO.slice(transferIdx, mpIdx);
  assert.match(badgeWindow, /class="payment-opt-badge">12% menos</);
});

test('8. Mercado Pago muestra "Tarjetas, débito y hasta 12 cuotas"', () => {
  const mpIdx = CARRITO.indexOf('value="mercadopago"');
  const window_ = CARRITO.slice(mpIdx, mpIdx + 400);
  assert.match(window_, /Tarjetas, débito y hasta 12 cuotas/);
});

test('9. requirePaymentMethod(): mismo patrón que requireDeliveryType() — mensaje, foco y scroll', () => {
  const start = CARRITO.indexOf('function requirePaymentMethod');
  assert.notEqual(start, -1);
  const fn = CARRITO.slice(start, start + 700);
  assert.match(fn, /errEl\.textContent = 'Elegí cómo querés pagar\.'/);
  assert.match(fn, /errEl\.hidden = false/);
  assert.match(fn, /firstMethod\.setAttribute\('aria-invalid', 'true'\)/);
  assert.match(fn, /firstMethod\.focus\(\)/);
  assert.match(fn, /firstMethod\.scrollIntoView/);
});

// ── 4. CTA único — reutiliza los handlers existentes sin fusionarlos ────

test('10. sólo un CTA visible a la vez: neutro, transferencia o Mercado Pago según el medio elegido', () => {
  // Los tres botones arrancan hidden en el markup — la visibilidad la
  // decide syncPaymentAvailability() en tiempo de ejecución, nunca los tres
  // a la vez.
  assert.match(CARRITO, /id="btn-confirm-neutral" class="btn-checkout-primary">/);
  assert.match(CARRITO, /id="btn-transfer-order" class="btn-transfer-primary" aria-describedby="checkout-error" hidden>/);
  assert.match(CARRITO, /id="btn-prepare-order" class="btn-checkout-primary" aria-describedby="checkout-error" hidden>/);

  const start = CARRITO.indexOf('function syncPaymentAvailability');
  const fn = CARRITO.slice(start, start + 1400);
  assert.match(fn, /transferButton\.hidden = paymentMethod !== 'transfer'/);
  assert.match(fn, /mercadoPagoButton\.hidden = paymentMethod !== 'mercadopago'/);
  assert.match(fn, /neutralButton\.hidden = hasPaymentMethod/);
});

test('11. el CTA neutro no fusiona la lógica de pago: sólo exige entrega y medio, nunca llama a /api/orders', () => {
  const start = CARRITO.indexOf("btnConfirmNeutral.addEventListener('click'");
  assert.notEqual(start, -1);
  const block = CARRITO.slice(start, start + 400);
  assert.match(block, /if \(btnConfirmNeutral\.disabled\) return;/);
  assert.match(block, /if \(!requireDeliveryType\(\)\) return;/);
  assert.match(block, /requirePaymentMethod\(\);/);
  assert.doesNotMatch(block, /fetch\(/);
});

test('12. createTransferOrder() y el handler de Mercado Pago no cambiaron: cero referencias a payment-method', () => {
  const transferStart = CARRITO.indexOf('async function createTransferOrder');
  const transferEnd = CARRITO.indexOf('if (btnTransfer) {', transferStart);
  assert.doesNotMatch(CARRITO.slice(transferStart, transferEnd), /payment-method|getPaymentMethod|requirePaymentMethod/);

  const prepareStart = CARRITO.indexOf("btnPrepare.addEventListener('click'");
  const prepareEnd = CARRITO.indexOf('refreshCartAvailability({ initial: true })', prepareStart);
  assert.doesNotMatch(CARRITO.slice(prepareStart, prepareEnd), /payment-method|getPaymentMethod|requirePaymentMethod/);
});

test('13. elegir medio de pago recalcula disponibilidad y guarda el borrador', () => {
  const start = CARRITO.indexOf("var paymentMethodRadios = document.querySelectorAll('input[name=\"payment-method\"]');");
  assert.notEqual(start, -1);
  const block = CARRITO.slice(start, start + 400);
  assert.match(block, /clearPaymentMethodError\(\)/);
  assert.match(block, /updateTotals\(\)/);
  assert.match(block, /syncPaymentAvailability\(\)/);
  assert.match(block, /saveDraft\(\)/);
});

test('14. el medio de pago se persiste y restaura en el borrador de sessionStorage', () => {
  assert.match(CARRITO, /payment_method: getPaymentMethod\(\)/);
  assert.match(CARRITO, /draft\.payment_method/);
});

// ── 5. Preview "Pagás $X" de transferencia — paridad real ────────────────

test('15. la fórmula del preview es un espejo textual exacto de calculateTransferTotals() (mismo factor, mismo redondeo)', () => {
  assert.match(CARRITO, /var TRANSFER_FACTOR\s*=\s*0\.88;/);
  const matches = CARRITO.match(/Math\.round\(subtotal \* TRANSFER_FACTOR\)/g) || [];
  assert.equal(matches.length, 2, 'debe aparecer una vez en la rama de retiro y otra en la de envío');
});

test('16. paridad NUMÉRICA real contra calculateTransferTotals() del backend, en 12 combinaciones', () => {
  const RETIRO_DISCOUNT = 150;
  const SHIPPING_COST = 250;
  const FREE_SHIPPING_THRESHOLD_UYU = 1500;

  // Reimplementa EXACTAMENTE lo que ejecuta el navegador (mismas líneas que
  // updateTotals() en carrito.astro), no una aproximación.
  function clientPreview(subtotal, deliveryType) {
    const isPickup = deliveryType === 'pickup';
    const pickupEligible = qualifiesForPickupDiscount(subtotal);
    const pickupDiscount = isPickup && pickupEligible ? RETIRO_DISCOUNT : 0;
    const shippingCost = !isPickup && subtotal < FREE_SHIPPING_THRESHOLD_UYU ? SHIPPING_COST : 0;
    const transferProductsTotal = Math.round(subtotal * 0.88);
    const transferPayable = isPickup
      ? Math.max(0, transferProductsTotal - pickupDiscount)
      : Math.max(0, transferProductsTotal + shippingCost);
    return transferPayable;
  }

  const cases = [
    [2000, 'pickup'], [1000, 'shipping'], [1299, 'pickup'], [1300, 'pickup'],
    [1301, 'pickup'], [1499, 'shipping'], [1500, 'shipping'], [1501, 'shipping'],
    [3, 'pickup'], [645, 'pickup'], [999, 'shipping'], [1200, 'shipping'],
  ];

  for (const [subtotal, deliveryType] of cases) {
    const totals = calculateTotals([{ line_total_uyu: subtotal }], deliveryType);
    const server = calculateTransferTotals(totals);
    const client = clientPreview(subtotal, deliveryType);
    assert.equal(
      client, server.transferPayableTotal,
      `subtotal=${subtotal} ${deliveryType}: cliente=${client} servidor=${server.transferPayableTotal}`,
    );
  }
});

test('17. la línea de Mercado Pago reusa el mismo total ya mostrado (sin cálculo propio)', () => {
  const pickupBranch = CARRITO.slice(CARRITO.indexOf('if (isPickup) {'), CARRITO.indexOf('} else {'));
  assert.match(pickupBranch, /mpPreviewEl\.textContent = 'Pagás ' \+ fmt\.format\(total\)/);
});

test('18. sin entrega elegida (o carrito vacío) el preview de transferencia queda oculto, nunca en $0 engañoso', () => {
  const start = CARRITO.indexOf('if (!deliveryType || subtotal <= 0) {');
  const block = CARRITO.slice(start, CARRITO.indexOf('return;', start));
  assert.match(block, /transferPreviewEl\.hidden = true; transferPreviewEl\.textContent = '';/);
  assert.match(block, /mpPreviewEl\.\s*\{ mpPreviewEl\.hidden = true; mpPreviewEl\.textContent = ''; \}|mpPreviewEl\.hidden = true;/);
});

// ── 6. Resumen / disclosure / "Editar" ───────────────────────────────────

test('19. el resumen usa <details> nativo y accesible, no un modal', () => {
  assert.match(CARRITO, /<details id="cart-summary-panel" class="cart-summary-panel">/);
  assert.match(CARRITO, /<summary class="cart-summary-toggle">/);
  assert.doesNotMatch(CARRITO, /class="modal"|role="dialog"/);
});

test('20. desktop fuerza el resumen siempre expandido vía CSS, sin depender del atributo open', () => {
  assert.match(CARRITO, /\.cart-summary-panel:not\(\[open\]\) \.cart-summary-body\s*\{\s*display:\s*flex;/);
  // Esa regla vive dentro de un @media (min-width: 960px) cercano, no aplica en mobile.
  const ruleIdx = CARRITO.indexOf('.cart-summary-panel:not([open]) .cart-summary-body');
  const precedingMq = CARRITO.lastIndexOf('@media (min-width: 960px)', ruleIdx);
  assert.ok(precedingMq !== -1 && ruleIdx - precedingMq < 300, 'la regla debe estar dentro del bloque @media, no suelta');
});

test('20b. el override de desktop también alcanza ::details-content (no sólo el hijo)', () => {
  // Regresión real encontrada con Playwright: Chromium colapsa el contenido
  // de un <details> cerrado con un pseudo-elemento interno
  // (::details-content), no sólo con display en los hijos. Sin este
  // segundo override el panel medía 0 de alto en desktop aunque
  // .cart-summary-body ya tuviera display:flex — "Editar" quedaba
  // inalcanzable por completo en 1440×900.
  assert.match(CARRITO, /\.cart-summary-panel:not\(\[open\]\)::details-content\s*\{\s*\n\s*content-visibility:\s*visible;\s*\n\s*display:\s*block;/);
});

test('21. "Editar" reutiliza buildItemRow() sin reescribirla — sólo agrega una fila compacta nueva y separada', () => {
  assert.match(CARRITO, /function buildItemRow\(item, validation\) \{/);
  assert.match(CARRITO, /function buildCompactItemRow\(item, validation\) \{/);
  // buildItemRow sigue siendo llamada exactamente igual que antes de V1.1.
  assert.match(CARRITO, /itemsList\.appendChild\(buildItemRow\(cart\.items\[i\], validationFor\(cart\.items\[i\]\)\)\);/);
});

test('22. la lista completa arranca oculta (hidden) hasta tocar "Editar"; el toggle no borra nada, sólo alterna visibilidad', () => {
  assert.match(CARRITO, /id="cart-items" role="list" aria-label="Artículos en el carrito" class="cart-items-full" hidden>/);
  const start = CARRITO.indexOf('if (btnToggleEditor) {');
  const block = CARRITO.slice(start, start + 400);
  assert.match(block, /itemsList\.hidden = expanded/);
  assert.match(block, /itemsCompactList\.hidden = !expanded/);
  assert.doesNotMatch(block, /\.remove\(\)|innerHTML\s*=\s*''/);
});

test('23. "Vaciar carrito" ya no es el primer control de la página — vive dentro de la tarjeta de totales', () => {
  const clearIdx = CARRITO.indexOf('id="btn-clear"');
  const totalsCardIdx = CARRITO.indexOf('class="cart-totals-card"');
  const entregaIdx = CARRITO.indexOf('¿Cómo querés recibir tu pedido?');
  assert.ok(totalsCardIdx !== -1 && totalsCardIdx < clearIdx, 'btn-clear debe estar dentro de cart-totals-card');
  assert.ok(clearIdx < entregaIdx, 'sigue viviendo en el resumen, no mezclado con el formulario de Entrega');
});

// ── 7. Copy aprobado: Entrega, sin promesas de ETA ───────────────────────

test('24. copy de Entrega es el aprobado — sin "hoy"/"mañana"/fecha estimada', () => {
  assert.match(CARRITO, /Retiro en Ciudad Vieja/);
  assert.match(CARRITO, /Entregas de lunes a viernes · coordinamos día y franja contigo/);
  assert.match(CARRITO, /class="delivery-opt-badge">Gratis desde \$1\.500</);

  const entregaStart = CARRITO.indexOf('¿Cómo querés recibir tu pedido?');
  const entregaEnd = CARRITO.indexOf('</section>', entregaStart);
  const entregaBlock = CARRITO.slice(entregaStart, entregaEnd);
  assert.doesNotMatch(entregaBlock, /\bhoy\b/i, 'no debe prometer "disponible/retiro/entrega hoy"');
  assert.doesNotMatch(entregaBlock, /\bmañana\b/i, 'no debe prometer "entrega/llega mañana"');
});

test('25. el horario de retiro sigue siendo exactamente el copy canónico de PICKUP.hours', () => {
  assert.match(CARRITO, /Lunes a viernes, de 8 a 17 h/);
});

// ── 8. "Tus datos": campos comunes, microcopy de WhatsApp, Barrio obligatorio ─

test('26. Nombre, WhatsApp y Email siguen siendo el mínimo común, los tres marcados como obligatorios', () => {
  const start = CARRITO.indexOf('<h2 class="cart-section-h2">Tus datos</h2>');
  const end = CARRITO.indexOf('</section>', start);
  const block = CARRITO.slice(start, end);
  assert.match(block, /for="buyer-name" class="form-label">Nombre <span class="form-req"/);
  assert.match(block, /for="buyer-phone" class="form-label">WhatsApp \/ Teléfono <span class="form-req"/);
  assert.match(block, /for="buyer-email" class="form-label">Correo electrónico <span class="form-req"/);
});

test('27. microcopy debajo de WhatsApp explica para qué se usa el dato', () => {
  assert.match(CARRITO, /id="buyer-phone-help">Lo usamos únicamente para coordinar tu pedido y la entrega\.</);
  assert.match(CARRITO, /aria-describedby="buyer-phone-help err-buyer-phone"/);
});

test('28. Barrio queda visualmente marcado como obligatorio (backend ya lo exige para envío)', () => {
  assert.match(CARRITO, /for="delivery-barrio" class="form-label">Barrio \/ Localidad <span class="form-req" aria-hidden="true">\*<\/span><\/label>/);
});

test('29. progressive disclosure de envío no cambió: sigue oculto con retiro, sin campos nuevos inventados', () => {
  const shippingFieldIds = (CARRITO.match(/id="delivery-(address|barrio|departamento|notes)"/g) || []).length;
  assert.equal(shippingFieldIds, 4, 'los mismos 4 campos de siempre, ninguno agregado ni quitado');
  assert.match(CARRITO, /id="shipping-fields" class="shipping-fields" hidden>/);
});

// ── 9. Microcopy de respaldo humano (texto final) ────────────────────────

test('30. el texto final aprobado reemplaza la versión anterior en #310', () => {
  assert.match(CARRITO, /y te ayudamos a completar la compra\./);
  assert.doesNotMatch(CARRITO, /Te atendemos personalmente\./);
  assert.doesNotMatch(CARRITO, /si algo no funciona como esperabas/i);
});
