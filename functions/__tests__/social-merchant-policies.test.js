import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderPage } from '../libro/[[path]].js';

const root = rel => fileURLToPath(new URL('../../' + rel, import.meta.url));
const read = rel => readFileSync(root(rel), 'utf8');

function productSchemaFromHtml(html) {
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const parsed = JSON.parse(match[1]);
    const types = Array.isArray(parsed['@type']) ? parsed['@type'] : [parsed['@type']];
    if (types.includes('Product')) return parsed;
  }
  throw new Error('Product JSON-LD no encontrado');
}

function item(overrides = {}) {
  return {
    id: 'MLU123456789',
    title: 'Libro de prueba',
    author: 'Autora Real',
    isbn: '9781234567897',
    publisher: 'Editorial Real',
    price: 1500,
    available_quantity: 2,
    status: 'active',
    condition: 'new',
    permalink: 'https://articulo.mercadolibre.com.uy/MLU-123456789',
    pictures: ['https://http2.mlstatic.com/test.jpg'],
    ...overrides,
  };
}

test('BaseLayout completa Open Graph y Twitter para las páginas Astro', () => {
  const layout = read('astro-front/src/layouts/BaseLayout.astro');
  for (const property of ['og:type', 'og:locale', 'og:site_name', 'og:title', 'og:description', 'og:url', 'og:image', 'og:image:alt']) {
    assert.match(layout, new RegExp(`property="${property}"`));
  }
  for (const name of ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image', 'twitter:image:alt']) {
    assert.match(layout, new RegExp(`name="${name}"`));
  }
});

test('la política global de envíos modela exactamente el umbral de $1.500', () => {
  const page = read('astro-front/src/pages/envios.astro');
  assert.match(page, /'@type': 'OnlineStore'/);
  assert.match(page, /'@id': 'https:\/\/www\.amadolibros\.com\/#bookstore'/);
  assert.doesNotMatch(page, /#organization/);
  assert.match(page, /'@type': 'ShippingService'/);
  assert.match(page, /maxValue: 1499\.99/);
  assert.match(page, /minValue: 1500/);
  assert.match(page, /value: 250, currency: 'UYU'/);
  assert.match(page, /value: 0, currency: 'UYU'/);
  assert.match(page, /addressCountry: 'UY'/);
});

test('la política global de devoluciones refleja la página visible', () => {
  const page = read('astro-front/src/pages/devoluciones.astro');
  assert.match(page, /'@type': 'OnlineStore'/);
  assert.match(page, /'@id': 'https:\/\/www\.amadolibros\.com\/#bookstore'/);
  assert.doesNotMatch(page, /#organization/);
  assert.match(page, /'@type': 'MerchantReturnPolicy'/);
  assert.match(page, /merchantReturnDays: 5/);
  assert.match(page, /ReturnFeesCustomerResponsibility/);
  assert.match(page, /devoluciones#merchant-return-policy/);
});

test('las ofertas activas referencian la política global y las pausadas no crean Offer', () => {
  const active = productSchemaFromHtml(renderPage(item(), 'libro-de-prueba', false, ''));
  assert.deepEqual(active.offers.hasMerchantReturnPolicy, {
    '@id': 'https://www.amadolibros.com/devoluciones#merchant-return-policy',
  });
  assert.deepEqual(active.offers.seller, {
    '@type': 'OnlineStore',
    '@id': 'https://www.amadolibros.com/#bookstore',
    name: 'Amado Libros',
    url: 'https://www.amadolibros.com/',
  });
  assert.deepEqual(active.offers.shippingDetails, {
    '@type': 'OfferShippingDetails',
    hasShippingService: {
      '@id': 'https://www.amadolibros.com/envios#shipping-service',
    },
  });

  const paused = productSchemaFromHtml(renderPage(
    item({ status: 'paused', available_quantity: 0 }),
    'libro-de-prueba',
    false,
    '',
  ));
  assert.equal(paused.offers, undefined);
});

// QW1 (Merchant, PR de recuperación de missing_price): un producto ACTIVO
// con precio real de catálogo debe publicar Offer aunque hoy no tenga stock
// — Google necesita ver el precio real + disponibilidad real, no la ausencia
// total de Offer (eso es lo que generaba missing_price para fichas que sí
// tienen precio comercial). 'paused' (arriba) sigue sin Offer: no cambia.

test('QW1: activo con precio real pero sin stock publica Offer con OutOfStock (no omite el precio)', () => {
  const outOfStock = productSchemaFromHtml(renderPage(
    item({ status: 'active', available_quantity: 0 }),
    'libro-de-prueba',
    false,
    '',
  ));
  assert.ok(outOfStock.offers, 'debe existir Offer para un producto activo con precio real');
  assert.equal(outOfStock.offers.price, '1500');
  assert.equal(outOfStock.offers.priceCurrency, 'UYU');
  assert.equal(outOfStock.offers.availability, 'https://schema.org/OutOfStock');
  assert.equal(outOfStock.offers.url, 'https://www.amadolibros.com/libro/MLU123456789/libro-de-prueba');
});

test('QW1: activo con stock sigue publicando Offer con InStock (sin regresión)', () => {
  const inStock = productSchemaFromHtml(renderPage(item(), 'libro-de-prueba', false, ''));
  assert.equal(inStock.offers.availability, 'https://schema.org/InStock');
  assert.equal(inStock.offers.price, '1500');
});

test('QW1: sin precio real de catálogo NUNCA se inventa un Offer (price=0, null o ausente)', () => {
  for (const badPrice of [0, null, undefined, '']) {
    const noPrice = productSchemaFromHtml(renderPage(
      item({ price: badPrice, available_quantity: 3 }),
      'libro-de-prueba',
      false,
      '',
    ));
    assert.equal(noPrice.offers, undefined, `price=${JSON.stringify(badPrice)} no debe generar Offer`);
  }
});

test('QW1: moneda no soportada (no UYU) tampoco genera Offer — no se inventa una conversión', () => {
  const otherCurrency = productSchemaFromHtml(renderPage(
    item({ currency: 'USD', available_quantity: 3 }),
    'libro-de-prueba',
    false,
    '',
  ));
  assert.equal(otherCurrency.offers, undefined);
});

test('QW1: paused sin stock sigue sin Offer aunque tenga precio real (no cambia)', () => {
  const paused = productSchemaFromHtml(renderPage(
    item({ status: 'paused', available_quantity: 0, price: 1500 }),
    'libro-de-prueba',
    false,
    '',
  ));
  assert.equal(paused.offers, undefined);
});

test('QW1: Offer.url siempre coincide con la URL canónica de la ficha', () => {
  const html = renderPage(item({ available_quantity: 0 }), 'otro-slug-de-prueba', false, '');
  const schema = productSchemaFromHtml(html);
  const canonicalMatch = html.match(/<link rel="canonical" href="([^"]+)">/);
  assert.ok(canonicalMatch, 'debe existir <link rel=canonical>');
  assert.equal(schema.offers.url, canonicalMatch[1]);
});

test('QW1: itemCondition sigue aplicándose sobre el Offer aunque esté sin stock', () => {
  const used = productSchemaFromHtml(renderPage(
    item({ condition: 'used', available_quantity: 0 }),
    'libro-de-prueba',
    false,
    '',
  ));
  assert.equal(used.offers.itemCondition, 'https://schema.org/UsedCondition');
});

test('QW1: no hay regresión en el carrito/checkout — sellableInCheckout sigue exigiendo stock real', () => {
  const html = renderPage(item({ available_quantity: 0 }), 'libro-de-prueba', false, '');
  // El botón de acción y el bloque de precio comprables siguen ausentes sin
  // stock real, aunque el JSON-LD ahora publique el Offer con OutOfStock.
  assert.doesNotMatch(html, /Agregar al carrito/i);
});
