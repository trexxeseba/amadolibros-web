// AL-WEB: jerarquía de precios y orden de acciones en la ficha individual
// (functions/libro/[[path]].js). Cubre las dos correcciones comerciales:
// 1. Transferencia como mejor precio, seguida por tarjeta y cuotas en
//    un bloque propio igualmente visible.
// 2. Agregar al carrito → WhatsApp → Mercado Libre, con Mercado Libre
//    visualmente subordinado (sin el relleno amarillo dominante que tenía).
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from '../libro/[[path]].js';

function book(overrides = {}) {
    return {
        id: 'MLU1', title: 'Un Libro De Prueba', author: 'Autor De Prueba',
        price: 1200, status: 'active', available_quantity: 3,
        condition: 'new', isbn: '9788499809991', publisher: null,
        pages: null, dimensions: null,
        thumbnail: 'http://http2.mlstatic.com/D_1-I.jpg', pictures: [],
        permalink: 'https://articulo.mercadolibre.com.uy/MLU-1-un-libro',
        ...overrides,
    };
}

function indexOfAll(html, needles) {
    return needles.map(n => html.indexOf(n));
}

// El documento completo trae el <head> antes que el <body> — el meta
// description menciona "Transferencia" como gancho de SEO, y el <style>
// define .btn-wa/.btn-ml antes de que el <body> los use. Las comparaciones
// de orden deben mirar solo el bloque real del <body> donde se renderizan
// los CTA/precio, no el documento entero.
function extractBlock(html, className) {
    const match = html.match(new RegExp(`<div class="${className}">[\\s\\S]*?\\n    </div>`));
    if (!match) throw new Error(`Bloque .${className} no encontrado en el HTML`);
    return match[0];
}

test('1. Transferencia aparece primero con ahorro concreto y tarjeta visible en bloque propio', () => {
    const html = renderPage(book({ price: 1200 }), 'un-libro-de-prueba', false, '');
    assert.match(html, /Mejor precio · Transferencia/);
    assert.match(html, /\$1\.056 UYU/); // 1200 * 0.88 = 1056
    assert.match(html, /12% menos · Ahorrás \$144/);
    assert.match(html, /Con tarjeta: \$1\.200 UYU/);
    const priceBox = extractBlock(html, 'price-box');
    const transferIdx = priceBox.indexOf('Mejor precio · Transferencia');
    const cardIdx = priceBox.indexOf('Con tarjeta:');
    assert.ok(transferIdx > -1 && cardIdx > -1);
    assert.ok(transferIdx < cardIdx, 'el mejor precio debe aparecer antes que tarjeta');
});

test('2. Cuotas visibles junto al precio con tarjeta y marcadas como aproximadas', () => {
    const html = renderPage(book({ price: 1200 }), 'un-libro-de-prueba', false, '');
    assert.match(html, /Hasta 12 cuotas de aprox\. \$100 UYU/); // 1200 / 12 = 100
    const priceBox = extractBlock(html, 'price-box');
    const cardIdx = priceBox.indexOf('Con tarjeta:');
    const installmentIdx = priceBox.indexOf('Hasta 12 cuotas');
    assert.ok(cardIdx < installmentIdx, 'tarjeta debe aparecer antes que sus cuotas');
});

test('3. Transferencia lidera y tarjeta conserva alta visibilidad', () => {
    const html = renderPage(book({ price: 1200 }), 'un-libro-de-prueba', false, '');
    assert.match(html, /class="price-transfer"/);
    assert.match(html, /class="price-card"/);
    assert.match(html, /\.price-transfer strong\{font-size:2rem;font-weight:850/);
    assert.match(html, /\.price-card strong\{font-size:1\.3rem;font-weight:800/);
    assert.match(html, /\.price-card span\{font-size:1\.05rem;font-weight:700/);
    assert.match(html, /\.price-card\{[^}]*border:1px solid #d8d1c7[^}]*background:#faf8f5/);
});

test('4. Orden de botones: Agregar al carrito → WhatsApp → Mercado Libre (dentro del bloque .cta, no de la hoja de estilos)', () => {
    const html = renderPage(book(), 'un-libro-de-prueba', false, '');
    const cta = extractBlock(html, 'cta');
    const cartIdx = cta.indexOf('data-action="add-to-cart"');
    const waIdx = cta.indexOf('btn-wa');
    const mlIdx = cta.indexOf('btn-ml');
    assert.ok(cartIdx > -1 && waIdx > -1 && mlIdx > -1, 'los tres CTA deben estar presentes');
    assert.ok(cartIdx < waIdx, 'Carrito debe aparecer antes que WhatsApp');
    assert.ok(waIdx < mlIdx, 'WhatsApp debe aparecer antes que Mercado Libre');
});

test('5. Mercado Libre no usa el estilo visual principal (sin relleno amarillo dominante)', () => {
    const html = renderPage(book(), 'un-libro-de-prueba', false, '');
    // Antes: .btn-ml{background:#ffe600;color:#1e293b} (relleno amarillo sólido,
    // mismo peso que carrito). Ahora: outline claro, fuente más chica.
    assert.doesNotMatch(html, /\.btn-ml\{background:#ffe600/);
    assert.match(html, /\.btn-ml\{background:#fff;color:#7a6a1f;border:1\.5px solid #e8dfa0;\s*font-size:\.82rem;font-weight:600/);
    // Carrito sigue siendo el más fuerte: fondo sólido + ancho completo.
    assert.match(html, /\.btn-cart\{background:#e49982;color:#fff;border:none;font-family:inherit;\s*cursor:pointer;width:100%\}/);
});

test('6. El enlace de WhatsApp sigue siendo válido (wa.me + mensaje codificado)', () => {
    const html = renderPage(book({ title: 'Un Libro & Su Título' }), 'un-libro', false, '');
    assert.match(html, /href="https:\/\/wa\.me\/59899841325\?text=/);
    assert.match(html, /Hola!%20Me%20interesa/);
});

test('7. El enlace de Mercado Libre sigue siendo válido (permalink real, escapado)', () => {
    const permalink = 'https://articulo.mercadolibre.com.uy/MLU-999-otro-libro';
    const html = renderPage(book({ permalink }), 'otro-libro', false, '');
    assert.match(html, new RegExp(`href="${permalink.replace(/\//g, '\\/')}"`));
    assert.match(html, /target="_blank" rel="noopener noreferrer">\s*Comprar en MercadoLibre/);
});

test('8. Ficha con Mercado Libre: los tres botones están presentes', () => {
    const html = renderPage(book({ permalink: 'https://articulo.mercadolibre.com.uy/MLU-1' }), 'un-libro', false, '');
    assert.match(html, /data-action="add-to-cart"/);
    assert.match(html, /class="btn btn-wa"/);
    assert.match(html, /class="btn btn-ml"/);
});

test('9. Ficha sin stock ("por encargo"): no hay bloques de precio ni botón de Mercado Libre, solo WhatsApp/aviso', () => {
    const html = renderPage(book({ status: 'paused', available_quantity: 0 }), 'un-libro', false, 'site-key-fake');
    assert.doesNotMatch(html, /Mejor precio · Transferencia/);
    assert.doesNotMatch(html, /Con tarjeta:/);
    assert.doesNotMatch(html, /class="btn btn-ml"/);
    assert.doesNotMatch(html, /data-action="add-to-cart"/);
    assert.match(html, /class="btn btn-wa"/);
});

test('10. No cambia el cálculo de precio, cuotas ni transferencia (solo texto/orden/estilo)', () => {
    const html = renderPage(book({ price: 999 }), 'un-libro', false, '');
    assert.match(html, /\$999 UYU/); // precio base sin redondeo especial
    assert.match(html, /\$879 UYU/); // 999 * 0.88 = 879.12 -> Math.round = 879 (transferencia)
    assert.match(html, /\$83 UYU/);  // Math.round(999/12) = 83 (cuotas)
});

test('11. Responsive: no hay reglas que oculten o reordenen los CTA por media query (mismo orden en mobile y desktop)', () => {
    const html = renderPage(book(), 'un-libro', false, '');
    // El contenedor .cta es un flex-column simple, sin @media que reordene o
    // esconda btn-ml/btn-wa/btn-cart — el orden del DOM (ya verificado en el
    // test 4) es el que se ve en cualquier ancho de viewport.
    assert.match(html, /\.cta\{display:flex;flex-direction:column;gap:\.75rem;margin-top:1rem\}/);
    assert.doesNotMatch(html, /@media[^{]*\{[^}]*\.btn-(ml|wa|cart)/s);
});
