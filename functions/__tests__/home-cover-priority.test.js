import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bookCardAstro = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'components', 'BookCard.astro'),
  'utf8',
);
const bestsellerAstro = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'components', 'BestsellerSection.astro'),
  'utf8',
);
const imagesJs = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'lib', 'cloudflare-images.js'),
  'utf8',
);

test('HOME-ARTE-4: sólo la primera portada recibe prioridad alta', () => {
  assert.match(bestsellerAstro, /fetchPriority=\{index === 0 \? 'high' : 'auto'\}/);
  assert.match(bookCardAstro, /fetchpriority=\{fetchPriority\}/);
  assert.doesNotMatch(bestsellerAstro, /index < 2 \? 'high'/);
});

test('HOME-ARTE-4: las dos primeras portadas cargan eager y desde la tercera se difieren', () => {
  assert.match(bestsellerAstro, /loading=\{index < 2 \? 'eager' : 'lazy'\}/);
  assert.match(bookCardAstro, /loading\?: 'eager' \| 'lazy'/);
  assert.match(bookCardAstro, /loading = 'lazy'/);
  assert.match(bookCardAstro, /loading=\{loading\}/);
});

test('HOME-ARTE-4: la card reserva espacio y conserva la portada controlada por Amado Libros', () => {
  assert.match(bookCardAstro, /responsiveBookCover\(book\.id/);
  assert.match(bookCardAstro, /width="280"/);
  assert.match(bookCardAstro, /height="373"/);
  assert.match(bookCardAstro, /decoding="async"/);
  assert.doesNotMatch(bookCardAstro, /src=\{book\.thumbnail\}/);
  assert.match(imagesJs, /const BASE = 'https:\/\/www\.amadolibros\.com'/);
  assert.match(imagesJs, /\/book-cover\/\$\{encodeURIComponent\(id\)\}/);
});

test('HOME-ARTE-4: no agrega otro host de imagen ni preconnect desde la sección', () => {
  assert.doesNotMatch(bestsellerAstro, /preconnect|mlstatic|http:\/\/|https:\/\//);
});
