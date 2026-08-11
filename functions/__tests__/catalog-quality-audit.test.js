import test from 'node:test';
import assert from 'node:assert/strict';

import { auditCatalog, looksLikeMojibake } from '../../scripts/seo/catalog-quality-audit.mjs';

test('detector encuentra mojibake habitual sin marcar acentos válidos', () => {
  assert.equal(looksLikeMojibake('PsicologÃ­a infantil'), true);
  assert.equal(looksLikeMojibake('El niÃ±o y su mundo'), true);
  assert.equal(looksLikeMojibake('Psicología infantil'), false);
  assert.equal(looksLikeMojibake('El niño y su mundo'), false);
});

test('auditoría separa activos, cobertura e IDs concretos a corregir', () => {
  const report = auditCatalog({
    updated_at: '2026-08-11T00:00:00.000Z',
    items: [
      {
        id: 'MLU1', title: 'Libro válido', author: 'Autora', isbn: '9788491053705',
        publisher: 'Editorial Real', pages: 220, condition: 'new', price: 1500,
        permalink: 'https://example.com/1', pictures: ['https://example.com/1.jpg'],
        dimensions: { width: '15 cm', height: '21 cm', length: '2 cm', weight: '300 g' },
        status: 'active', available_quantity: 1,
      },
      {
        id: 'MLU2', title: 'PsicologÃ­a prÃ¡ctica', author: null, isbn: 'roto',
        publisher: null, pages: null, condition: 'new', price: 900,
        permalink: 'https://example.com/2', pictures: [], thumbnail: 'https://example.com/2.jpg',
        dimensions: {}, status: 'active', available_quantity: 2,
      },
      { id: 'MLU3', title: 'Pausado', status: 'paused', available_quantity: 0 },
    ],
  }, { source: 'fixture', generatedAt: '2026-08-11T01:00:00.000Z' });

  assert.equal(report.inventory.catalogItems, 3);
  assert.equal(report.inventory.activeWithStock, 2);
  assert.deepEqual(report.issues.mojibakeTitles, [
    { id: 'MLU2', title: 'PsicologÃ­a prÃ¡ctica' },
  ]);
  assert.equal(report.coverage.title_encoding_clean.percent, 50);
  assert.equal(report.coverage.image_any.percent, 100);
  assert.equal(report.coverage.image_multiple.percent, 0);
  assert.equal(report.isbn.invalidWithValue, 1);
  assert.equal(report.schemaVersion, 2);
});
