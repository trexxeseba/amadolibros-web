import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignShowcaseRanking,
  isShowcaseEligible,
  normalizeValidIsbn,
  rankShowcaseItems,
  showcaseEditionKey,
} from '../_shared/showcase-ranking.js';

function item(index, overrides = {}) {
  return {
    id: `MLU${100000000 + index}`,
    title: `Libro de prueba ${index}`,
    author: `Autor ${index}`,
    price: 1000 + index,
    currency: 'UYU',
    status: 'active',
    available_quantity: 1,
    condition: 'new',
    pictures: [`https://img/${index}.jpg`],
    publisher: 'Editorial real',
    pages: 200,
    bibliographic: { language: 'Español', format: 'Tapa blanda' },
    ...overrides,
  };
}

test('normaliza ISBN válidos y rechaza checksums falsos', () => {
  assert.equal(normalizeValidIsbn('978-84-96836-69-3'), '9788496836693');
  assert.equal(normalizeValidIsbn('849683669X'), '9788496836693');
  assert.equal(normalizeValidIsbn('9780000000000'), null);
  assert.equal(normalizeValidIsbn('1234567890128'), null);
});

test('selecciona exactamente mil ediciones y asigna rango continuo', () => {
  const items = Array.from({ length: 1200 }, (_, index) => item(index));
  const metrics = assignShowcaseRanking(items, { limit: 1000 });
  const selected = items.filter(entry => entry.showcase_rank);

  assert.equal(metrics.selected_items, 1000);
  assert.equal(selected.length, 1000);
  assert.deepEqual(
    selected.map(entry => entry.showcase_rank).sort((a, b) => a - b),
    Array.from({ length: 1000 }, (_, index) => index + 1),
  );
  assert.equal(items.filter(entry => entry.showcase_rank == null).length, 200);
});

test('excluye pausados, sin stock, moneda no UYU y objetos sin señal de libro', () => {
  const invalid = [
    item(1, { status: 'paused' }),
    item(2, { available_quantity: 0 }),
    item(3, { currency: 'USD' }),
    item(4, {
      author: null,
      publisher: null,
      pages: null,
      bibliographic: null,
      isbn: null,
      domain_id: 'MLU-ELECTRONICS',
    }),
  ];
  assert.ok(invalid.every(entry => !isShowcaseEligible(entry)));
  assert.equal(rankShowcaseItems(invalid).selected.length, 0);
});

test('dominio BOOKS alcanza; otro dominio exige ISBN y apoyo bibliográfico', () => {
  assert.equal(isShowcaseEligible(item(1, {
    domain_id: 'MLU-BOOKS',
    author: null,
    pages: null,
    bibliographic: null,
  })), true);
  assert.equal(isShowcaseEligible(item(2, {
    domain_id: 'MLU-COLLECTIBLES',
    isbn: '9788496836693',
    author: 'Meg Meeker',
    pages: null,
    bibliographic: null,
  })), true);
  assert.equal(isShowcaseEligible(item(3, {
    domain_id: 'MLU-COLLECTIBLES',
    isbn: '9788496836693',
    author: null,
    pages: null,
    bibliographic: null,
  })), false);
});

test('deduplica la misma edición y conserva condición distinta', () => {
  const first = item(1, { isbn: '9788496836693', available_quantity: 1 });
  const better = item(2, {
    isbn: '9788496836693',
    available_quantity: 8,
    pictures: ['a', 'b', 'c'],
  });
  const used = item(3, { isbn: '9788496836693', condition: 'used' });
  const result = rankShowcaseItems([first, better, used], { limit: 10 });

  assert.equal(showcaseEditionKey(first), showcaseEditionKey(better));
  assert.notEqual(showcaseEditionKey(first), showcaseEditionKey(used));
  assert.equal(result.selected.length, 2);
  assert.ok(result.selected.some(entry => entry.id === better.id));
  assert.ok(!result.selected.some(entry => entry.id === first.id));
  assert.ok(result.selected.some(entry => entry.id === used.id));
});

test('el orden no depende del orden de entrada y un ID prioritario gana', () => {
  const a = item(1, { description: 'Descripción breve '.repeat(20) });
  const b = item(2);
  const c = item(3);
  const options = { limit: 3, priorityIds: [c.id] };
  const forward = rankShowcaseItems([a, b, c], options).selected.map(entry => entry.id);
  const reverse = rankShowcaseItems([c, b, a], options).selected.map(entry => entry.id);

  assert.deepEqual(forward, reverse);
  assert.equal(forward[0], c.id);
});

test('clasifica el nivel de contenido sin inventarlo', () => {
  const result = rankShowcaseItems([
    item(1, { description: 'a'.repeat(500) }),
    item(2, { description: 'a'.repeat(120) }),
    item(3, { description: null }),
  ], { limit: 3 }).selected;
  const levels = new Map(result.map(entry => [entry.id, entry.contentLevel]));

  assert.equal(levels.get(item(1).id), 'editorial');
  assert.equal(levels.get(item(2).id), 'descriptive');
  assert.equal(levels.get(item(3).id), 'bibliographic');
});

test('una nueva corrida limpia marcas viejas antes de reasignar', () => {
  const items = [item(1), item(2), item(3)];
  assignShowcaseRanking(items, { limit: 3 });
  assert.ok(items.every(entry => entry.showcase_rank));

  assignShowcaseRanking(items, { limit: 1, priorityIds: [items[2].id] });
  assert.equal(items.filter(entry => entry.showcase_rank).length, 1);
  assert.equal(items[2].showcase_rank, 1);
  assert.equal(items[0].showcase_rank, undefined);
  assert.equal(items[1].showcase_score, undefined);
});
