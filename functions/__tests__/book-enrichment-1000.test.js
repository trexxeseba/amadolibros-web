import test from 'node:test';
import assert from 'node:assert/strict';

import { BOOK_FACT_ENRICHMENTS } from '../_shared/book-enrichment-facts-1000.js';
import {
  applyBookEnrichment,
  getBookEnrichmentByIsbn,
  validateBookEnrichment,
} from '../_shared/book-enrichment-registry.js';

test('el lote publicado contiene exactamente 1.000 ISBN únicos y verificables', () => {
  assert.equal(BOOK_FACT_ENRICHMENTS.length, 1000);
  assert.equal(new Set(BOOK_FACT_ENRICHMENTS.map(entry => entry.isbn)).size, 1000);
  for (const entry of BOOK_FACT_ENRICHMENTS) {
    assert.equal(validateBookEnrichment(entry), true, entry.isbn);
    assert.equal(getBookEnrichmentByIsbn(entry.isbn), entry);
  }
});

test('las 1.000 proyecciones mejoran la ficha sin datos comerciales ni sinopsis externa', () => {
  const forbidden = /"(?:price|available_quantity|stock|slug|canonical|pictures|thumbnail|description)"\s*:/;
  assert.equal(forbidden.test(JSON.stringify(BOOK_FACT_ENRICHMENTS)), false);

  for (const entry of BOOK_FACT_ENRICHMENTS) {
    const original = {
      id: entry.sample_listing_id || 'MLU999999999',
      isbn: entry.isbn,
      title: `Título original ${entry.isbn}`,
      author: 'Desconocido',
      description: '',
      publisher: null,
      pages: null,
      price: 1490,
      currency_id: 'UYU',
      status: 'active',
      available_quantity: 2,
      condition: 'new',
      pictures: [{ url: 'https://example.com/portada.jpg' }],
      canonical: `/libro/${entry.sample_listing_id || 'MLU999999999'}/titulo-original`,
    };
    const enriched = applyBookEnrichment(original);
    assert.notEqual(enriched, original, entry.isbn);
    assert.equal(enriched.title, original.title, entry.isbn);
    assert.equal(enriched.description, original.description, entry.isbn);
    assert.equal(enriched.price, original.price, entry.isbn);
    assert.equal(enriched.available_quantity, original.available_quantity, entry.isbn);
    assert.equal(enriched.condition, original.condition, entry.isbn);
    assert.equal(enriched.canonical, original.canonical, entry.isbn);
    assert.deepEqual(enriched.pictures, original.pictures, entry.isbn);
  }
});
