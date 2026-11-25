import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanBookDescription, cleanBookFormat } from '../_shared/book-display-cleanup.js';

test('no presenta atributos importados como una sinopsis ni inventa encuadernación', () => {
  assert.equal(cleanBookDescription('Formato Libro físico Autor Editorial Biblos Encuadernación Unknown binding Isbn13 9789872605216'), '');
  assert.equal(cleanBookFormat('Unknown binding'), '');
  assert.equal(cleanBookFormat('Tapa dura'), 'Tapa dura');
  assert.equal(cleanBookDescription('Historia de una familia. Encuadernación Unknown binding'), 'Historia de una familia.');
  assert.equal(cleanBookDescription('Unknown es el nombre del protagonista.'), 'Unknown es el nombre del protagonista.');
});
