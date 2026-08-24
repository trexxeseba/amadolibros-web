import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyBookEnrichment,
  getBookEnrichmentByIsbn,
  listBookEnrichments,
  validateBookEnrichment,
} from '../_shared/book-enrichment-registry.js';
import { buildAutomaticProductShowcase } from '../_shared/automatic-product-showcase.js';
import { enrichAutomaticProductShowcaseHtml } from '../libro/_middleware.js';
import { renderPage } from '../libro/[[path]].js';
import { buildFeedDescription, renderFeedItem } from '../feed.xml.js';

const RAW_ITEM = Object.freeze({
  id: 'MLU724888358',
  title: 'La Biblia Palabra De Vida - Verbo Divino',
  author: 'Desconocido',
  isbn: '9788490739808',
  publisher: null,
  pages: null,
  description: '',
  price: 1950,
  currency: 'UYU',
  status: 'active',
  available_quantity: 5,
  condition: 'new',
  pictures: ['https://http2.mlstatic.com/D_123-O.jpg'],
  thumbnail: 'https://http2.mlstatic.com/D_123-I.jpg',
  bibliographic: { language: 'Español' },
});

test('el registro sólo contiene entradas publicables con fuente oficial e ISBN exacto', () => {
  const entries = listBookEnrichments();
  assert.ok(entries.length >= 6);
  for (const entry of entries) assert.equal(validateBookEnrichment(entry), true);
});

test('el primer lote incluye dos Reina-Valera de alta prioridad con datos oficiales', () => {
  const woman = getBookEnrichmentByIsbn('9780825456459');
  assert.equal(woman.facts.publisher, 'Editorial Portavoz');
  assert.equal(woman.facts.pages, 1680);
  assert.equal(woman.schema.bookEdition, 'Reina-Valera 1960');

  const fisher = getBookEnrichmentByIsbn('9781535908160');
  assert.equal(fisher.facts.publisher, 'B&H Publishing Group');
  assert.equal(fisher.facts.pages, 1320);
  assert.match(fisher.editorial.decision_copy, /letra grande/i);
});

test('el lote suma tres Reina-Valera B&H con ISBN y edición exactos', () => {
  const expected = [
    ['9781087701417', 1424, /cronológica/i],
    ['9781430091899', 1728, /14 puntos/i],
    ['9781535998000', 1792, /365 devocionales/i],
  ];
  for (const [isbn, pages, signal] of expected) {
    const entry = getBookEnrichmentByIsbn(isbn);
    assert.equal(entry.facts.publisher, 'B&H Español');
    assert.equal(entry.facts.pages, pages);
    assert.match(entry.editorial.paragraphs.join(' '), signal);
    assert.ok(entry.provenance.some(source => source.type === 'publisher' && source.isbn === isbn));
  }
});

test('la edición 9788490739808 tiene procedencia editorial verificable', () => {
  const entry = getBookEnrichmentByIsbn('978-84-9073-980-8');
  assert.equal(entry.isbn, '9788490739808');
  assert.ok(entry.provenance.some(source =>
    source.type === 'publisher' &&
    source.relationship === 'exact_edition' &&
    source.url === 'https://verbodivino.es/Libro/6735/la-biblia-palabra-de-vida'));
});

test('aplica sólo datos editoriales y preserva íntegros los datos comerciales', () => {
  const enriched = applyBookEnrichment(RAW_ITEM);
  assert.notEqual(enriched, RAW_ITEM);
  assert.equal(enriched.publisher, 'Editorial Verbo Divino');
  assert.equal(enriched.pages, 1600);
  assert.match(enriched.description, /traducción interconfesional/i);
  assert.equal(enriched.bibliographic.edition, '2.ª edición (reimpresión 2)');
  for (const field of ['id', 'title', 'author', 'isbn', 'price', 'currency', 'status', 'available_quantity', 'condition', 'pictures', 'thumbnail']) {
    assert.deepEqual(enriched[field], RAW_ITEM[field], `no debía cambiar ${field}`);
  }
});

test('un ISBN no investigado conserva exactamente el objeto original', () => {
  const other = { ...RAW_ITEM, id: 'MLU999999999', isbn: '9789876282703' };
  assert.equal(applyBookEnrichment(other), other);
});

test('el showcase usa copy propio, decisión de compra y hechos verificables', () => {
  const item = applyBookEnrichment(RAW_ITEM);
  const enrichment = getBookEnrichmentByIsbn(item.isbn);
  const config = buildAutomaticProductShowcase(item, {
    classificationTags: ['biblia'],
    enrichment,
  });
  assert.match(config.summary.join(' '), /1\.600 páginas/);
  assert.match(config.summary.join(' '), /lenguas originales hebrea, aramea y griega/);
  assert.equal(config.audienceHeading, '¿Esta es la edición que buscás?');
  assert.match(config.audience, /compará el ISBN 9788490739808/i);
  assert.equal(config.requestHelp.question, '¿Buscás otra Biblia o una edición específica?');
  assert.ok(config.editionFacts.some(fact => fact.label === 'Páginas' && fact.value === '1600'));
  assert.equal(config.sources[0].provider, 'Editorial Verbo Divino');
});

test('la ficha SSR y su capa automática muestran enriquecimiento sin autor inventado', () => {
  const item = applyBookEnrichment(RAW_ITEM);
  const baseHtml = renderPage(item, 'la-biblia-palabra-de-vida-verbo-divino', false, '', '', []);
  const html = enrichAutomaticProductShowcaseHtml(baseHtml, item.id, {
    classificationTags: ['biblia'],
  });
  assert.doesNotMatch(html, /desconocid/i);
  assert.match(html, /Qué contiene esta edición de La Biblia Palabra de Vida/);
  assert.match(html, /Editorial Verbo Divino/);
  assert.match(html, /1\.600 páginas/);
  assert.match(html, /Fuentes bibliográficas consultadas/);
  assert.match(html, /Editorial Verbo Divino/);
  assert.doesNotMatch(html, /Casa del Libro/);
  assert.doesNotMatch(html, /casadellibro\.com/);
  assert.match(html, /¿Buscás otra Biblia o una edición específica\?/);
  assert.doesNotMatch(html, /Cómo verificar una edición por ISBN/);

  const schemas = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(match => JSON.parse(match[1]));
  const book = schemas.find(schema => [].concat(schema['@type'] || []).includes('Book'));
  assert.equal(book.isbn, '9788490739808');
  assert.equal(book.numberOfPages, 1600);
  assert.equal(book.inLanguage, 'es');
  assert.equal(book.bookFormat, 'https://schema.org/Paperback');
});

test('Merchant recibe descripción enriquecida y conserva los atributos de oferta', () => {
  const description = buildFeedDescription(RAW_ITEM);
  assert.match(description, /Editorial Verbo Divino/);
  assert.match(description, /1\.600 páginas/);
  assert.doesNotMatch(description, /desconocid/i);

  const xml = renderFeedItem(RAW_ITEM);
  assert.match(xml, /<g:gtin>9788490739808<\/g:gtin>/);
  assert.match(xml, /<g:price>1950 UYU<\/g:price>/);
  assert.match(xml, /<g:availability>in stock<\/g:availability>/);
  assert.match(xml, /<g:link>https:\/\/www\.amadolibros\.com\/libro\/MLU724888358\/la-biblia-palabra-de-vida-verbo-divino<\/g:link>/);
  assert.match(xml, /<g:image_link>https:\/\/www\.amadolibros\.com\/book-cover\/MLU724888358\/cover\.jpg<\/g:image_link>/);
});
