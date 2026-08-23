import test from 'node:test';
import assert from 'node:assert/strict';

import { enrichPreviewBookIntelligenceHtml } from '../_middleware.js';

function htmlFixture() {
  return `<!doctype html><html><head><style>.existing{display:block}</style>
  <meta name="description" content="Original description">
  <script type="application/ld+json">{"@type":"Book","name":"Original"}</script>
  </head><body><main><h1>Título original</h1>
  <section class="order-hub-links"><h2>Más libros por encargo</h2></section>
  </main></body></html>`;
}

function greenEntry(overrides = {}) {
  return {
    product_id: 'MLU616917519',
    decision: 'auto_publish',
    work: {
      auto_publish: true,
      topic_seeds: [
        'selección argentina de básquetbol',
        'Mundial de China 2019',
        'recambio generacional',
        'testimonios de jugadores',
        'liderazgo y presión deportiva',
      ],
    },
    edition: {
      auto_publishable_fields: {
        publisher: { value: 'Básquet Plus' },
        pages: { value: 240 },
      },
    },
    provenance: [
      { source: 'publisher', official: true, url: 'https://www.basquetplus.com/node/67934' },
      { source: 'google_books', official: false, url: 'https://books.google.com/' },
    ],
    ...overrides,
  };
}

test('GREEN inserta un bloque visible antes del recovery por encargo', () => {
  const html = enrichPreviewBookIntelligenceHtml(htmlFixture(), greenEntry());
  assert.match(html, /data-book-intelligence-preview="v1"/);
  assert.match(html, /Temas de esta obra/);
  assert.match(html, /selección argentina de básquetbol/);
  assert.match(html, /<dt>Editorial<\/dt><dd>Básquet Plus<\/dd>/);
  assert.match(html, /<dt>Páginas<\/dt><dd>240<\/dd>/);
  assert.ok(html.indexOf('data-book-intelligence-preview="v1"') < html.indexOf('class="order-hub-links"'));
});

test('sólo enlaza provenance oficial; Google Books no se muestra como fuente visible', () => {
  const html = enrichPreviewBookIntelligenceHtml(htmlFixture(), greenEntry());
  assert.match(html, /https:\/\/www\.basquetplus\.com\/node\/67934/);
  assert.doesNotMatch(html, /https:\/\/books\.google\.com/);
  assert.match(html, /Fuente editorial/);
});

test('review, hold o ausencia de entry dejan el HTML idéntico', () => {
  const source = htmlFixture();
  assert.equal(enrichPreviewBookIntelligenceHtml(source, null), source);
  assert.equal(enrichPreviewBookIntelligenceHtml(source, { ...greenEntry(), decision: 'review' }), source);
  assert.equal(enrichPreviewBookIntelligenceHtml(source, { ...greenEntry(), decision: 'hold' }), source);
});

test('la transformación es idempotente', () => {
  const once = enrichPreviewBookIntelligenceHtml(htmlFixture(), greenEntry());
  const twice = enrichPreviewBookIntelligenceHtml(once, greenEntry());
  assert.equal(twice, once);
  assert.equal((twice.match(/data-book-intelligence-preview="v1"/g) || []).length, 1);
});

test('no reescribe H1, meta description ni schema en este gate', () => {
  const source = htmlFixture();
  const html = enrichPreviewBookIntelligenceHtml(source, greenEntry());
  assert.match(html, /<h1>Título original<\/h1>/);
  assert.match(html, /<meta name="description" content="Original description">/);
  assert.match(html, /<script type="application\/ld\+json">{"@type":"Book","name":"Original"}<\/script>/);
});

test('temas, facts y URLs se escapan antes de entrar al HTML', () => {
  const html = enrichPreviewBookIntelligenceHtml(htmlFixture(), greenEntry({
    work: { auto_publish: true, topic_seeds: ['<script>alert(1)</script>'] },
    edition: { auto_publishable_fields: { publisher: { value: '<b>Editorial</b>' } } },
    provenance: [{ source: 'publisher', official: true, url: 'https://example.com/?q=<x>' }],
  }));
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;b&gt;Editorial&lt;\/b&gt;/);
  assert.match(html, /https:\/\/example\.com\/\?q=&lt;x&gt;/);
});

test('si no hay temas ni hechos permitidos no inserta un bloque vacío', () => {
  const source = htmlFixture();
  const html = enrichPreviewBookIntelligenceHtml(source, greenEntry({
    work: { auto_publish: true, topic_seeds: [] },
    edition: { auto_publishable_fields: {} },
  }));
  assert.equal(html, source);
});
