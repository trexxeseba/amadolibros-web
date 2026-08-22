import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyMlCatalogOrigin,
  summarizeMlOrigins,
} from '../../scripts/seo/duplication-report.mjs';

function item(overrides = {}) {
  return {
    id: 'MLU1',
    catalog_listing: null,
    catalog_product_id: null,
    ...overrides,
  };
}

test('clasifica publicación común + catálogo cuando comparten catalog_product_id', () => {
  const result = classifyMlCatalogOrigin([
    item({ id: 'MLU1', catalog_listing: false, catalog_product_id: 'MLU-PROD-1' }),
    item({ id: 'MLU2', catalog_listing: true, catalog_product_id: 'mlu-prod-1' }),
  ]);
  assert.equal(result.origin, 'ml_common_plus_catalog');
  assert.deepEqual(result.catalogProductIds, ['MLU-PROD-1']);
  assert.deepEqual(result.catalogListingValues, [false, true]);
});

test('mismo catalog_product_id sin mezcla común/catálogo queda separado', () => {
  const result = classifyMlCatalogOrigin([
    item({ id: 'MLU1', catalog_listing: true, catalog_product_id: 'MLU-PROD-1' }),
    item({ id: 'MLU2', catalog_listing: true, catalog_product_id: 'MLU-PROD-1' }),
  ]);
  assert.equal(result.origin, 'same_ml_catalog_product');
});

test('catalog_product_id distintos se marcan como conflicto', () => {
  const result = classifyMlCatalogOrigin([
    item({ id: 'MLU1', catalog_listing: false, catalog_product_id: 'MLU-PROD-1' }),
    item({ id: 'MLU2', catalog_listing: true, catalog_product_id: 'MLU-PROD-2' }),
  ]);
  assert.equal(result.origin, 'catalog_product_conflict');
});

test('catalog_product_id presente sólo en parte del grupo se marca parcial', () => {
  const result = classifyMlCatalogOrigin([
    item({ id: 'MLU1', catalog_listing: false, catalog_product_id: 'MLU-PROD-1' }),
    item({ id: 'MLU2', catalog_listing: null, catalog_product_id: null }),
  ]);
  assert.equal(result.origin, 'catalog_product_partial');
});

test('catalog_listing true sin product id no se interpreta como identidad suficiente', () => {
  const result = classifyMlCatalogOrigin([
    item({ id: 'MLU1', catalog_listing: true }),
    item({ id: 'MLU2', catalog_listing: false }),
  ]);
  assert.equal(result.origin, 'catalog_listing_without_product_id');
});

test('summarizeMlOrigins calcula porcentajes sobre el universo auditado', () => {
  const groups = [
    { mlCatalogIdentity: { origin: 'ml_common_plus_catalog' } },
    { mlCatalogIdentity: { origin: 'same_ml_catalog_product' } },
    { mlCatalogIdentity: { origin: 'bibliographic_only' } },
    { mlCatalogIdentity: { origin: 'catalog_product_conflict' } },
  ];
  const summary = summarizeMlOrigins(groups);
  assert.equal(summary.totalGroups, 4);
  assert.equal(summary.mlIdentityExplainedGroups, 2);
  assert.equal(summary.mlIdentityExplainedPct, 50);
  assert.equal(summary.mlCommonPlusCatalogPct, 25);
});
