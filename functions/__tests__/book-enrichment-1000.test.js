import test from 'node:test';
import assert from 'node:assert/strict';

import { BOOK_FACT_ENRICHMENTS } from '../_shared/book-enrichment-facts-1000.js';
import {
  applyBookEnrichment,
  getBookEnrichmentByIsbn,
  validateBookEnrichment,
} from '../_shared/book-enrichment-registry.js';

// La fusión de lotes hace que el registry devuelva un objeto COMBINADO, no el
// del módulo: un lote posterior puede completarle campos a la misma edición.
// Lo que hay que garantizar es que ningún hecho del lote se perdió ni cambió.
function conservaLosHechos(resolved, entry) {
  for (const [field, value] of Object.entries(entry.facts || {})) {
    if (field === 'bibliographic') {
      for (const [key, bibValue] of Object.entries(value || {})) {
        assert.deepEqual(resolved.facts.bibliographic[key], bibValue, `${entry.isbn}.${key}`);
      }
      continue;
    }
    assert.deepEqual(resolved.facts[field], value, `${entry.isbn}.${field}`);
  }
}


const EDITORIAL_UPGRADE_ISBN = '9791388034435';

test('el lote publicado contiene exactamente 1.000 ISBN únicos y verificables', () => {
  assert.equal(BOOK_FACT_ENRICHMENTS.length, 1000);
  assert.equal(new Set(BOOK_FACT_ENRICHMENTS.map(entry => entry.isbn)).size, 1000);
  for (const entry of BOOK_FACT_ENRICHMENTS) {
    assert.equal(validateBookEnrichment(entry), true, entry.isbn);
    const resolved = getBookEnrichmentByIsbn(entry.isbn);
    if (entry.isbn === EDITORIAL_UPGRADE_ISBN) {
      assert.equal(resolved.decision, 'auto_publish');
      assert.equal(resolved.editorial.quality_level, 'editorial_real_v1');
    } else {
      conservaLosHechos(resolved, entry);
    }
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
    if (entry.isbn === EDITORIAL_UPGRADE_ISBN) {
      assert.notEqual(enriched.description, original.description, entry.isbn);
      assert.match(enriched.description, /coloreando números y zonas según un código de color/i);
      assert.equal(enriched._amadoEnrichmentLevel, 'editorial_real');
    } else {
      assert.equal(enriched.description, original.description, entry.isbn);
    }
    assert.equal(enriched.price, original.price, entry.isbn);
    assert.equal(enriched.available_quantity, original.available_quantity, entry.isbn);
    assert.equal(enriched.condition, original.condition, entry.isbn);
    assert.equal(enriched.canonical, original.canonical, entry.isbn);
    assert.deepEqual(enriched.pictures, original.pictures, entry.isbn);
  }
});