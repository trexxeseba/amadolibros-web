import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PAUSED_SEO_COHORT,
  PAUSED_SEO_COHORT_META,
  isPausedProductInSeoCohort,
} from '../_shared/paused-seo-cohort.js';
import { selectPausedSeoCohort } from '../../scripts/seo/generate-paused-cohort.mjs';

function item(overrides = {}) {
  return {
    id: 'MLU1',
    title: 'Libro de prueba con datos reales',
    author: 'Autora de Prueba',
    isbn: '9788410301245',
    status: 'paused',
    available_quantity: 0,
    domain_id: 'MLU-BOOKS',
    thumbnail: 'https://http2.mlstatic.com/D_1-I.jpg',
    pictures: [
      'https://http2.mlstatic.com/D_1-O.jpg',
      'https://http2.mlstatic.com/D_2-O.jpg',
    ],
    catalog_listing: true,
    catalog_product_id: 'MLU-CATALOG-1',
    bibliographic: {
      language: 'Español',
      publication_year: '2024',
    },
    ...overrides,
  };
}

test('la cohorte publicada contiene exactamente 500 ediciones únicas y auditables', () => {
  assert.equal(PAUSED_SEO_COHORT.length, 500);
  assert.equal(new Set(PAUSED_SEO_COHORT.map(entry => entry.id)).size, 500);
  assert.equal(new Set(PAUSED_SEO_COHORT.map(entry => entry.isbn)).size, 500);
  assert.ok(PAUSED_SEO_COHORT.every(entry => /^MLU\d+$/.test(entry.id)));
  assert.ok(PAUSED_SEO_COHORT.every(entry => /^(978|979)\d{10}$/.test(entry.isbn)));
  assert.equal(PAUSED_SEO_COHORT_META.historicalSelected, 130);
  assert.equal(PAUSED_SEO_COHORT_META.qualityFillSelected, 370);
  assert.equal(PAUSED_SEO_COHORT_META.fallbackSelected, 0);
  assert.equal(PAUSED_SEO_COHORT_META.historicalImpressions, 754);
  assert.equal(PAUSED_SEO_COHORT_META.historicalClicks, 52);
});

test('la consulta de pertenencia normaliza el ID y no abre IDs ajenos', () => {
  const selected = PAUSED_SEO_COHORT[0].id;
  assert.equal(isPausedProductInSeoCohort(selected.toLowerCase()), true);
  assert.equal(isPausedProductInSeoCohort('MLU999999999'), false);
  assert.equal(isPausedProductInSeoCohort(null), false);
});

test('el generador conserva la URL con demanda, deduplica ISBN y excluye equivalentes activos', () => {
  const catalogItems = [
    item({
      id: 'MLU10',
      isbn: '9789876282703',
      status: 'active',
      available_quantity: 2,
      catalog_product_id: 'MLU-ACTIVE',
    }),
    item({ id: 'MLU20', isbn: '9789878629933', catalog_product_id: 'MLU-PAUSED-A' }),
    item({ id: 'MLU21', isbn: '9789878629933', catalog_product_id: 'MLU-PAUSED-B' }),
    item({ id: 'MLU30', isbn: '9788410301245', catalog_product_id: 'MLU-PAUSED-C' }),
    item({ id: 'MLU40', isbn: '9789876282703', catalog_product_id: 'MLU-PAUSED-D' }),
  ];
  const gscRows = [{
    keys: ['https://www.amadolibros.com/libro/MLU21/libro-con-demanda'],
    impressions: 12,
    clicks: 3,
    position: 7,
  }];

  const result = selectPausedSeoCohort({ catalogItems, gscRows, limit: 2 });
  assert.deepEqual(result.selected.map(candidate => candidate.item.id), ['MLU21', 'MLU30']);
  assert.equal(result.stats.historicalSelected, 1);
  assert.equal(result.stats.qualityFillSelected, 1);
  assert.equal(result.stats.rejectionCounts.activeEquivalent, 1);
});
