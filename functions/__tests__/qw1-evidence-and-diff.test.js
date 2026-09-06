import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  classifyCohortRow,
  resolveItemForEnvironment,
} from '../../scripts/seo/qw1-cohort-catalog-evidence.mjs';
import { classifyChange, coherence } from '../../scripts/seo/qw1-render-diff.mjs';
import { coverageFor } from '../../scripts/seo/catalog-coverage-effective.mjs';

// Revisión de Astra sobre QW1: la ausencia de Offer NO prueba ausencia de
// precio. Estas pruebas fijan el contrato de la evidencia: cada MLU se
// resuelve contra la fuente que consume cada entorno y, cuando la fuente no
// transporta el dato, se dice exactamente eso — no "no tiene precio".

test('un ítem del catálogo activo reporta status/precio/moneda/stock reales', () => {
  const resolved = resolveItemForEnvironment('MLU1', {
    catalogItem: { id: 'MLU1', status: 'active', price: 1500, currency_id: 'UYU', available_quantity: 3 },
    pausedIndex: new Map(),
  });
  assert.equal(resolved.source, 'catalog.json');
  assert.equal(resolved.status, 'active');
  assert.equal(resolved.price, 1500);
  assert.equal(resolved.currency, 'UYU');
  assert.equal(resolved.available_quantity, 3);
  assert.equal(resolved.httpExpected, 200);
});

test('un pausado declara que la fuente NO transporta precio ni moneda (no que no tenga)', () => {
  const resolved = resolveItemForEnvironment('MLU2', {
    catalogItem: null,
    pausedIndex: new Map([['MLU2', { id: 'MLU2' }]]),
  });
  assert.equal(resolved.source, 'paused-index');
  assert.equal(resolved.status, 'paused');
  assert.equal(resolved.price, 'no-transportado-por-la-fuente');
  assert.equal(resolved.currency, 'no-transportado-por-la-fuente');
  assert.equal(resolved.httpExpected, 200);
});

test('un ítem ausente de ambas fuentes del entorno espera HTTP 404', () => {
  const resolved = resolveItemForEnvironment('MLU3', { catalogItem: null, pausedIndex: new Map() });
  assert.equal(resolved.source, null);
  assert.equal(resolved.httpExpected, 404);
});

test('la clasificación separa 404, pausado y activo-con-precio sin inventar causas', () => {
  const pausadoEnAmbos = {
    environments: {
      produccion: { source: 'paused-index', status: 'paused', httpExpected: 200 },
      preview: { source: 'paused-index', status: 'paused', httpExpected: 200 },
    },
  };
  assert.equal(classifyCohortRow(pausadoEnAmbos), 'pausado_sin_precio_en_la_fuente');

  const soloEnProduccion = {
    environments: {
      produccion: { source: 'paused-index', status: 'paused', httpExpected: 200 },
      preview: { source: null, status: null, httpExpected: 404 },
    },
  };
  assert.equal(classifyCohortRow(soloEnProduccion), 'no_comparable_404');

  const activoConPrecio = {
    environments: {
      produccion: { source: 'catalog.json', status: 'active', price: 990, httpExpected: 200 },
      preview: { source: 'catalog.json', status: 'active', price: 990, httpExpected: 200 },
    },
  };
  assert.equal(classifyCohortRow(activoConPrecio), 'activo_con_precio_real');

  const activoSinPrecio = {
    environments: {
      produccion: { source: 'catalog.json', status: 'active', price: 0, httpExpected: 200 },
      preview: { source: 'catalog.json', status: 'active', price: 0, httpExpected: 200 },
    },
  };
  assert.equal(classifyCohortRow(activoSinPrecio), 'causa_pendiente_de_verificar');
});

test('el diff entre renderizadores distingue agregado, removido, modificado y sin cambio', () => {
  const sinOffer = { offer: null };
  const conOffer = { offer: { price: '1500', priceCurrency: 'UYU', availability: 'InStock', url: 'u' } };
  const conOfferOos = { offer: { price: '1500', priceCurrency: 'UYU', availability: 'OutOfStock', url: 'u' } };
  assert.equal(classifyChange(sinOffer, conOffer), 'offer_agregado');
  assert.equal(classifyChange(conOffer, sinOffer), 'offer_removido');
  assert.equal(classifyChange(conOffer, conOfferOos), 'offer_modificado');
  assert.equal(classifyChange(conOffer, conOffer), 'sin_cambio');
  assert.equal(classifyChange(sinOffer, sinOffer), 'sin_cambio');
});

test('la coherencia detecta Offer sin precio visible y botón de compra sin stock', () => {
  const offerSinPrecioVisible = coherence({
    offer: { price: '1500', availability: 'OutOfStock' },
    visiblePriceBox: false,
    cartButton: false,
    available_quantity: 0,
  });
  assert.equal(offerSinPrecioVisible.offerSinPrecioVisible, true);
  assert.equal(offerSinPrecioVisible.botonCompraSinStock, false);

  const botonSinStock = coherence({
    offer: { price: '1500', availability: 'OutOfStock' },
    visiblePriceBox: true,
    cartButton: true,
    available_quantity: 0,
  });
  assert.equal(botonSinStock.botonCompraSinStock, true);
  assert.equal(botonSinStock.offerOutOfStockConBoton, true);
});

test('la cobertura separa autor no vacío de autor REAL y descripción por umbral', () => {
  const items = [
    { author: 'Autora Real', description: 'x'.repeat(300) },
    { author: 'Desconocido', description: 'corta' },
    { author: '', description: '' },
  ];
  const coverage = coverageFor(items);
  assert.equal(coverage.author_no_vacio.count, 2);
  assert.equal(coverage.author_real.count, 1);
  assert.equal(coverage.author_generico.count, 1);
  assert.equal(coverage.description_no_vacia.count, 2);
  assert.equal(coverage.description_util_280.count, 1);
});

test('los scripts de evidencia son de solo lectura (sin escrituras a Merchant ni al catálogo)', () => {
  for (const file of [
    'scripts/seo/qw1-cohort-catalog-evidence.mjs',
    'scripts/seo/qw1-catalog-snapshot.mjs',
    'scripts/seo/qw1-renderer-offer-report.mjs',
    'scripts/seo/qw1-render-diff.mjs',
    'scripts/seo/catalog-coverage-effective.mjs',
  ]) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /method\s*:\s*['"](?:POST|PATCH|PUT|DELETE)['"]/i, file);
    assert.doesNotMatch(source, /merchantapi\.googleapis\.com/i, file);
  }
});
