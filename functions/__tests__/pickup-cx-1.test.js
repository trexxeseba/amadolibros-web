// PICKUP-CX-1 — nadie debe presentarse al punto de retiro antes de que el
// pedido esté pronto.
//
// Dos cosas se prueban acá: que el contenido público ya no publique la
// dirección exacta (quien la veía podía ir por su cuenta), y que la aceptación
// de esperar la confirmación se exija también en el servidor — el checkbox del
// checkout se saltea llamando la API directamente.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateBody, generateFingerprint, consolidateItems } from '../api/_orders_logic.js';
import { PICKUP, CONTACT } from '../_shared/brand.js';

const read = (rel) => readFileSync(fileURLToPath(new URL('../../' + rel, import.meta.url)), 'utf8');

const PUBLICOS = [
    'astro-front/src/components/Footer.astro',
    'astro-front/src/components/TrustStrip.astro',
    'astro-front/src/pages/carrito.astro',
    'astro-front/src/pages/envios.astro',
    'astro-front/src/pages/devoluciones.astro',
    'functions/_shared/brand.js',
    'functions/libro/[[path]].js',
    'functions/catalogo.js',
];

// ── 1. Dirección exacta fuera del contenido público ─────────────────────────

test('1. ningún archivo público publica la dirección exacta del retiro', () => {
    for (const rel of PUBLICOS) {
        assert.doesNotMatch(read(rel), /Rinc[óo]n\s*608/i,
            `${rel} todavía expone la dirección exacta`);
    }
});

test('2. /contacto conserva el domicilio comercial pero no como instrucción de retiro', () => {
    const c = read('astro-front/src/pages/contacto.astro');
    // El domicilio legal es una obligación distinta y se mantiene.
    assert.match(c, /Domicilio comercial:<\/strong> Rincón 608/);
    // Pero ya no se presenta como el lugar al que ir a retirar.
    assert.doesNotMatch(c, /Dirección y retiro/);
    assert.match(c, /Pick up:<\/strong> a pasos de Plaza Matriz/);
});

test('3. el horario público de retiro es único: 8 a 17 h', () => {
    for (const rel of [...PUBLICOS, 'astro-front/src/pages/contacto.astro']) {
        const src = read(rel);
        // 7:30 no debe seguir apareciendo como horario de retiro.
        const lineas = src.split('\n').filter(l => /7:30/.test(l));
        for (const l of lineas) {
            assert.doesNotMatch(l, /retir|pick ?up/i,
                `${rel} conserva 7:30 como horario de retiro: ${l.trim()}`);
        }
    }
    assert.equal(PICKUP.hours, 'Lunes a viernes, de 8 a 17 h');
});

test('4. el copy canónico es el aprobado', () => {
    assert.equal(PICKUP.name, 'Pick up a pasos de Plaza Matriz');
    assert.match(PICKUP.notice, /^Para evitar que vengas en vano, esperá nuestra confirmación por WhatsApp antes de venir\./);
    assert.match(PICKUP.checkbox, /^Entiendo que debo esperar la confirmación por WhatsApp antes de ir a retirar\.$/);
    assert.match(PICKUP.confirmation, /^Tu compra quedó confirmada y ya estamos preparando tu pedido\./);
    assert.match(PICKUP.internalNotice, /^PICK UP — ACCIÓN PENDIENTE/);
    // El footer usa el nombre nuevo, no el viejo.
    assert.equal(CONTACT.pickupLine, PICKUP.name);
});

// ── 2. Validación de servidor ───────────────────────────────────────────────

const itemsOk = [{ product_id: 'MLU1', quantity: 1 }];
const base = {
    idempotency_key: 'k'.repeat(20),
    items: itemsOk,
    buyer: { name: 'Ada Lovelace', phone: '099111222' },
    cf_turnstile_response: 'x',
};
const envio = {
    ...base,
    delivery_type: 'shipping',
    shipping: {
        address: 'Calle 1234', locality: 'Centro', department: 'Montevideo',
        requested_date: '2031-01-15', requested_from: '10:00', requested_to: '14:00',
    },
};

test('5. pickup sin aceptación es rechazado por el servidor', () => {
    const err = validateBody({ ...base, delivery_type: 'pickup' });
    assert.ok(err, 'debe devolver un error');
    assert.match(err, /aceptar esperar la confirmación por WhatsApp/);
});

test('6. pickup con pickup_ack distinto de true tampoco pasa', () => {
    for (const v of ['true', 1, 'on', {}, null]) {
        const err = validateBody({ ...base, delivery_type: 'pickup', pickup_ack: v });
        assert.ok(err, `pickup_ack=${JSON.stringify(v)} no debería alcanzar`);
    }
});

test('7. pickup con aceptación explícita pasa la validación', () => {
    assert.equal(validateBody({ ...base, delivery_type: 'pickup', pickup_ack: true }), null);
});

test('8. el envío a domicilio no exige la aceptación de retiro', () => {
    assert.equal(validateBody(envio), null);
});

test('9. la aceptación forma parte de la identidad del pedido', () => {
    const items = consolidateItems(itemsOk);
    const conAck = generateFingerprint({ ...base, delivery_type: 'pickup', pickup_ack: true }, items);
    const deEnvio = generateFingerprint(envio, items);
    assert.notEqual(conAck, deEnvio, 'retiro y envío no pueden compartir huella');
});

// ── 3. Checkout ─────────────────────────────────────────────────────────────

const CARRITO = read('astro-front/src/pages/carrito.astro');

test('10. el checkout muestra nombre, horario, aviso y checkbox', () => {
    assert.ok(CARRITO.includes(PICKUP.name), 'nombre del pick up');
    assert.ok(CARRITO.includes('Lunes a viernes, de 8 a 17 h'), 'horario');
    assert.match(CARRITO, /Para evitar que vengas en vano/, 'aviso destacado');
    assert.match(CARRITO, /id="pickup-ack"/, 'checkbox');
    assert.match(CARRITO, /Entiendo que debo esperar la confirmación por WhatsApp/);
});

test('11. el error va junto al checkbox, es anunciado y recibe el foco', () => {
    assert.match(CARRITO, /id="err-pickup-ack"[^>]*role="alert"/);
    assert.match(CARRITO, /aria-describedby="err-pickup-ack"/);
    assert.match(CARRITO, /pickupAck\.focus\(\)/);
    assert.match(CARRITO, /setAttribute\('aria-invalid', 'true'\)/);
});

test('12. cambiar a envío oculta el bloque y limpia la aceptación', () => {
    assert.match(CARRITO, /function syncPickupAck\(\)/);
    assert.match(CARRITO, /pickupAck\.checked = false/);
});

test('13. el checkout no continúa al pago sin aceptación', () => {
    assert.match(CARRITO, /deliveryType === 'pickup' && !isPickupAccepted\(\)/);
});

test('14. el acuse viaja al servidor', () => {
    assert.match(CARRITO, /payload\.pickup_ack = true/);
});

// ── 4. Post-compra y aviso interno ──────────────────────────────────────────

test('15. la confirmación de pickup usa el mensaje específico, no el genérico', () => {
    const pedido = read('astro-front/src/pages/pedido.astro');
    assert.ok(pedido.includes(PICKUP.confirmation), 'debe usar el copy aprobado');
    assert.match(pedido, /delivery_type === 'pickup'/);
    assert.doesNotMatch(pedido, /Rinc[óo]n\s*608/i, 'no debe revelar la dirección');
});

test('16. el aviso interno destaca PICK UP y la acción pendiente', () => {
    const n = read('functions/api/_sale_notification.js');
    assert.match(n, /Entrega: PICK UP/);
    assert.match(n, /PICK UP — ACCIÓN PENDIENTE/);
    assert.match(n, /avisar al cliente por WhatsApp/);
    // El checkout no pide email: no se puede afirmar que se le escribió.
    assert.doesNotMatch(n, /se envió un (correo|email) al (comprador|cliente)/i);
});
