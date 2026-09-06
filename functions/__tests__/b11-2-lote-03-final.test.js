import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { BOOK_FACT_ENRICHMENTS as BOOK_FACT_ENRICHMENTS_B11_2_LOTE_01 } from '../_shared/book-enrichment-facts-b11-2-lote-01.js';
import { BOOK_FACT_ENRICHMENTS as BOOK_FACT_ENRICHMENTS_B11_2_LOTE_02 } from '../_shared/book-enrichment-facts-b11-2-lote-02.js';
import { BOOK_FACT_ENRICHMENTS as BOOK_FACT_ENRICHMENTS_B11_2_LOTE_03 } from '../_shared/book-enrichment-facts-b11-2-lote-03.js';
import { normalizeValidIsbn } from '../_shared/showcase-ranking.js';
import {
  applyBookEnrichment,
  getBookEnrichmentByIsbn,
  listBookEnrichments,
  validateBookEnrichment,
} from '../_shared/book-enrichment-registry.js';

const state = JSON.parse(readFileSync('artifacts/b11-2/state.json', 'utf8'));

test('B11.2 lote 03 final resuelve 59 ISBN del pool REVISAR con consenso cruzado real', () => {
  assert.equal(BOOK_FACT_ENRICHMENTS_B11_2_LOTE_03.length, 59);
  assert.equal(new Set(BOOK_FACT_ENRICHMENTS_B11_2_LOTE_03.map(entry => entry.isbn)).size, 59);
  for (const entry of BOOK_FACT_ENRICHMENTS_B11_2_LOTE_03) {
    assert.equal(validateBookEnrichment(entry), true, entry.isbn);
    assert.equal(getBookEnrichmentByIsbn(entry.isbn), entry);
    assert.equal(entry.decision, 'auto_publish_facts', entry.isbn);
    for (const source of entry.provenance) {
      assert.match(source.url, /^https:\/\//);
    }
  }
  assert.equal(listBookEnrichments().length, 1656);
});

test('B11.2 lote 03 no repite ningún ISBN de los lotes 01 y 02', () => {
  const anteriores = new Set([
    ...BOOK_FACT_ENRICHMENTS_B11_2_LOTE_01.map(entry => entry.isbn),
    ...BOOK_FACT_ENRICHMENTS_B11_2_LOTE_02.map(entry => entry.isbn),
  ]);
  for (const entry of BOOK_FACT_ENRICHMENTS_B11_2_LOTE_03) {
    assert.equal(anteriores.has(entry.isbn), false, entry.isbn);
  }
});

test('B11.2 lote 03 final agota el pool REVISAR: los 556 ISBN quedan con estado persistente', () => {
  const entries = Object.values(state.entries);
  assert.equal(entries.length, 556);

  const porStatus = entries.reduce((acc, entry) => {
    acc[entry.status] = (acc[entry.status] || 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(porStatus, { REVISAR: 442, TERMINADO: 83, SIN_DATOS: 31 });

  const porLote = entries.reduce((acc, entry) => {
    acc[entry.batch] = (acc[entry.batch] || 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(porLote, { 'b11-2-lote-01': 100, 'b11-2-lote-02': 100, 'lote-03-final': 356 });

  // La garantía real del lote final: no queda ningún ISBN REVISAR de B11.1
  // sin haber sido intentado al menos una vez. El circuito automático se
  // agotó — avanzar más exige evidencia nueva, no otra corrida del resolver.
  const report = JSON.parse(readFileSync('artifacts/book-intelligence/lote-01/isbn-1000-report.json', 'utf8'));
  const revisarDeB11_1 = [...new Set(
    report.results
      .filter(result => result.publication_class === 'REVIEW')
      .map(result => normalizeValidIsbn(result.isbn))
      .filter(Boolean),
  )];
  assert.equal(revisarDeB11_1.length, 556);
  const sinIntentar = revisarDeB11_1.filter(isbn => !state.entries[isbn]);
  assert.deepEqual(sinIntentar, []);
});

test('B11.2 lote 03: los TERMINADO del estado son exactamente los ISBN integrados al registry', () => {
  const terminadosDelLote = Object.entries(state.entries)
    .filter(([, entry]) => entry.status === 'TERMINADO' && entry.batch === 'lote-03-final')
    .map(([isbn]) => isbn)
    .sort();
  const integrados = BOOK_FACT_ENRICHMENTS_B11_2_LOTE_03.map(entry => entry.isbn).sort();
  assert.deepEqual(terminadosDelLote, integrados);

  // Ni un SIN_DATOS ni un REVISAR se coló al registry.
  for (const [isbn, entry] of Object.entries(state.entries)) {
    if (entry.status === 'TERMINADO') continue;
    assert.equal(integrados.includes(isbn), false, isbn);
  }
});

test('B11.2 lote 03 no publica ningún language derivado de la caché contaminada', () => {
  // Los 8 valores que salían de MARC 041 con $a/$d/$h fusionados ("Español,
  // Inglés" para libros enteramente en español) ya no se publican. El
  // adaptador se corrigió para leer sólo 041$a, pero la caché de B11.1 es
  // inmutable, así que el resolver además descarta cualquier language
  // multivaluado que venga de ella.
  const conLanguage = BOOK_FACT_ENRICHMENTS_B11_2_LOTE_03
    .filter(entry => entry.facts.bibliographic?.language);
  assert.deepEqual(conLanguage.map(entry => entry.isbn), []);

  // Ningún código crudo puede aparecer en un dato visible, venga del campo
  // que venga.
  const visible = JSON.stringify(BOOK_FACT_ENRICHMENTS_B11_2_LOTE_03.map(entry => entry.facts));
  for (const code of ['dut', 'eng', 'spa', 'fre', 'ger', 'ita', 'cat']) {
    assert.equal(new RegExp(`"${code}"`, 'i').test(visible), false, code);
  }
});

test('los 8 ISBN que perdieron el language conservan editorial y año', () => {
  const afectados = [
    '9788417346935', '9788417804985', '9788423362264', '9788433029102',
    '9788433031143', '9788441542969', '9788478847440', '9788499083957',
  ];
  const porIsbn = new Map(BOOK_FACT_ENRICHMENTS_B11_2_LOTE_03.map(entry => [entry.isbn, entry]));
  for (const isbn of afectados) {
    const entry = porIsbn.get(isbn);
    assert.ok(entry, `${isbn} debe seguir integrado al registry`);
    assert.equal(typeof entry.facts.publisher, 'string', isbn);
    assert.match(entry.facts.bibliographic.publication_year, /^\d{4}$/, isbn);
    assert.equal(entry.facts.bibliographic.language, undefined, isbn);
  }
});

test('B11.2 lote 03 no contiene ni modifica títulos o datos comerciales', () => {
  const forbidden = /"(?:title|description|price|available_quantity|stock|slug|canonical|pictures|thumbnail|condition)"\s*:/;
  assert.equal(forbidden.test(JSON.stringify(BOOK_FACT_ENRICHMENTS_B11_2_LOTE_03)), false);

  for (const entry of BOOK_FACT_ENRICHMENTS_B11_2_LOTE_03) {
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
    assert.equal(enriched.currency_id, original.currency_id, entry.isbn);
    assert.equal(enriched.available_quantity, original.available_quantity, entry.isbn);
    assert.equal(enriched.condition, original.condition, entry.isbn);
    assert.equal(enriched.canonical, original.canonical, entry.isbn);
    assert.deepEqual(enriched.pictures, original.pictures, entry.isbn);
  }
});

test('B11.2 lote 03: applyBookEnrichment publica el hecho aunque el catálogo traiga la clave bibliográfica vacía', () => {
  for (const entry of BOOK_FACT_ENRICHMENTS_B11_2_LOTE_03) {
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
