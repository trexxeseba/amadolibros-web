import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyStrictDuplicateItems,
  DUPLICATE_REVIEW_THRESHOLDS,
} from '../duplicate-review.mjs';

function item(overrides = {}) {
  return {
    id: 'MLU1',
    condition: 'new',
    price: 1000,
    dimensions: {
      height: '21 cm',
      width: '14 cm',
      length: '2 cm',
      weight: '350 g',
    },
    ...overrides,
  };
}

test('condición distinta descarta consolidación automática', () => {
  const result = classifyStrictDuplicateItems([
    item({ id: 'MLU1', condition: 'new' }),
    item({ id: 'MLU2', condition: 'used' }),
  ]);
  assert.equal(result.decision, 'no_consolidate');
  assert.deepEqual(result.reasons, ['condition_differs']);
});

test('precio divergente mayor a 20% queda en revisión', () => {
  const result = classifyStrictDuplicateItems([
    item({ id: 'MLU1', price: 1000 }),
    item({ id: 'MLU2', price: 1250 }),
  ]);
  assert.equal(result.decision, 'review');
  assert.ok(result.reasons.includes('price_divergence_gt_20pct'));
  assert.equal(result.evidence.prices.spreadPct, 25);
});

test('diferencia lineal mayor a 20% queda en revisión', () => {
  const result = classifyStrictDuplicateItems([
    item({ id: 'MLU1' }),
    item({ id: 'MLU2', dimensions: {
      height: '26 cm', width: '14 cm', length: '2 cm', weight: '350 g',
    } }),
  ]);
  assert.equal(result.decision, 'review');
  assert.ok(result.reasons.includes('dimensions_divergent'));
  assert.equal(result.evidence.dimensions.comparisons.height.divergent, true);
});

test('peso divergente mayor a 35% queda en revisión', () => {
  const result = classifyStrictDuplicateItems([
    item({ id: 'MLU1', dimensions: {
      height: '21 cm', width: '14 cm', length: '2 cm', weight: '300 g',
    } }),
    item({ id: 'MLU2', dimensions: {
      height: '21 cm', width: '14 cm', length: '2 cm', weight: '420 g',
    } }),
  ]);
  assert.equal(result.decision, 'review');
  assert.equal(result.evidence.dimensions.comparisons.weight.spreadPct, 40);
});

test('medidas equivalentes en unidades distintas se normalizan', () => {
  const result = classifyStrictDuplicateItems([
    item({ id: 'MLU1', dimensions: {
      height: '21 cm', width: '140 mm', length: '2 cm', weight: '0.35 kg',
    } }),
    item({ id: 'MLU2', dimensions: {
      height: '210 mm', width: '14 cm', length: '20 mm', weight: '350 g',
    } }),
  ]);
  assert.equal(result.decision, 'green_candidate');
  assert.deepEqual(result.reasons, []);
});

test('evidencia incompleta nunca se declara verde', () => {
  const result = classifyStrictDuplicateItems([
    item({ id: 'MLU1' }),
    item({ id: 'MLU2', dimensions: null }),
  ]);
  assert.equal(result.decision, 'review');
  assert.ok(result.reasons.includes('dimensions_incomplete'));
});

test('condición, precio y medidas alineadas dan candidato verde', () => {
  const result = classifyStrictDuplicateItems([
    item({ id: 'MLU1', price: 1000 }),
    item({ id: 'MLU2', price: 1150, dimensions: {
      height: '22 cm', width: '14.5 cm', length: '2.1 cm', weight: '400 g',
    } }),
  ]);
  assert.equal(result.decision, 'green_candidate');
  assert.deepEqual(result.reasons, []);
});

test('umbrales quedan congelados y explícitos', () => {
  assert.deepEqual(DUPLICATE_REVIEW_THRESHOLDS, {
    pricePct: 20,
    linearDimensionPct: 20,
    weightPct: 35,
  });
});


test('catalog_product_id aporta evidencia sin cambiar la decisión por sí solo', () => {
  const result = classifyStrictDuplicateItems([
    item({ id: 'MLU1', catalog_listing: false, catalog_product_id: 'MLU-P1' }),
    item({ id: 'MLU2', catalog_listing: true, catalog_product_id: 'MLU-P1' }),
  ]);
  assert.equal(result.decision, 'green_candidate');
  assert.equal(result.evidence.catalogIdentity.sameCatalogProduct, true);
  assert.equal(result.evidence.catalogIdentity.mixedTraditionalCatalog, true);
});

test('señal de catálogo ausente queda como evidencia incompleta, no como inferencia', () => {
  const result = classifyStrictDuplicateItems([
    item({ id: 'MLU1' }),
    item({ id: 'MLU2' }),
  ]);
  assert.equal(result.evidence.catalogIdentity.completeProductIds, false);
  assert.equal(result.evidence.catalogIdentity.mixedTraditionalCatalog, false);
});
