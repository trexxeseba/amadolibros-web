import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeCatalogResults } from '../catalogo.js';
import { normalizeImages } from '../libro/[[path]].js';
import { dedupeCategoryResults } from '../libros/[[path]].js';

test('catálogo muestra una sola oferta por mismo ISBN, estado y condición', () => {
  const result = dedupeCatalogResults([
    { id: 'MLU1', title: 'Libro', author: 'Autora', isbn: '978-84-123456-7-8', status: 'active', condition: 'new' },
    { id: 'MLU2', title: 'Libro - edición ampliada', author: 'Autora', isbn: '9788412345678', status: 'active', condition: 'new' },
  ]);
  assert.deepEqual(result.map(item => item.id), ['MLU1']);
});

test('catálogo conserva ediciones, condiciones y estados realmente distintos', () => {
  const result = dedupeCatalogResults([
    { id: 'MLU1', title: 'Libro', author: 'Autora', isbn: '9788412345678', status: 'active', condition: 'new' },
    { id: 'MLU2', title: 'Libro', author: 'Autora', isbn: '9788412345679', status: 'active', condition: 'new' },
    { id: 'MLU3', title: 'Libro', author: 'Autora', isbn: '9788412345678', status: 'active', condition: 'used' },
    { id: 'MLU4', title: 'Libro', author: 'Autora', isbn: '9788412345678', status: 'paused', condition: 'new' },
  ]);
  assert.deepEqual(result.map(item => item.id), ['MLU1', 'MLU2', 'MLU3', 'MLU4']);
});

test('sin ISBN solo elimina título+autor exactamente repetidos', () => {
  const result = dedupeCatalogResults([
    { id: 'MLU1', title: 'Árbol rojo', author: 'Ana Pérez', status: 'active' },
    { id: 'MLU2', title: 'Arbol rojo', author: 'Ana Perez', status: 'active' },
    { id: 'MLU3', title: 'Árbol rojo - segunda edición', author: 'Ana Pérez', status: 'active' },
  ]);
  assert.deepEqual(result.map(item => item.id), ['MLU1', 'MLU3']);
});

test('ficha descarta las placas verificadas y no repite thumbnail como foto', () => {
  const images = normalizeImages({
    pictures: [
      'http://http2.mlstatic.com/PORTADA-O.jpg',
      'https://http2.mlstatic.com/D_768794-MLU78243849622_082024-O.jpg',
      'https://http2.mlstatic.com/D_823347-MLU78243898758_082024-O.jpg',
    ],
    thumbnail: 'https://http2.mlstatic.com/PORTADA-I.jpg',
  });
  assert.deepEqual(images, ['https://http2.mlstatic.com/PORTADA-O.jpg']);
});

test('la copia R2 validada reemplaza la portada de origen', () => {
  assert.deepEqual(
    normalizeImages({ pictures: ['https://http2.mlstatic.com/PORTADA-O.jpg'] }, '/preview-cover/MLU1/0/hash.jpg'),
    ['/preview-cover/MLU1/0/hash.jpg'],
  );
});

test('la portada primaria convierte miniatura -I en imagen grande -O', () => {
  assert.deepEqual(
    normalizeImages({ thumbnail: 'http://http2.mlstatic.com/D_PORTADA-I.jpg' }),
    ['https://http2.mlstatic.com/D_PORTADA-O.jpg'],
  );
});

test('las landings de categoría tampoco repiten la misma edición', () => {
  const result = dedupeCategoryResults([
    { id: 'MLU1', title: 'Están aquí', author: 'J. J. Benítez', isbn: '9788400000001', condition: 'new' },
    { id: 'MLU2', title: 'Están aquí - J. J. Benítez', author: 'J. J. Benítez', isbn: '9788400000001', condition: 'new' },
  ]);
  assert.deepEqual(result.map(item => item.id), ['MLU1']);
});
