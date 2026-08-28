import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');

const preview = read('astro-front/src/pages/preview-v2.astro');
const header = read('astro-front/src/components/HomeV2Header.astro');
const hero = read('astro-front/src/components/HomeV2Hero.astro');
const topics = read('astro-front/src/components/HomeV2Topics.astro');
const shelf = read('astro-front/src/components/HomeV2Shelf.astro');
const ideas = read('astro-front/src/components/HomeV2Ideas.astro');

test('HOME-V2: la nueva dirección vive en una ruta de preview y no reemplaza producción', () => {
  assert.match(preview, /indexable=\{false\}/);
  assert.match(preview, /analytics=\{false\}/);
  assert.match(preview, /<HomeV2Header \/>/);
  assert.match(preview, /<HomeV2Hero \/>/);
  assert.match(preview, /<HomeV2Topics \/>/);
  assert.match(preview, /<HomeV2Shelf \/>/);
  assert.match(preview, /<HomeV2Ideas \/>/);
});

test('HOME-V2: header editorial y navegación cultural están presentes', () => {
  for (const label of ['Libros', 'Temas', 'Recomendados', 'Ideas', 'Pedir un libro', 'Nosotros']) {
    assert.match(header, new RegExp(`>${label}<`));
  }
  assert.match(header, /Envío gratis desde \$1\.500/);
  assert.match(header, /Entrega en el día en Montevideo/);
  assert.match(header, /Libros difíciles y búsquedas por encargo/);
});

test('HOME-V2: el hero combina catálogo, búsqueda humana y movimiento accesible', () => {
  assert.match(hero, /Libros difíciles de encontrar\./);
  assert.match(hero, /Los conseguimos\./);
  assert.match(hero, /una persona revisa opciones y lo busca por encargo/);
  assert.match(hero, /Título, autor o ISBN/);
  assert.match(hero, /Contanos qué libro buscás/);
  assert.match(hero, /@keyframes v2-cover-float/);
  assert.match(hero, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(hero, /autoplay|<video/i);
});

test('HOME-V2: temas, tapas grandes, Amado Lee y servicio humano forman el primer recorrido', () => {
  assert.match(topics, /Todo empieza por una curiosidad\./);
  assert.match(topics, /Literatura y ficción/);
  assert.match(topics, /Libros agotados/);
  assert.match(shelf, /Tapas que piden que las mires\./);
  assert.match(shelf, /responsiveBookCover/);
  assert.match(ideas, /Amado Lee/);
  assert.match(ideas, /Contenido propio de Amado Libros/);
  assert.match(ideas, /Tu búsqueda nos importa\./);
  assert.match(ideas, /No es una respuesta automática/);
});
