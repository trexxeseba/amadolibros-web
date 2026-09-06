import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { classify } from '../../scripts/seo/qw1-preview-validation.mjs';

const OFFER_OK = {
  httpStatus: 200,
  canonical: 'https://www.amadolibros.com/libro/MLU1/x',
  offer: {
    price: '1500',
    priceCurrency: 'UYU',
    availability: 'InStock',
    url: 'https://www.amadolibros.com/libro/MLU1/x',
  },
};
const SIN_OFFER = { httpStatus: 200, canonical: 'https://www.amadolibros.com/libro/MLU1/x', offer: null };

// Revisión de Astra: la ausencia de `Offer` en el HTML no prueba ausencia de
// precio. Esta comparación sólo puede decir qué cambió entre entornos; la
// causa la establece qw1-cohort-catalog-evidence.mjs contra el catálogo.
test('no se infiere "no tiene precio" desde "no hay Offer"', () => {
  assert.equal(classify(SIN_OFFER, SIN_OFFER), 'sin_offer_causa_pendiente_de_verificar');
});

test('se separan corregido, ya correcto en ambos, regresión y no comparable', () => {
  assert.equal(classify(SIN_OFFER, OFFER_OK), 'corregido_por_313');
  assert.equal(classify(OFFER_OK, OFFER_OK), 'ya_correcto_en_ambos');
  assert.equal(classify(OFFER_OK, SIN_OFFER), 'regresion_en_313');
  assert.equal(classify(OFFER_OK, { httpStatus: 404, offer: null }), 'no_comparable_http');
  assert.equal(classify({ httpStatus: 404, offer: null }, OFFER_OK), 'no_comparable_http');
});

test('la implementación es de solo lectura: sin escritura, sin Merchant, un fetch por lado', () => {
  const source = readFileSync('scripts/seo/qw1-preview-validation.mjs', 'utf8');
  assert.doesNotMatch(source, /method\s*:\s*['"](?:POST|PATCH|PUT|DELETE)['"]/i);
  assert.doesNotMatch(source, /merchantapi\.googleapis\.com/i);
  const fetchCalls = source.match(/\bfetch\(/g) || [];
  assert.equal(fetchCalls.length, 1);
});
