import test from 'node:test';
import assert from 'node:assert/strict';

import { BOOK_FACT_ENRICHMENTS as BOOK_FACT_ENRICHMENTS_B11_2_LOTE_02 } from '../_shared/book-enrichment-facts-b11-2-lote-02.js';
import {
  applyBookEnrichment,
  getBookEnrichmentByIsbn,
  listBookEnrichments,
  validateBookEnrichment,
} from '../_shared/book-enrichment-registry.js';

test('B11.2 lote 02 resuelve 12 ISBN nuevos del pool REVISAR con consenso cruzado real', () => {
  assert.equal(BOOK_FACT_ENRICHMENTS_B11_2_LOTE_02.length, 12);
  assert.equal(new Set(BOOK_FACT_ENRICHMENTS_B11_2_LOTE_02.map(entry => entry.isbn)).size, 12);
  for (const entry of BOOK_FACT_ENRICHMENTS_B11_2_LOTE_02) {
    assert.equal(validateBookEnrichment(entry), true, entry.isbn);
    assert.equal(getBookEnrichmentByIsbn(entry.isbn), entry);
    for (const source of entry.provenance) {
      assert.match(source.url, /^https:\/\//);
    }
  }
  assert.equal(listBookEnrichments().length, 1777);
});

test('B11.2 lote 02 no repite ningún ISBN ya resuelto en el lote 01', () => {
  // Regresión directa del bug encontrado antes de correr este lote: el
  // filtro de candidatos sólo excluía TERMINADO, así que sin el fix
  // hubiera vuelto a intentar los mismos 87 REVISAR + 1 SIN_DATOS del
  // lote 01 (misma evidencia, mismo resultado) en vez de avanzar sobre
  // ISBN nunca antes intentados.
  const isbnsLote02 = new Set(BOOK_FACT_ENRICHMENTS_B11_2_LOTE_02.map(entry => entry.isbn));
  const known = ['9780194114226', '9781316627686', '9781640951877'];
  for (const isbn of known) {
    assert.equal(isbnsLote02.has(isbn), false, isbn);
  }
});

test('B11.2 lote 02 no contiene ni modifica títulos o datos comerciales', () => {
  const forbidden = /"(?:title|description|price|available_quantity|stock|slug|canonical|pictures|thumbnail|condition)"\s*:/;
  assert.equal(forbidden.test(JSON.stringify(BOOK_FACT_ENRICHMENTS_B11_2_LOTE_02)), false);

  for (const entry of BOOK_FACT_ENRICHMENTS_B11_2_LOTE_02) {
    const original = {
      id: entry.sample_listing_id || 'MLU999999999',
      isbn: entry.isbn,
      title: `Título original ${entry.isbn}`,
      author: 'Desconocido',
      description: 'Descripción comercial original.',
      publisher: null,
      pages: null,
      price: 990,
      currency_id: 'UYU',
      status: 'active',
      available_quantity: 3,
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

test('B11.2 lote 02: applyBookEnrichment publica el hecho aunque el catálogo ya traiga la clave bibliográfica vacía', () => {
  for (const entry of BOOK_FACT_ENRICHMENTS_B11_2_LOTE_02) {
    const original = {
      id: entry.sample_listing_id || 'MLU999999999',
      isbn: entry.isbn,
      title: `Título original ${entry.isbn}`,
      author: 'Desconocido',
      publisher: '',
      pages: null,
      bibliographic: { language: '', format: '', edition: '', publication_year: '' },
      status: 'active',
    };
    const enriched = applyBookEnrichment(original);
    for (const [field, value] of Object.entries(entry.facts.bibliographic || {})) {
      assert.equal(enriched.bibliographic[field], value, `${entry.isbn}.${field}`);
    }
  }
});
