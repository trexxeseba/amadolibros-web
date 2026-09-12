import test from 'node:test';
import assert from 'node:assert/strict';

import {
  auditBookEnrichmentCoverage,
  expandCompactIndex,
} from '../../scripts/seo/book-intelligence-coverage-audit.mjs';

const COVERED = '9780008367695';
const PENDING = '9788410515895';

test('la cobertura separa publicaciones, ISBN únicos, duplicados y fichas sin ISBN válido', () => {
  const catalog = {
    updated_at: '2026-08-28T19:37:57.779Z',
    items: [
      { id: 'MLU1', status: 'active', available_quantity: 1, isbn: COVERED },
      { id: 'MLU2', status: 'active', available_quantity: 2, isbn: COVERED },
      { id: 'MLU3', status: 'active', available_quantity: 1, isbn: PENDING },
      { id: 'MLU4', status: 'active', available_quantity: 1, isbn: 'SIN ISBN' },
      { id: 'MLU5', status: 'active', available_quantity: 0, isbn: PENDING },
      { id: 'MLU6', status: 'paused', available_quantity: 3, isbn: PENDING },
    ],
  };

  const report = auditBookEnrichmentCoverage(catalog, {
    enrichedIsbns: [COVERED, '9788490739808'],
    generatedAt: '2026-08-28T20:00:00.000Z',
    source: 'fixture',
  });

  assert.deepEqual(report.inventory, {
    catalog_listings: 6,
    active_sellable_listings: 4,
    active_listings_with_valid_isbn: 3,
    active_listings_without_valid_isbn: 1,
    active_unique_valid_isbns: 2,
    duplicate_active_listings_over_unique_isbn: 1,
  });
  assert.deepEqual(report.coverage, {
    registry_unique_isbns: 2,
    active_enriched_unique_isbns: 1,
    active_pending_unique_isbns: 1,
    active_enriched_listings: 2,
    active_pending_listings_with_valid_isbn: 1,
    active_listings_pending_identity_classification: 1,
    registry_isbns_without_active_listing: 1,
  });
  assert.equal(report.complete, false);
});

test('la auditoría rechaza un catálogo sin items', () => {
  assert.throws(() => auditBookEnrichmentCoverage({}), /falta items/);
});

test('expande el índice activo compacto y conserva sus campos derivados', () => {
  const items = expandCompactIndex({
    fields: ['id', 'title', 'author', 'isbn', 'thumbnail', 'price', 'available_quantity'],
    derived_fields: { status: 'active' },
    items: [['MLU1', 'Libro', 'Autora', COVERED, '/cover.jpg', 1290, 2]],
  });
  assert.deepEqual(items, [{
    id: 'MLU1',
    title: 'Libro',
    author: 'Autora',
    isbn: COVERED,
    thumbnail: '/cover.jpg',
    price: 1290,
    available_quantity: 2,
    status: 'active',
  }]);
});
