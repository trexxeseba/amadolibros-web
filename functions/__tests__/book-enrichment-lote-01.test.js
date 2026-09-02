import test from 'node:test';
import assert from 'node:assert/strict';

import { BOOK_FACT_ENRICHMENTS as BOOK_FACT_ENRICHMENTS_1000 } from '../_shared/book-enrichment-facts-1000.js';
import { BOOK_FACT_ENRICHMENTS as BOOK_FACT_ENRICHMENTS_333 } from '../_shared/book-enrichment-facts-333.js';
import { BOOK_FACT_ENRICHMENTS as BOOK_FACT_ENRICHMENTS_LOTE_01 } from '../_shared/book-enrichment-facts-lote-01.js';
import {
  applyBookEnrichment,
  getBookEnrichmentByIsbn,
  listBookEnrichments,
  validateBookEnrichment,
} from '../_shared/book-enrichment-registry.js';

test('el lote 01 incorpora 187 ISBN nuevos con evidencia verificable', () => {
  // Dos corridas acumuladas del workflow b11-batch-research.yml: 19 ISBN
  // (Google Books sin cuota, solo BNE/Open Library) + 168 ISBN (Google
  // Books corregido, presupuesto ampliado al universo elegible completo).
  const previous = new Set([
    ...BOOK_FACT_ENRICHMENTS_1000,
    ...BOOK_FACT_ENRICHMENTS_333,
  ].map(entry => entry.isbn));

  assert.equal(BOOK_FACT_ENRICHMENTS_LOTE_01.length, 187);
  assert.equal(new Set(BOOK_FACT_ENRICHMENTS_LOTE_01.map(entry => entry.isbn)).size, 187);
  for (const entry of BOOK_FACT_ENRICHMENTS_LOTE_01) {
    assert.equal(previous.has(entry.isbn), false, `ISBN repetido: ${entry.isbn}`);
    assert.equal(validateBookEnrichment(entry), true, entry.isbn);
    assert.equal(getBookEnrichmentByIsbn(entry.isbn), entry);
  }
  // El total global sube con cada lote posterior (B11.2 lote 01 + lote 02 agregan 24 más).
  assert.equal(listBookEnrichments().length, 1550);
});

test('el lote 01 no contiene ni modifica títulos o datos comerciales', () => {
  const forbidden = /"(?:title|description|price|available_quantity|stock|slug|canonical|pictures|thumbnail|condition)"\s*:/;
  assert.equal(forbidden.test(JSON.stringify(BOOK_FACT_ENRICHMENTS_LOTE_01)), false);

  for (const entry of BOOK_FACT_ENRICHMENTS_LOTE_01) {
    const original = {
      id: entry.sample_listing_id || 'MLU999999999',
      isbn: entry.isbn,
      title: `Título original ${entry.isbn}`,
      author: 'Desconocido',
      description: 'Descripción comercial original.',
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
