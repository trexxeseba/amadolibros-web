import test from 'node:test';
import assert from 'node:assert/strict';

import {
  verifyBookEnrichmentFeed,
  verifyBookEnrichmentHtml,
} from '../../scripts/seo/book-enrichment-live-check.mjs';
import { BOOK_FACT_ENRICHMENTS } from '../_shared/book-enrichment-facts-1000.js';
import { applyBookEnrichment } from '../_shared/book-enrichment-registry.js';
import { renderFeedItem } from '../feed.xml.js';

const record = {
  isbn: '9788490739808',
  decision: 'auto_publish',
  editorial: {
    heading: 'Qué contiene esta edición',
    decision_heading: '¿Esta es la edición que buscás?',
    merchant_description: 'La Biblia Palabra de Vida, edición Hispanoamérica de Editorial Verbo Divino.',
  },
  facts: { publisher: 'Editorial Verbo Divino' },
};

const item = {
  id: 'MLU724888358',
  isbn: record.isbn,
  title: 'La Biblia Palabra de Vida',
  author: 'Desconocido',
  publisher: null,
  pages: null,
  description: '',
  condition: 'new',
};

test('el gate acepta ficha y oferta completas', () => {
  const html = `<h2>Qué contiene esta edición</h2><p>Editorial Verbo Divino · 9788490739808</p><h3>¿Esta es la edición que buscás?</h3><div>MLU724888358</div>`;
  const feed = `<item><g:id>MLU724888358</g:id><g:description>La Biblia Palabra de Vida, edición Hispanoamérica de Editorial Verbo Divino.</g:description><g:gtin>9788490739808</g:gtin><g:price>1950 UYU</g:price><g:availability>in stock</g:availability><g:link>https://www.amadolibros.com/libro/MLU724888358/x</g:link><g:image_link>https://www.amadolibros.com/book-cover/MLU724888358/cover.jpg</g:image_link></item>`;
  assert.deepEqual(verifyBookEnrichmentHtml(html, record, 'MLU724888358'), []);
  assert.deepEqual(verifyBookEnrichmentFeed(feed, record, item), []);
});

test('Merchant busca el bloque del MLU exacto y no mezcla duplicados anteriores', () => {
  const feed = `<item><g:id>MLU111111111</g:id><g:description>Otra edición</g:description></item>
    <item><g:id>MLU724888358</g:id><g:description>La Biblia Palabra de Vida, edición Hispanoamérica de Editorial Verbo Divino.</g:description><g:gtin>9788490739808</g:gtin><g:price>1950 UYU</g:price><g:availability>in stock</g:availability><g:link>x</g:link><g:image_link>y</g:image_link></item>`;
  assert.deepEqual(verifyBookEnrichmentFeed(feed, record, item), []);
});

test('el gate falla ante copy ausente, autor genérico o pérdida comercial', () => {
  const htmlFailures = verifyBookEnrichmentHtml('<dl><dt>Autor</dt><dd>Desconocido</dd></dl><p>MLU724888358</p>', record, 'MLU724888358');
  assert.ok(htmlFailures.includes('falta el encabezado editorial'));
  assert.ok(htmlFailures.includes('aparece autoría genérica'));
  const feedFailures = verifyBookEnrichmentFeed('<rss></rss>', record, item);
  assert.deepEqual(feedFailures, ['falta la oferta en Merchant']);
});

test('N/A en una colección no se confunde con una autoría genérica', () => {
  const html = `<h2>Qué contiene esta edición</h2><p>Editorial Verbo Divino · 9788490739808</p><h3>¿Esta es la edición que buscás?</h3><dl><dt>Autor</dt><dd>Beatriz Cazurro</dd><dt>Colección</dt><dd>N/A</dd></dl><div>MLU724888358</div>`;
  assert.deepEqual(verifyBookEnrichmentHtml(html, record, 'MLU724888358'), []);
});

test('el gate detecta autoría genérica en JSON-LD y enlaces contextuales', () => {
  const base = '<h2>Qué contiene esta edición</h2><p>Editorial Verbo Divino · 9788490739808</p><h3>¿Esta es la edición que buscás?</h3><div>MLU724888358</div>';
  assert.ok(verifyBookEnrichmentHtml(`${base}<script type="application/ld+json">{"author":{"@type":"Person","name":"Unknown"}}</script>`, record, 'MLU724888358').includes('aparece autoría genérica'));
  assert.ok(verifyBookEnrichmentHtml(`${base}<a>Ver otros libros de Sin autor</a>`, record, 'MLU724888358').includes('aparece autoría genérica'));
});

test('el gate acepta una mejora factual masiva sin exigir copy editorial', () => {
  const factual = BOOK_FACT_ENRICHMENTS[0];
  const factualItem = {
    id: factual.sample_listing_id,
    isbn: factual.isbn,
    title: 'Título original',
    author: 'Desconocido',
    publisher: null,
    pages: null,
    bibliographic: {},
    description: '',
    price: 1490,
    currency_id: 'UYU',
    status: 'active',
    available_quantity: 2,
    condition: 'new',
    domain_id: 'MLU-BOOKS',
    permalink: `https://articulo.mercadolibre.com.uy/${factual.sample_listing_id}`,
    pictures: ['https://http2.mlstatic.com/D_123-O.jpg'],
  };
  const enriched = applyBookEnrichment(factualItem);
  const html = `<div>${factualItem.id} ${factual.isbn} ${enriched.author || ''} ${enriched.publisher || ''} ${enriched.pages || ''} ${Object.values(enriched.bibliographic || {}).flat().join(' ')}</div>`;
  assert.deepEqual(verifyBookEnrichmentHtml(html, factual, factualItem.id, factualItem), []);
  assert.deepEqual(verifyBookEnrichmentFeed(renderFeedItem(factualItem), factual, factualItem), []);
});

test('Merchant exige cada hecho factual que su generador debe publicar', () => {
  const factual = {
    isbn: '9788490739808',
    decision: 'auto_publish_facts',
  };
  const factualItem = {
    id: 'MLU724888358',
    isbn: factual.isbn,
    title: 'La Biblia Palabra de Vida',
    author: 'Autor real',
    publisher: null,
    pages: null,
    bibliographic: {},
    description: '',
  };
  const feed = `<item><g:id>MLU724888358</g:id><g:description>Libro. ISBN 9788490739808.</g:description><g:gtin>9788490739808</g:gtin><g:price>1950 UYU</g:price><g:availability>in stock</g:availability><g:link>x</g:link><g:image_link>y</g:image_link></item>`;
  const failures = verifyBookEnrichmentFeed(feed, factual, factualItem);
  assert.ok(failures.some(failure => failure.startsWith('Merchant no recibió el hecho verificado:')));
});
