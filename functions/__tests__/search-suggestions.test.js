import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSuggestions } from '../api/search-suggestions.js';

const items = [
  { title: 'El Kama Sutra Gay del Siglo XXI', author: 'Gabriel J. Martín', isbn: '9788417001439' },
  { title: 'Otro libro', author: 'Gabriel García Márquez', isbn: '9780000000002' },
];

test('autocompleta por título, autor e ISBN desde dos caracteres', () => {
  assert.equal(buildSuggestions(items, 'kama')[0].value, 'El Kama Sutra Gay del Siglo XXI');
  assert.ok(buildSuggestions(items, 'gabriel').some(item => item.label.startsWith('Autor:')));
  assert.ok(buildSuggestions(items, '9788417').some(item => item.label.startsWith('ISBN:')));
  assert.deepEqual(buildSuggestions(items, 'g'), []);
});

test('autocompletado elimina sugerencias repetidas', () => {
  const repeated = buildSuggestions([...items, items[0]], 'kama');
  assert.equal(repeated.filter(item => item.value === items[0].title).length, 1);
});

test('una palabra exacta se prioriza sobre una coincidencia parcial', () => {
  const suggestions = buildSuggestions([
    { title: 'Cracking The Coding Interview - Gayle Laakmann' },
    { title: 'Edipo Gay' },
  ], 'gay');
  assert.equal(suggestions[0].value, 'Edipo Gay');
});
