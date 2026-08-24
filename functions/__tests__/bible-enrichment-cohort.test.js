import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBibleEnrichmentCohort } from '../../scripts/seo/bible-enrichment-cohort.mjs';

const classifications = {
  MLU1: ['religion-espiritualidad', 'biblia'],
  MLU2: ['religion-espiritualidad', 'biblia'],
  MLU3: ['religion-espiritualidad', 'reina-valera'],
  MLU4: ['religion-espiritualidad', 'biblia'],
  MLU5: ['otros-libros'],
};

const base = {
  status: 'active',
  available_quantity: 1,
  description: '',
};

test('consolida publicaciones por ISBN y genera estados accionables', () => {
  const report = buildBibleEnrichmentCohort({
    classifications,
    catalogItems: [
      { ...base, id: 'MLU1', isbn: '9788490739808', title: 'Palabra de Vida', available_quantity: 5 },
      { ...base, id: 'MLU2', isbn: '978-84-9073-980-8', title: 'Duplicado', available_quantity: 2 },
      { ...base, id: 'MLU3', isbn: '9781087701400', title: 'RVR cronológica' },
      { ...base, id: 'MLU4', isbn: '9788428510448', title: 'Con descripción', description: 'x'.repeat(100) },
      { ...base, id: 'MLU5', isbn: '9789508619778', title: 'Fuera del vertical' },
    ],
    enrichments: [{ isbn: '9788490739808' }],
  });

  assert.deepEqual(report.metrics, {
    active_listings: 4,
    unique_isbn_editions: 3,
    listings_without_valid_isbn: 0,
    enriched_verified: 1,
    research_external: 1,
    review_catalog_description: 1,
  });
  const enriched = report.editions.find(row => row.isbn === '9788490739808');
  assert.equal(enriched.active_listings, 2);
  assert.equal(enriched.total_stock, 7);
  assert.deepEqual(enriched.listing_ids, ['MLU1', 'MLU2']);
  assert.equal(enriched.status, 'enriched_verified');
  assert.equal(report.editions[0].isbn, '9781087701400', 'Reina-Valera sin descripción debe priorizarse');
});

test('omite pausados, ISBN inválidos y clasificaciones ajenas', () => {
  const report = buildBibleEnrichmentCohort({
    classifications: {
      MLU1: ['biblia'],
      MLU2: ['biblia'],
      MLU3: ['otros-libros'],
    },
    catalogItems: [
      { ...base, id: 'MLU1', isbn: '', title: 'Sin ISBN' },
      { ...base, id: 'MLU2', isbn: '9788490739808', title: 'Pausado', status: 'paused' },
      { ...base, id: 'MLU3', isbn: '9788490739808', title: 'Otra categoría' },
    ],
    enrichments: [],
  });

  assert.equal(report.metrics.active_listings, 1);
  assert.equal(report.metrics.unique_isbn_editions, 0);
  assert.equal(report.metrics.listings_without_valid_isbn, 1);
});
