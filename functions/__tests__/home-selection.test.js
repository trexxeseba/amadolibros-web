import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDistinctHomeBooks } from '../../shared/home-selection.js';

test('reemplaza duplicados del escaparate por el siguiente libro sin alterar catálogo', () => {
  const books = [
    { id: 'MLU1', title: 'Primero', isbn: '978-987-538-373-9' },
    { id: 'MLU2', title: 'Otra publicación', isbn: '9789875383739' },
    { id: 'MLU3', title: 'Segundo' }, { id: 'MLU4', title: 'Tercero' },
  ];
  assert.deepEqual(selectDistinctHomeBooks(books, 3).map(b => b.id), ['MLU1','MLU3','MLU4']);
  assert.equal(books.length, 4);
});
test('evita las tapas repetidas con títulos variantes aunque falte el ISBN', () => {
  const books = [
    { id: 'MLU1', title: 'En La Infancia Los Diagnosticos Se Escriben Con Lapiz' },
    { id: 'MLU2', title: 'En La Infancia Diagnósticos Escriben Con Lápiz Untoiglich' },
    { id: 'MLU3', title: 'Otra obra' },
  ];
  assert.deepEqual(selectDistinctHomeBooks(books, 3).map(b => b.id), ['MLU1','MLU3']);
});
test('conserva volúmenes diferentes y obras distintas del mismo autor', () => {
  const books = [
    { id: 'MLU1', title: 'Historia Universal Del Mundo Moderno Tomo 1' },
    { id: 'MLU2', title: 'Historia Universal Del Mundo Moderno Tomo 2' },
    { id: 'MLU3', title: 'Otra obra', author: 'Mismo autor' },
  ];
  assert.deepEqual(selectDistinctHomeBooks(books, 3), books);
});
