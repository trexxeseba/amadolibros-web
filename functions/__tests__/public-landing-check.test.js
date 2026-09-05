import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { extractCanonical, extractJsonLdOffers } from '../../scripts/commerce/public-landing-check.mjs';

test('la implementación es de solo lectura, no toca Merchant ni checkout', () => {
  const source = readFileSync('scripts/commerce/public-landing-check.mjs', 'utf8');
  assert.doesNotMatch(source, /method\s*:\s*['"](?:POST|PATCH|PUT|DELETE)['"]/i);
  assert.doesNotMatch(source, /merchantapi\.googleapis\.com/i);
  assert.doesNotMatch(source, /checkout/i);
  // Sólo debe existir el fetch() a las páginas públicas del propio catálogo.
  const fetchCalls = source.match(/\bfetch\(/g) || [];
  assert.equal(fetchCalls.length, 1);
});

test('extractJsonLdOffers lee precio/moneda/disponibilidad de un Product válido', () => {
  const html = `<html><head>
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Product","name":"Rayuela",
       "offers":{"@type":"Offer","price":"1200.00","priceCurrency":"UYU","availability":"https://schema.org/InStock"}}
    </script>
  </head><body></body></html>`;
  const offer = extractJsonLdOffers(html);
  assert.equal(offer.name, 'Rayuela');
  assert.equal(offer.price, '1200.00');
  assert.equal(offer.priceCurrency, 'UYU');
  assert.equal(offer.availability, 'InStock');
});

test('extractJsonLdOffers soporta @graph y descarta nodos que no son Product/Book', () => {
  const html = `<script type="application/ld+json">
    {"@graph":[
      {"@type":"BreadcrumbList","itemListElement":[]},
      {"@type":"Book","name":"Cien años de soledad","offers":{"price":"950","priceCurrency":"UYU","availability":"https://schema.org/OutOfStock"}}
    ]}
  </script>`;
  const offer = extractJsonLdOffers(html);
  assert.equal(offer.name, 'Cien años de soledad');
  assert.equal(offer.availability, 'OutOfStock');
});

test('extractJsonLdOffers devuelve null sin JSON-LD o con JSON inválido', () => {
  assert.equal(extractJsonLdOffers('<html></html>'), null);
  assert.equal(extractJsonLdOffers('<script type="application/ld+json">{not valid</script>'), null);
});

test('extractCanonical toma el href de link rel=canonical', () => {
  const html = '<head><link rel="canonical" href="https://www.amadolibros.com/libro/x"></head>';
  assert.equal(extractCanonical(html), 'https://www.amadolibros.com/libro/x');
  assert.equal(extractCanonical('<head></head>'), null);
});
