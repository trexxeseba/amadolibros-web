import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyVerifiedBookEnrichments,
  VERIFIED_BOOK_IDS,
} from '../verified-book-enrichments.js';

const EMPTY_DEMAND_METRICS = {
  matched_items: 0,
  applied_items: 0,
  applied_fields: {
    isbn: 0,
    publisher: 0,
    pages: 0,
    publication_year: 0,
  },
  skipped_isbn_mismatch: 0,
  preserved_existing_fields: 0,
};

test('enriquece las cinco fichas verificadas sin cambiar sus títulos', () => {
  const items = VERIFIED_BOOK_IDS.map((id, index) => ({
    id,
    title: `Título comercial ${index}`,
    isbn: null,
    price: 1000 + index,
    pictures: [`foto-${index}.jpg`],
    bibliographic: {},
    dimensions: {},
  }));

  const result = applyVerifiedBookEnrichments(items);

  assert.deepEqual(result, {
    applied: 5,
    skipped_isbn_mismatch: 0,
    demand_bibliography: EMPTY_DEMAND_METRICS,
  });
  assert.deepEqual(items.map(item => item.title), [
    'Título comercial 0',
    'Título comercial 1',
    'Título comercial 2',
    'Título comercial 3',
    'Título comercial 4',
  ]);
  assert.ok(items.every(item => item.publisher && item.pages && item.description));
  assert.deepEqual(items[0].pictures, ['foto-0.jpg']);
  assert.equal(items[1].pages, 672);
  assert.equal(items[3].author, 'Jean Laplanche y Jean-Bertrand Pontalis');
});

test('no aplica un dato si el ISBN actual identifica otra edición', () => {
  const item = {
    id: 'MLU678034726',
    title: 'Título intacto',
    isbn: '9780000000000',
    publisher: null,
  };

  const result = applyVerifiedBookEnrichments([item]);

  assert.deepEqual(result, {
    applied: 0,
    skipped_isbn_mismatch: 1,
    demand_bibliography: EMPTY_DEMAND_METRICS,
  });
  assert.equal(item.title, 'Título intacto');
  assert.equal(item.publisher, null);
});

test('integra el lote parcial de demanda después de los enriquecimientos manuales', () => {
  const item = {
    id: 'MLU704191572',
    title: 'Título comercial intacto',
    author: 'Autor existente',
    isbn: '9788417880521',
    publisher: null,
    pages: null,
    bibliographic: { format: 'Tapa blanda' },
    description: 'Descripción existente',
    price: 1500,
    pictures: ['foto.jpg'],
  };

  const result = applyVerifiedBookEnrichments([item]);

  assert.deepEqual(result, {
    applied: 0,
    skipped_isbn_mismatch: 0,
    demand_bibliography: {
      matched_items: 1,
      applied_items: 1,
      applied_fields: {
        isbn: 0,
        publisher: 1,
        pages: 1,
        publication_year: 1,
      },
      skipped_isbn_mismatch: 0,
      preserved_existing_fields: 0,
    },
  });
  assert.equal(item.title, 'Título comercial intacto');
  assert.equal(item.author, 'Autor existente');
  assert.equal(item.publisher, 'Almuzara');
  assert.equal(item.pages, 232);
  assert.equal(item.bibliographic.format, 'Tapa blanda');
  assert.equal(item.bibliographic.publication_year, '2021');
  assert.equal(item.description, 'Descripción existente');
  assert.equal(item.price, 1500);
  assert.deepEqual(item.pictures, ['foto.jpg']);
});
