import test from 'node:test';
import assert from 'node:assert/strict';

import { titlesCompatible, authorsCompatible } from '../../scripts/seo/book-editorial-cohort-2000.mjs';
import {
  findConsensusPair,
  buildFactsFromConsensus,
  publishableLanguage,
} from '../../scripts/seo/b11-2-resolve-revisar.mjs';
import { BOOK_FACT_ENRICHMENTS as BOOK_FACT_ENRICHMENTS_B11_2_LOTE_01 } from '../_shared/book-enrichment-facts-b11-2-lote-01.js';
import {
  applyBookEnrichment,
  getBookEnrichmentByIsbn,
  listBookEnrichments,
  validateBookEnrichment,
} from '../_shared/book-enrichment-registry.js';

test('B11.2 lote 01 resuelve 12 ISBN del pool REVISAR con consenso cruzado real', () => {
  assert.equal(BOOK_FACT_ENRICHMENTS_B11_2_LOTE_01.length, 12);
  assert.equal(new Set(BOOK_FACT_ENRICHMENTS_B11_2_LOTE_01.map(entry => entry.isbn)).size, 12);
  for (const entry of BOOK_FACT_ENRICHMENTS_B11_2_LOTE_01) {
    assert.equal(validateBookEnrichment(entry), true, entry.isbn);
    assert.equal(getBookEnrichmentByIsbn(entry.isbn), entry);
    for (const source of entry.provenance) {
      assert.match(source.url, /^https:\/\//);
    }
  }
  // El total global sube con cada lote posterior (lote 02 agrega 12 y el
  // lote 03 final, 59).
  assert.equal(listBookEnrichments().length, 1656);
});

test('B11.2 lote 01 no contiene ni modifica títulos o datos comerciales', () => {
  const forbidden = /"(?:title|description|price|available_quantity|stock|slug|canonical|pictures|thumbnail|condition)"\s*:/;
  assert.equal(forbidden.test(JSON.stringify(BOOK_FACT_ENRICHMENTS_B11_2_LOTE_01)), false);

  for (const entry of BOOK_FACT_ENRICHMENTS_B11_2_LOTE_01) {
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

test('findConsensusPair exige acuerdo real, no solo ausencia de datos', () => {
  const compatible = [
    { source: 'google_books', title: 'Oxford Discover Futures Level 5', author: 'Oxford Editor', publisher: null, publication_year: '2021' },
    { source: 'open_library', title: 'Oxford Discover Futures Level 5', author: 'Oxford Editor', publisher: 'Oxford University Press', publication_year: '2021' },
  ];
  assert.ok(findConsensusPair(compatible));

  const conflictingYear = [
    { source: 'google_books', title: 'Misma Obra', author: 'Autor Real', publisher: 'Editorial X', publication_year: '1999' },
    { source: 'open_library', title: 'Misma Obra', author: 'Autor Real', publisher: 'Editorial X', publication_year: '1998' },
  ];
  assert.equal(findConsensusPair(conflictingYear), null);

  const singleSource = [
    { source: 'google_books', title: 'Único Origen', author: 'Autor', publisher: 'Editorial', publication_year: '2020' },
  ];
  assert.equal(findConsensusPair(singleSource), null);
});

test('buildFactsFromConsensus nunca publica un campo con evidencia insuficiente', () => {
  const records = [
    { source: 'google_books', title: 'Obra', author: 'Autor Real', publisher: null, pages: null, language: null, format: null, edition: null, publication_year: '2020' },
    { source: 'open_library', title: 'Obra', author: 'Autor Real', publisher: 'Solo Un Origen', pages: null, language: null, format: null, edition: null, publication_year: '2020' },
  ];
  const { facts } = buildFactsFromConsensus('9780000000002', '2026-09-01', records);
  // "publisher" solo tiene una fuente no oficial: no debe publicarse.
  assert.equal(facts.publisher, undefined);
  // "publication_year" coincide en dos fuentes independientes: sí se publica.
  assert.equal(facts.bibliographic.publication_year, '2020');
});

test('B11.2: applyBookEnrichment publica el hecho aunque el catálogo ya traiga la clave bibliográfica vacía', () => {
  // El catálogo real (atributo de MercadoLibre) trae `bibliographic` con
  // las claves siempre presentes, casi siempre vacías. Reproduce ese
  // detalle exacto: fue la causa de que los 12 hechos de este lote
  // aparecieran como "sin cambios" contra el Preview de PR #305 aunque el
  // registro era válido — un objeto de fixture vacío (`{}`) no lo detectaba.
  for (const entry of BOOK_FACT_ENRICHMENTS_B11_2_LOTE_01) {
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

test('un language multivaluado de la caché de B11.1 no se publica', () => {
  // La caché es inmutable y se generó con el adaptador de BNE que fusionaba
  // MARC 041 $a/$d/$h. El defecto sólo puede aparecer como valor
  // multivaluado: si $a y $h coinciden, la mezcla colapsa a un solo idioma.
  assert.equal(publishableLanguage('Español, Inglés'), false);
  assert.equal(publishableLanguage('Español, dut'), false);
  assert.equal(publishableLanguage('spa, eng'), false);
  assert.equal(publishableLanguage('Español'), true);
  assert.equal(publishableLanguage('spa'), true);
  assert.equal(publishableLanguage(''), false);
  assert.equal(publishableLanguage(null), false);
});

test('buildFactsFromConsensus descarta el language dudoso pero conserva el resto de los hechos', () => {
  const records = [
    { source: 'bne', title: 'Obra', author: 'Autor Real', publisher: 'Acantilado', pages: null, language: 'Español, Inglés', format: null, edition: null, publication_year: '2019', source_url: 'https://catalogo.bne.es/x' },
    { source: 'open_library', title: 'Obra', author: 'Autor Real', publisher: 'Acantilado', pages: null, language: null, format: null, edition: null, publication_year: '2019', source_url: 'https://openlibrary.org/isbn/9780000000003' },
  ];
  const { facts } = buildFactsFromConsensus('9780000000003', '2026-09-02', records);
  assert.equal(facts.bibliographic?.language, undefined);
  assert.equal(facts.publisher, 'Acantilado');
  assert.equal(facts.bibliographic.publication_year, '2019');
});

test('titlesCompatible/authorsCompatible siguen exportadas y estables (dependencia de B11.2)', () => {
  assert.equal(typeof titlesCompatible, 'function');
  assert.equal(typeof authorsCompatible, 'function');
});
