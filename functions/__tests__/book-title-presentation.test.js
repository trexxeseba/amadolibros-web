import { test } from 'node:test';
import assert from 'node:assert/strict';

import { presentBookTitle } from '../../shared/book-title-presentation.js';

const CASES = [
  ['Harry Potter Y La Piedra Filosofal', 'Harry Potter y la Piedra Filosofal'],
  ['El Señor De Los Anillos', 'El Señor de los Anillos'],
  ['De Animales A Dioses', 'De Animales a Dioses'],
  ['Cien Años De Soledad Garcia Marquez Sudamericana', 'Cien Años de Soledad Garcia Marquez Sudamericana'],
  ['Biblia De America Editorial Verbo Divino', 'Biblia de America Editorial Verbo Divino'],
  ['Biblia Manual Café Con Cierre Reina Valera  1960', 'Biblia Manual Café con Cierre Reina Valera  1960'],
  ['Lo Que El Viento Se Llevó', 'Lo que el Viento se Llevó'],
  ['El Hombre En Busca De Sentido', 'El Hombre en Busca de Sentido'],
  ['Como Agua Para Chocolate', 'Como Agua para Chocolate'],
  ['Crimen Y Castigo', 'Crimen y Castigo'],
  ['La Casa De Los Espíritus Por Isabel Allende', 'La Casa de los Espíritus por Isabel Allende'],
];

for (const [input, expected] of CASES) {
  test(`presentBookTitle: ${input}`, () => {
    assert.equal(presentBookTitle(input), expected);
  });
}

test('presentBookTitle respeta siglas y palabras en mayúsculas sostenidas', () => {
  assert.equal(presentBookTitle('Guía Del ISBN En UY'), 'Guía del ISBN en UY');
  assert.equal(presentBookTitle('Historia De La Filosofía Tomo II'), 'Historia de la Filosofía Tomo II');
  assert.equal(presentBookTitle('Manual DE Usuario'), 'Manual DE Usuario');
  assert.equal(presentBookTitle('DSM-5 Manual Diagnóstico Y Estadístico'), 'DSM-5 Manual Diagnóstico y Estadístico');
});

test('presentBookTitle deja intacto un título entero en mayúsculas', () => {
  assert.equal(presentBookTitle('CIEN AÑOS DE SOLEDAD Y OTROS'), 'CIEN AÑOS DE SOLEDAD Y OTROS');
});

test('presentBookTitle no toca la palabra que abre un subtítulo', () => {
  assert.equal(presentBookTitle('Sapiens: De Animales A Dioses'), 'Sapiens: De Animales a Dioses');
  assert.equal(presentBookTitle('Rayuela - La Edición Del Centenario'), 'Rayuela - La Edición del Centenario');
  assert.equal(presentBookTitle('Rayuela – El Libro De Los Juegos'), 'Rayuela – El Libro de los Juegos');
  assert.equal(presentBookTitle('Tomo 1. El Comienzo'), 'Tomo 1. El Comienzo');
});

test('presentBookTitle conserva números, puntuación y espacios', () => {
  assert.equal(presentBookTitle('1984 De George Orwell'), '1984 de George Orwell');
  assert.equal(presentBookTitle('¿Quién Se Ha Llevado Mi Queso?'), '¿Quién se Ha Llevado Mi Queso?');
  assert.equal(presentBookTitle('Biblia De Jerusalén 5ª Edición'), 'Biblia de Jerusalén 5ª Edición');
  assert.equal(presentBookTitle('  Cuentos De Amor, De Locura Y De Muerte '), '  Cuentos de Amor, de Locura y de Muerte ');
});

test('presentBookTitle es idempotente y tolera valores vacíos', () => {
  const once = presentBookTitle('Harry Potter Y La Piedra Filosofal');
  assert.equal(presentBookTitle(once), once);
  assert.equal(presentBookTitle(''), '');
  assert.equal(presentBookTitle(null), '');
  assert.equal(presentBookTitle(undefined), '');
});
