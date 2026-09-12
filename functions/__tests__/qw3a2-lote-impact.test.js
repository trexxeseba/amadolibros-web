import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { BOOK_FACT_ENRICHMENTS as LOTE } from '../_shared/book-enrichment-facts-qw3a2-lote-01.js';
import { getBookEnrichmentByIsbn } from '../_shared/book-enrichment-registry.js';
import {
  existingFact,
  gainedFields,
  summarizeGains,
  withoutLoteFacts,
} from '../../scripts/seo/qw3a2-lote-impact.mjs';

// Revisión de Astra: las mejoras se miden sobre el catálogo EFECTIVO, así que
// un dato que la ficha ya publicaba no puede volver a contarse como ganancia.

test('el lote queda registrado y sus hechos llegan a la ficha', () => {
  assert.ok(LOTE.length > 0);
  for (const record of LOTE) {
    assert.equal(getBookEnrichmentByIsbn(record.isbn)?.isbn, record.isbn);
  }
});

test('cada hecho publicado declara su fuente', () => {
  for (const record of LOTE) {
    assert.ok(Array.isArray(record.provenance) && record.provenance.length > 0, record.isbn);
    for (const source of record.provenance) {
      assert.ok(source.provider, record.isbn);
      assert.ok(source.url, record.isbn);
      assert.equal(source.relationship, 'exact_edition', record.isbn);
    }
  }
});

test('un campo que la ficha ya publicaba no cuenta como mejora', () => {
  const after = { publisher: 'Editorial Real', pages: 320, bibliographic: {} };
  const record = { facts: { publisher: 'Editorial Real' } };
  const before = withoutLoteFacts(after, record);
  // `pages` ya venía del catálogo: sigue presente en el "antes".
  assert.equal(existingFact(before, 'pages'), 320);
  assert.deepEqual(gainedFields(before, after), ['publisher']);
});

test('un campo bibliográfico aportado por el lote sí cuenta', () => {
  const after = { bibliographic: { publication_year: '2022' } };
  const before = withoutLoteFacts(after, { facts: { bibliographic: { publication_year: '2022' } } });
  assert.equal(existingFact(before, 'publication_year'), null);
  assert.deepEqual(gainedFields(before, after), ['publication_year']);
});

test('el resumen separa sin mejora, >=1 dato y >=3 datos', () => {
  const summary = summarizeGains([
    { gained: [] },
    { gained: ['publisher'] },
    { gained: ['publisher', 'pages'] },
    { gained: ['publisher', 'pages', 'publication_year'] },
  ]);
  assert.equal(summary.buckets.sin_mejora, 1);
  assert.equal(summary.buckets.al_menos_1, 3);
  assert.equal(summary.buckets.al_menos_3, 1);
  assert.equal(summary.porCampo.publisher, 3);
});

test('el medidor es de solo lectura y no toca datos comerciales', () => {
  const source = readFileSync('scripts/seo/qw3a2-lote-impact.mjs', 'utf8');
  assert.doesNotMatch(source, /method\s*:\s*['"](?:POST|PATCH|PUT|DELETE)['"]/i);
  const serialized = JSON.stringify(LOTE);
  for (const forbidden of ['"price"', '"available_quantity"', '"canonical"', '"currency_id"']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
