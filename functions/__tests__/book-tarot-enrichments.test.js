import test from 'node:test';
import assert from 'node:assert/strict';

import { BOOK_TAROT_ENRICHMENTS } from '../_shared/book-tarot-enrichments.js';
import { getBookEnrichmentByIsbn, validateBookEnrichment } from '../_shared/book-enrichment-registry.js';
import { buildFeedDescription } from '../feed.xml.js';

test('cada ficha de tarot es válida, tiene fuente oficial y copy sin restricciones', () => {
  const isbns = new Set();
  for (const record of BOOK_TAROT_ENRICHMENTS) {
    assert.equal(validateBookEnrichment(record), true, record.isbn);
    assert.equal(isbns.has(record.isbn), false, record.isbn);
    isbns.add(record.isbn);
    assert.ok(record.provenance.some(source => source.type === 'publisher'), record.isbn);
    const copy = JSON.stringify(record.editorial);
    assert.doesNotMatch(copy, /únicamente|\bs[oó]lo\b|solamente/i, record.isbn);
    assert.ok(record.editorial.merchant_description.length >= 250, record.isbn);
    const meta = record.editorial.meta_description.length;
    assert.ok(meta >= 80 && meta <= 170, `${record.isbn}: meta ${meta}`);
  }
});

test('el feed de Merchant usa la descripción editorial del mazo y conserva hechos previos', () => {
  for (const record of BOOK_TAROT_ENRICHMENTS) {
    const description = buildFeedDescription({ isbn: record.isbn, title: 'Título comercial', condition: 'new' });
    assert.equal(description, record.editorial.merchant_description, record.isbn);
    assert.doesNotMatch(description, /^Libro "/, record.isbn);
    const registered = getBookEnrichmentByIsbn(record.isbn);
    assert.ok(registered.provenance.length >= record.provenance.length, record.isbn);
  }
});
