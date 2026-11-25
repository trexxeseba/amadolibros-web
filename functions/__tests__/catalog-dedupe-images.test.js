import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeCatalogResults } from '../catalogo.js';
import { normalizeImages, renderPage } from '../libro/[[path]].js';
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

test('la ficha productiva sirve toda la galería desde Amado Libros', () => {
  const pictures = Array.from({ length: 16 }, (_, index) =>
    `https://http2.mlstatic.com/GALERIA_${index + 1}-O.jpg`);
  const html = renderPage({
    id: 'MLU123456',
    title: 'Libro con galería',
    status: 'paused',
    available_quantity: 0,
    pictures,
  }, 'libro-con-galeria', false, '');

  assert.match(html, /book-cover\/MLU123456\/cover\.jpg/);
  assert.match(html, /book-cover\/MLU123456\/cover-2\.jpg/);
  assert.match(html, /book-cover\/MLU123456\/cover-3\.jpg/);
  assert.match(html, /book-cover\/MLU123456\/cover-16\.jpg/);
  assert.doesNotMatch(html, /mlstatic\.com/);
});

test('las landings de categoría tampoco repiten la misma edición', () => {
  const result = dedupeCategoryResults([
    { id: 'MLU1', title: 'Están aquí', author: 'J. J. Benítez', isbn: '9788400000001', condition: 'new' },
    { id: 'MLU2', title: 'Están aquí - J. J. Benítez', author: 'J. J. Benítez', isbn: '9788400000001', condition: 'new' },
  ]);
  assert.deepEqual(result.map(item => item.id), ['MLU1']);
});

test('la galería no duplica variantes O/F de la misma fotografía de Mercado Libre', () => {
  const first = 'https://http2.mlstatic.com/D_948503-MLA112165856300_062026-O.jpg';
  const second = 'https://http2.mlstatic.com/D_641627-MLA112165998696_062026-O.jpg';
  assert.deepEqual(normalizeImages({ pictures: [
    first, second,
    'https://http2.mlstatic.com/D_NQ_NP_948503-MLA112165856300_062026-F.jpg',
    'https://http2.mlstatic.com/D_NQ_NP_641627-MLA112165998696_062026-F.jpg',
  ] }), [first, second]);
});

test('Así fue como llegaste conserva las cuatro fotos y excluye carteles y copias verificadas', () => {
  const photo = 'https://http2.mlstatic.com/D_915550-MLU71031909183_082023-O.jpg';
  const duplicate = 'https://http2.mlstatic.com/D_NQ_NP_952436-MLA99508947388_112025-F.jpg';
  const pictures = [
    photo, 'https://http2.mlstatic.com/D_758900-MLU70995279962_082023-O.jpg',
    'https://http2.mlstatic.com/D_841825-MLU70995173748_082023-O.jpg',
    'https://http2.mlstatic.com/D_853707-MLU70995231562_082023-O.jpg',
    'https://http2.mlstatic.com/D_884143-MLU71032024881_082023-O.jpg',
    'https://http2.mlstatic.com/D_838339-MLU70995270338_082023-O.jpg',
    'https://http2.mlstatic.com/D_779639-MLU70995173764_082023-O.jpg',
    duplicate, 'https://http2.mlstatic.com/D_NQ_NP_785404-MLA99992928035_112025-F.jpg',
  ];
  assert.deepEqual(normalizeImages({ id: 'MLU633445690', pictures }), pictures.slice(0, 4));
  assert.deepEqual(normalizeImages({ id: 'MLU2', pictures: [duplicate] }), [duplicate]);
  const html = renderPage({ id: 'MLU633445690', title: 'Así fue como llegaste', pictures,
    status: 'active', available_quantity: 1, price: 2835,
    description: 'Formato Libro físico Autor Editorial Biblos Encuadernación Unknown binding Isbn13 9789872605216',
  }, 'asi-fue-como-llegaste', false, '');
  assert.doesNotMatch(html, /Unknown binding|cover-[5-9]\.jpg/);
  assert.match(html, /cover-4\.jpg/);
});
