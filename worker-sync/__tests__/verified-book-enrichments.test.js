import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyVerifiedBookEnrichments,
  VERIFIED_BOOK_IDS,
} from '../verified-book-enrichments.js';

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

  assert.deepEqual(result, { applied: 5, skipped_isbn_mismatch: 0 });
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

  assert.deepEqual(result, { applied: 0, skipped_isbn_mismatch: 1 });
  assert.equal(item.title, 'Título intacto');
  assert.equal(item.publisher, null);
});
