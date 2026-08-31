import test from 'node:test';
import assert from 'node:assert/strict';

import { BOOK_FACT_ENRICHMENTS as BOOK_FACT_ENRICHMENTS_1000 } from '../_shared/book-enrichment-facts-1000.js';
import { BOOK_FACT_ENRICHMENTS as BOOK_FACT_ENRICHMENTS_333 } from '../_shared/book-enrichment-facts-333.js';
import {
  applyBookEnrichment,
  getBookEnrichmentByIsbn,
  listBookEnrichments,
  validateBookEnrichment,
} from '../_shared/book-enrichment-registry.js';
import { renderFeedItem } from '../feed.xml.js';

test('la segunda cohorte contiene exactamente 333 ISBN nuevos y verificables', () => {
  const firstCohort = new Set(BOOK_FACT_ENRICHMENTS_1000.map(entry => entry.isbn));
  assert.equal(BOOK_FACT_ENRICHMENTS_333.length, 333);
  assert.equal(new Set(BOOK_FACT_ENRICHMENTS_333.map(entry => entry.isbn)).size, 333);
  for (const entry of BOOK_FACT_ENRICHMENTS_333) {
    assert.equal(firstCohort.has(entry.isbn), false, `ISBN repetido: ${entry.isbn}`);
    assert.equal(validateBookEnrichment(entry), true, entry.isbn);
    assert.equal(getBookEnrichmentByIsbn(entry.isbn), entry);
  }
  assert.equal(listBookEnrichments().length, 1339);
});

test('las 333 proyecciones no contienen datos comerciales ni sinopsis externas', () => {
  const forbidden = /"(?:price|available_quantity|stock|slug|canonical|pictures|thumbnail|description)"\s*:/;
  assert.equal(forbidden.test(JSON.stringify(BOOK_FACT_ENRICHMENTS_333)), false);

  for (const entry of BOOK_FACT_ENRICHMENTS_333) {
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

test('Merchant conserva páginas verificadas aunque la descripción original supere 5.000 caracteres', () => {
  const xml = renderFeedItem({
    id: 'MLU636632851',
    isbn: '9788478856459',
    title: 'Psicofarmacología y psiquiatría: casos clínicos',
    author: 'Desconocido',
    description: 'Descripción comercial original muy extensa. '.repeat(160),
    publisher: null,
    pages: null,
    price: 1490,
    currency_id: 'UYU',
    status: 'active',
    available_quantity: 1,
    condition: 'new',
  });

  const description = xml.match(/<g:description>([\s\S]*?)<\/g:description>/)?.[1] || '';
  assert.ok(description.length <= 5000);
  assert.match(description, /345 páginas/);
  assert.match(description, /^Descripción comercial original muy extensa\./);
});