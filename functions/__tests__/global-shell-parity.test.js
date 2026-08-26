// GLOBAL-SHELL-1 — el shell global no debe volver a divergir entre Astro y SSR.
//
// La ficha de libro quedó sin favicon, sin WhatsApp flotante y con un footer
// reducido a "Catálogo · Políticas" porque el shell se copiaba a mano entre
// Astro y las Pages Functions. Ahora la fuente de verdad es
// functions/_shared/brand.js; estas pruebas fallan si Footer.astro se edita
// sin actualizar el módulo (o al revés), y si algún head pierde los iconos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    BRAND, CONTACT, FOOTER_LINKS,
    footerHtml, faviconHeadHtml, waFloatHtml, waHref,
} from '../_shared/brand.js';

const root = (rel) => fileURLToPath(new URL('../../' + rel, import.meta.url));
const read = (rel) => readFileSync(root(rel), 'utf8');

const FOOTER_ASTRO = read('astro-front/src/components/Footer.astro');
const FICHA        = read('functions/libro/[[path]].js');
const CATALOGO     = read('functions/catalogo.js');
const BASE_LAYOUT  = read('astro-front/src/layouts/BaseLayout.astro');
const WHATSAPP_SHARED = read('shared/whatsapp-messages.js');

// ── 1. Paridad de contenido con Footer.astro ────────────────────────────────

test('1. la marca y el tagline del módulo coinciden con Footer.astro', () => {
    assert.ok(FOOTER_ASTRO.includes(BRAND.name), 'nombre de marca');
    // El tagline vive partido en varias líneas en el .astro: se compara
    // normalizando los espacios, no carácter por carácter.
    const flat = FOOTER_ASTRO.replace(/\s+/g, ' ');
    assert.ok(flat.includes(BRAND.tagline.replace(/\s+/g, ' ')),
        'el tagline de brand.js debe seguir presente en Footer.astro');
});

test('2. todos los links institucionales existen en Footer.astro', () => {
    for (const { href, label } of FOOTER_LINKS) {
        assert.ok(FOOTER_ASTRO.includes(`href="${href}"`), `falta href ${href}`);
        assert.ok(FOOTER_ASTRO.includes(label), `falta el texto "${label}"`);
    }
});

test('3. los datos de contacto coinciden con Footer.astro', () => {
    const flat = FOOTER_ASTRO.replace(/\s+/g, ' ');
    assert.ok(flat.includes(CONTACT.whatsappDisplay), 'teléfono visible');
    assert.ok(FOOTER_ASTRO.includes(CONTACT.email), 'email');
    assert.ok(WHATSAPP_SHARED.includes(CONTACT.whatsappNumber), 'número de WhatsApp');
    assert.match(FOOTER_ASTRO, /whatsappHref\(buildWhatsAppMessage/,
        'Footer.astro debe usar el generador canónico');
});

test('4. Footer.astro no incorpora links nuevos sin pasar por brand.js', () => {
    const known = new Set([
        ...FOOTER_LINKS.map(l => l.href),
        '/contacto/', `mailto:${CONTACT.email}`,
    ]);
    const hrefs = [...FOOTER_ASTRO.matchAll(/href="(\/[^"]*|mailto:[^"]*)"/g)]
        .map(m => m[1]);
    for (const h of hrefs) {
        assert.ok(known.has(h),
            `Footer.astro tiene "${h}" que brand.js desconoce: agregalo al módulo`);
    }
});

// ── 2. El footer SSR es completo, no "Catálogo · Políticas" ─────────────────

test('5. el footer generado trae marca, tagline, links y contacto', () => {
    const html = footerHtml(2031);
    assert.match(html, /Amado Libros/);
    assert.ok(html.includes(BRAND.tagline));
    for (const { href, label } of FOOTER_LINKS) {
        assert.ok(html.includes(`href="${href}"`), `falta ${href}`);
        assert.ok(html.includes(label), `falta ${label}`);
    }
    assert.ok(html.includes(CONTACT.whatsappDisplay));
    assert.ok(html.includes(CONTACT.email));
    assert.ok(html.includes(CONTACT.pickupLine));
});

test('6. el copyright es dinámico, no un año fijo', () => {
    assert.ok(footerHtml(2031).includes('&copy; 2031'));
    assert.ok(footerHtml(2049).includes('&copy; 2049'));
    // El año viejo estaba escrito a mano en la ficha.
    assert.doesNotMatch(FICHA, /&copy; 2026 Amado Libros/);
});

test('7. la ficha ya no usa el footer mínimo', () => {
    assert.doesNotMatch(FICHA, /<a href="\/">Catálogo<\/a> ·/);
    assert.match(FICHA, /\$\{footerHtml\(undefined, canonicalUrl\)\}/);
});

// ── 3. Favicon ──────────────────────────────────────────────────────────────

const ICON_FILES = [
    ['astro-front/public/favicon.ico', 1000],
    ['astro-front/public/favicon-16x16.png', 100],
    ['astro-front/public/favicon-32x32.png', 100],
    ['astro-front/public/apple-touch-icon.png', 1000],
    ['astro-front/public/site.webmanifest', 100],
];

test('8. los archivos de icono existen de verdad y no están vacíos', () => {
    for (const [rel, min] of ICON_FILES) {
        assert.ok(existsSync(root(rel)), `falta ${rel}`);
        assert.ok(statSync(root(rel)).size > min, `${rel} demasiado chico`);
    }
});

test('9. los PNG tienen las dimensiones declaradas', () => {
    // Ancho y alto viven en el chunk IHDR, bytes 16..24 de un PNG.
    const dims = (rel) => {
        const b = readFileSync(root(rel));
        return [b.readUInt32BE(16), b.readUInt32BE(20)];
    };
    assert.deepEqual(dims('astro-front/public/favicon-16x16.png'), [16, 16]);
    assert.deepEqual(dims('astro-front/public/favicon-32x32.png'), [32, 32]);
    assert.deepEqual(dims('astro-front/public/apple-touch-icon.png'), [180, 180]);
});

test('10. favicon.ico es un ICO real, no HTML', () => {
    const b = readFileSync(root('astro-front/public/favicon.ico'));
    // Cabecera ICO: reservado=0, tipo=1.
    assert.equal(b.readUInt16LE(0), 0);
    assert.equal(b.readUInt16LE(2), 1);
    assert.ok(b.readUInt16LE(4) >= 1, 'debe declarar al menos una imagen');
    assert.doesNotMatch(b.subarray(0, 200).toString('latin1'), /<!DOCTYPE|<html/i);
});

test('11. el manifest es JSON válido con iconos declarados', () => {
    const m = JSON.parse(read('astro-front/public/site.webmanifest'));
    assert.equal(m.name, BRAND.name);
    assert.ok(Array.isArray(m.icons) && m.icons.length >= 2);
    for (const i of m.icons) {
        assert.ok(existsSync(root('astro-front/public' + i.src)), `falta ${i.src}`);
    }
});

test('12. todos los HTML declaran los iconos', () => {
    const head = faviconHeadHtml();
    for (const rel of ['/favicon.ico', '/favicon-32x32.png', '/favicon-16x16.png',
                       '/apple-touch-icon.png', '/site.webmanifest']) {
        assert.ok(head.includes(rel), `falta ${rel} en el head SSR`);
        assert.ok(BASE_LAYOUT.includes(rel), `falta ${rel} en BaseLayout.astro`);
    }
    assert.match(FICHA, /\$\{faviconHeadHtml\(\)\}/);
    assert.match(CATALOGO, /\$\{faviconHeadHtml\(\)\}/);
});

test('13. los iconos llevan versión para vencer la caché del navegador', () => {
    assert.match(faviconHeadHtml(), /favicon\.ico\?v\d/);
    assert.match(BASE_LAYOUT, /favicon\.ico\?v\d/);
});

// ── 4. Logo ─────────────────────────────────────────────────────────────────

test('14. no queda ninguna referencia al logo inexistente logo-amado.png', () => {
    for (const [name, src] of [['ficha', FICHA], ['catalogo', CATALOGO],
                               ['BaseLayout', BASE_LAYOUT]]) {
        assert.doesNotMatch(src, /logo-amado\.png/, `${name} referencia un logo que no existe`);
    }
});

test('15. el logo de la ficha existe, es el webp y tiene alt', () => {
    assert.ok(existsSync(root('astro-front/public' + BRAND.logo)), 'el webp debe existir');
    const img = FICHA.match(/<img[^>]*brand-logo[^>]*>/);
    assert.ok(img, 'la ficha debe tener el logo en el header');
    assert.match(img[0], /logo-amado\.webp/);
    assert.match(img[0], /alt="[^"]/, 'el logo necesita alt no vacío');
    assert.match(img[0], /width="\d+"[^>]*height="\d+"/, 'debe declarar dimensiones');
});

// ── 5. WhatsApp flotante ────────────────────────────────────────────────────

test('16. la ficha incluye la burbuja flotante con mensaje contextual', () => {
    assert.match(FICHA, /\$\{waFloatHtml\(waMessage, canonicalUrl\)\}/);
});

test('17. el mensaje del flotante viaja codificado', () => {
    const html = waFloatHtml('Hola, tengo una consulta sobre El Túnel & Otros.');
    assert.ok(html.includes('El%20T%C3%BAnel%20%26%20Otros'), 'debe ir percent-encoded');
    assert.doesNotMatch(html, /text=Hola, tengo/);
});

test('18. el flotante es accesible y respeta el safe area', () => {
    const html = waFloatHtml('x');
    assert.match(html, /aria-label="Consultar por WhatsApp"/);
    assert.match(html, /rel="noopener noreferrer"/);
    const { WA_FLOAT_STYLES } = { WA_FLOAT_STYLES: read('functions/_shared/brand.js') };
    assert.match(WA_FLOAT_STYLES, /env\(safe-area-inset-bottom/);
    assert.match(WA_FLOAT_STYLES, /width:56px;height:56px/);
});

test('19. el CTA de WhatsApp dentro de la ficha sigue existiendo', () => {
    // El flotante no reemplaza al CTA in-page: conviven.
    assert.match(FICHA, /Consultar por WhatsApp|Pedir este libro/);
});

test('20. waHref siempre codifica el mensaje', () => {
    assert.equal(
        waHref('a b&c'),
        `https://wa.me/${CONTACT.whatsappNumber}?text=a%20b%26c`,
    );
});
