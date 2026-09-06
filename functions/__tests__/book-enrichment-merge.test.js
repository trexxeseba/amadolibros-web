import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyBookEnrichment,
  getBookEnrichmentByIsbn,
  listBookEnrichments,
  mergeFactEnrichment,
} from '../_shared/book-enrichment-registry.js';
import { BOOK_FACT_ENRICHMENTS as B12 } from '../_shared/book-enrichment-facts-b12-lote-01.js';

// Desde que el selector mide huecos sobre la ficha efectiva, un lote vuelve
// sobre ediciones ya investigadas para completarles campos. Esa reincidencia
// COMPLETA, nunca pisa: el dato viejo también se verificó en su momento.

test('la fusión completa huecos y no pisa un dato ya verificado', () => {
  const merged = mergeFactEnrichment(
    { isbn: 'X', facts: { publisher: 'Editorial Vieja' }, provenance: [{ url: 'a', fields: ['publisher'] }] },
    { isbn: 'X', facts: { publisher: 'Editorial Nueva', pages: 320 }, provenance: [{ url: 'b', fields: ['pages'] }] },
  );
  assert.equal(merged.facts.publisher, 'Editorial Vieja');
  assert.equal(merged.facts.pages, 320);
  assert.equal(merged.provenance.length, 2);
});

test('la fusión respeta los campos bibliográficos ya publicados', () => {
  const merged = mergeFactEnrichment(
    { isbn: 'X', facts: { bibliographic: { language: 'Español' } } },
    { isbn: 'X', facts: { bibliographic: { language: 'Inglés', publication_year: '2019' } } },
  );
  assert.equal(merged.facts.bibliographic.language, 'Español');
  assert.equal(merged.facts.bibliographic.publication_year, '2019');
});

test('sin registro previo la fusión devuelve el lote nuevo tal cual', () => {
  const incoming = { isbn: 'X', facts: { pages: 100 } };
  assert.equal(mergeFactEnrichment(null, incoming), incoming);
});

test('la procedencia no se duplica al repetir la misma fuente y campo', () => {
  const source = { url: 'a', fields: ['pages'] };
  const merged = mergeFactEnrichment(
    { isbn: 'X', facts: { pages: 100 }, provenance: [source] },
    { isbn: 'X', facts: { pages: 100 }, provenance: [{ ...source }] },
  );
  assert.equal(merged.provenance.length, 1);
});

test('los 196 ISBN del lote B12 01 quedan en el registro con procedencia', () => {
  assert.equal(B12.length, 196);
  for (const record of B12) {
    const registered = getBookEnrichmentByIsbn(record.isbn);
    assert.ok(registered, record.isbn);
    assert.ok(Array.isArray(registered.provenance) && registered.provenance.length > 0, record.isbn);
  }
});

test('el contador del registry suma sólo los ISBN nuevos, no los fusionados', () => {
  // 1.656 antes del lote + 121 ediciones nuevas (196 menos 75 ya investigadas).
  assert.equal(listBookEnrichments().length, 1777);
});

test('el enriquecimiento no toca datos comerciales de la ficha', () => {
  const item = {
    id: 'MLU1', isbn: B12[0].isbn, price: 990, available_quantity: 3,
    currency_id: 'UYU', status: 'active', permalink: 'https://x.test/a',
  };
  const after = applyBookEnrichment(item);
  assert.equal(after.price, 990);
  assert.equal(after.available_quantity, 3);
  assert.equal(after.currency_id, 'UYU');
  assert.equal(after.permalink, 'https://x.test/a');
});
