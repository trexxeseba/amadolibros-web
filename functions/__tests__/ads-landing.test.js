// Landing para anuncios de Google: /liquidacion sin leyenda de promos viejas,
// ficha sin "Comprar en MercadoLibre" y con origen en WhatsApp, y whatsapp_click
// con item_id = MLU.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { promoWasHtml, WEB_PROMO } from '../_shared/web-promo.js';
import { ADS_LANDING_SCRIPT, ADS_LANDING_STYLES, ADS_ORIGIN_LINE } from '../_shared/ads-landing.js';
import { buildBookWhatsAppMessage, whatsappHref } from '../../shared/whatsapp-messages.js';
import { renderPage } from '../libro/[[path]].js';

// ── /liquidacion ─────────────────────────────────────────────────────────

test('/liquidacion no menciona Amado Week ni "hasta el 9/11", ni con la promo vigente', () => {
    const page = readFileSync('functions/liquidacion.js', 'utf8');
    // Sin la rama de copy de promo web ni el helper que la decide.
    assert.doesNotMatch(page, /WEB_PROMO|webPromoActive/);
    // La línea de precio habitual sale siempre como liquidación.
    assert.match(page, /promoWasHtml\(\{ \.\.\.book, liquidation: true \}\)/);
    // Aun con un item que trae original_price de la promo web, no sale la leyenda.
    const html = promoWasHtml({ price: 1700, original_price: 2000, liquidation: true });
    assert.match(html, /Precio de liquidación\. Precio habitual: <s>\$2\.000 UYU<\/s>/);
    assert.ok(!html.includes(WEB_PROMO.name));
    assert.doesNotMatch(html, /hasta el 9\/11/);
});

// ── Ficha ────────────────────────────────────────────────────────────────

function ficha(overrides = {}) {
    return renderPage({
        id: 'MLU123', title: 'Un Libro De Prueba', author: 'Autor De Prueba', price: 1500,
        status: 'active', available_quantity: 3, condition: 'new', isbn: '9788499809991',
        currency: 'UYU', thumbnail: 'http://http2.mlstatic.com/D_1-I.jpg', pictures: [],
        permalink: 'https://articulo.mercadolibre.com.uy/MLU-123-un-libro',
        ...overrides,
    }, 'un-libro-de-prueba', false, '');
}

test('ficha: lleva el script y el estilo del tráfico de Google Ads, y el resto sigue igual', () => {
    const html = ficha();
    assert.ok(html.includes(ADS_LANDING_SCRIPT));
    assert.ok(html.includes(ADS_LANDING_STYLES));
    // Sin gclid el botón existe (solo se oculta por la clase que pone el script).
    assert.match(html, /class="btn btn-ml"[^>]*>\s*Comprar en MercadoLibre/);
    // Carrito primero, WhatsApp segundo, Mercado Libre último.
    const cta = html.slice(html.indexOf('<div class="cta">'));
    assert.ok(cta.indexOf('btn-cart') < cta.indexOf('btn-wa'));
    assert.ok(cta.indexOf('btn-wa') < cta.indexOf('btn-ml'));
});

function runAdsScript(search, hrefs) {
    const classes = new Set();
    const links = hrefs.map(href => ({ href, getAttribute() { return this.href; }, setAttribute(_, v) { this.href = v; } }));
    const document = {
        readyState: 'complete',
        documentElement: { classList: { add: c => classes.add(c) } },
        addEventListener: () => {},
        querySelectorAll: selector => (selector === 'a[href^="https://wa.me/"]' ? links : []),
    };
    const script = ADS_LANDING_SCRIPT.replace(/^<script>/, '').replace(/<\/script>$/, '');
    runInNewContext(script, { document, location: { search }, URLSearchParams, decodeURIComponent, encodeURIComponent, String });
    return { classes, hrefs: links.map(l => l.href) };
}

const WA = whatsappHref(buildBookWhatsAppMessage({
    title: 'Un Libro De Prueba', author: 'Autor De Prueba',
    page: 'https://www.amadolibros.com/libro/MLU123/un-libro-de-prueba', available: true,
}));
const textOf = href => decodeURIComponent(href.split('?text=')[1]);

test('ficha: con gclid, utm_source=google, gbraid o wbraid oculta ML y suma el origen a WhatsApp', () => {
    for (const search of ['?gclid=abc123', '?utm_source=google&utm_medium=cpc', '?utm_source=Google', '?gbraid=x', '?wbraid=y', '?foo=1&gclid=z']) {
        const { classes, hrefs } = runAdsScript(search, [WA, WA]);
        assert.ok(classes.has('from-google-ads'), search);
        for (const href of hrefs) {
            const text = textOf(href);
            assert.ok(text.includes(ADS_ORIGIN_LINE), search);
            // Va después de la línea de página y antes del cierre.
            const lines = text.split('\n');
            const pageIdx = lines.findIndex(l => l.startsWith('Página: '));
            assert.equal(lines[pageIdx + 1], 'Origen: Google Ads');
            assert.match(text, /Quisiera confirmar si está disponible/);
            // El resto del mensaje queda igual.
            assert.equal(text.replace('\nOrigen: Google Ads', ''), textOf(WA));
            assert.ok(href.startsWith('https://wa.me/59899841325?text='));
        }
    }
});

test('ficha: sin Google Ads (directo, otras fuentes) no cambia nada', () => {
    for (const search of ['', '?utm_source=facebook', '?utm_source=newsletter&utm_medium=email', '?q=google']) {
        const { classes, hrefs } = runAdsScript(search, [WA]);
        assert.equal(classes.size, 0, search);
        assert.equal(hrefs[0], WA, search);
    }
});

test('ficha: el origen no se duplica si el script corre dos veces', () => {
    const once = runAdsScript('?gclid=1', [WA]).hrefs[0];
    const twice = runAdsScript('?gclid=1', [once]).hrefs[0];
    assert.equal(twice, once);
});

// ── GA4: whatsapp_click con item_id = MLU ────────────────────────────────

const analytics = readFileSync('astro-front/public/analytics-events.js', 'utf8');

function whatsappParams(pathname, attrs = {}) {
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
    const [, name, params] = Array.from(window.dataLayer.at(-1));
    assert.equal(name, 'whatsapp_click');
    return { ...params };
}

test('whatsapp_click lleva item_id = MLU en la ficha y en las tarjetas de /liquidacion', () => {
    assert.equal(whatsappParams('/libro/MLU1453287196/grandes-clasicos').item_id, 'MLU1453287196');
    assert.equal(whatsappParams('/liquidacion', { 'data-mlu': 'MLU777' }).item_id, 'MLU777');
    // Sin libro identificable no se manda item_id (ni vacío).
    assert.equal('item_id' in whatsappParams('/contacto'), false);
    assert.equal('item_id' in whatsappParams('/liquidacion', { 'data-mlu': 'no-es-mlu' }), false);
    // libro_id y product_id siguen como antes.
    const p = whatsappParams('/libro/MLU1453287196/grandes-clasicos');
    assert.equal(p.libro_id, 'MLU1453287196');
    assert.equal(p.product_id, 'MLU1453287196');
});

test('add_to_cart, begin_checkout y purchase mandan item_id con el MLU', () => {
    const cartJs = readFileSync('astro-front/public/cart.js', 'utf8');
    assert.match(cartJs, /trackCommerce\('add_to_cart'[\s\S]*?item_id: item\.id/);
    const cart = readFileSync('astro-front/src/pages/carrito.astro', 'utf8');
    assert.match(cart, /trackCommerce\('begin_checkout', order, 'bank_transfer'/);
    assert.match(cart, /trackCommerce\('begin_checkout', orderData\.order, 'mercado_pago'/);
    const pedido = readFileSync('astro-front/src/pages/pedido.astro', 'utf8');
    assert.match(pedido, /trackCommerce\('purchase'[\s\S]*?items: data\.items/);
    // El helper normaliza id / product_id / item_id a item_id.
    assert.match(analytics, /raw\.item_id \|\| raw\.product_id \|\| raw\.id/);
});
