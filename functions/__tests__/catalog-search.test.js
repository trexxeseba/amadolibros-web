import test from 'node:test';
import assert from 'node:assert/strict';
import {
  joinInitials,
  matchCatalogQuery,
  tolerantMatches,
  tokenize,
} from '../_shared/catalog-search.js';

const items = [
  { id: 'MLU1', title: 'La tierra baldía', author: 'T. S. Eliot', isbn: '9788437606873' },
  { id: 'MLU2', title: 'El perro azul', author: 'Nadja', isbn: '9788484700098' },
  { id: 'MLU3', title: 'Ficciones', author: 'Jorge Luis Borges', isbn: '9788420633121' },
  { id: 'MLU4', title: 'El perro de los Baskerville', author: 'Arthur Conan Doyle', isbn: '9788491050100' },
  { id: 'MLU5', title: 'Cuentos completos', author: 'JRR Tolkien', isbn: null },
  { id: 'MLU6', title: 'Casa tomada', author: null, isbn: null },
];
const ids = result => result.matches.map(b => b.id);

test('sin consulta devuelve todo y no marca tolerancia', () => {
  const result = matchCatalogQuery(items, '');
  assert.equal(result.matches.length, items.length);
  assert.equal(result.usedFuzzy, false);
});

test('la búsqueda estricta manda: si encuentra algo, no se usa la tolerante', () => {
  const result = matchCatalogQuery(items, 'perro');
  assert.deepEqual(ids(result), ['MLU2', 'MLU4']);
  assert.equal(result.usedFuzzy, false);
});

test('iniciales pegadas encuentran al autor escrito con iniciales separadas', () => {
  const result = matchCatalogQuery(items, 'TS Eliot');
  assert.deepEqual(ids(result), ['MLU1']);
  assert.equal(result.usedFuzzy, true);
});

test('iniciales separadas encuentran al autor escrito con iniciales pegadas', () => {
  assert.deepEqual(ids(matchCatalogQuery(items, 'J. R. R. Tolkien')), ['MLU5']);
});

test('varias palabras con una letra de menos: «el perro azl»', () => {
  const result = matchCatalogQuery(items, 'El perro azl');
  assert.deepEqual(ids(result), ['MLU2']);
  assert.equal(result.usedFuzzy, true);
});

test('autor mal escrito, una sola palabra', () => {
  const result = matchCatalogQuery(items, 'borjes');
  assert.deepEqual(ids(result), ['MLU3']);
  assert.equal(result.usedFuzzy, true);
});

test('una palabra corta mal escrita no se adivina', () => {
  assert.deepEqual(ids(matchCatalogQuery(items, 'azl')), []);
  assert.deepEqual(ids(matchCatalogQuery(items, 'cas')), ['MLU6']); // comienzo de palabra: estricta
});

test('con varias palabras, al menos una tiene que coincidir sin tolerancia', () => {
  assert.deepEqual(ids(matchCatalogQuery(items, 'perrro azzul')), []);
});

test('hasta tres palabras se tolera una sola con error', () => {
  assert.equal(tolerantMatches(items[3], tokenize('perrro baskervile')), false);
  assert.equal(tolerantMatches(items[3], tokenize('perro baskervile')), true);
});

test('un texto inventado no devuelve nada', () => {
  const result = matchCatalogQuery(items, 'zzzinexistente999');
  assert.deepEqual(ids(result), []);
  assert.equal(result.usedFuzzy, false);
});

test('ISBN: solo cuando la consulta es numérica', () => {
  assert.deepEqual(ids(matchCatalogQuery(items, '978-84-376-0687-3')), ['MLU1']);
  assert.deepEqual(ids(matchCatalogQuery(items, 'libro 0687')), []);
});

test('joinInitials junta solo letras sueltas seguidas', () => {
  assert.deepEqual(joinInitials(['t', 's', 'eliot']), ['ts', 'eliot']);
  assert.deepEqual(joinInitials(['el', 'perro', '2']), ['el', 'perro', '2']);
});
