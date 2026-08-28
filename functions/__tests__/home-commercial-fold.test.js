import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = relative => readFileSync(path.join(ROOT, relative), 'utf8');

const homeAstro = read('astro-front/src/pages/index.astro');
const headerAstro = read('astro-front/src/components/HomeV2Header.astro');
const heroAstro = read('astro-front/src/components/HomeV2Hero.astro');
const topicsAstro = read('astro-front/src/components/HomeV2Topics.astro');
const shelfAstro = read('astro-front/src/components/HomeV2Shelf.astro');
const ideasAstro = read('astro-front/src/components/HomeV2Ideas.astro');
const catalogSearchOverlayAstro = read('astro-front/src/components/CatalogSearchOverlay.astro');

test('la portada productiva usa la dirección cultural V2 completa', () => {
  assert.match(homeAstro, /<HomeV2Header \/>/);
  assert.match(homeAstro, /<HomeV2Hero \/>/);
  assert.match(homeAstro, /<HomeV2Topics \/>/);
  assert.match(homeAstro, /<HomeV2Shelf \/>/);
  assert.match(homeAstro, /<HomeV2Ideas \/>/);
  assert.match(homeAstro, /canonical="https:\/\/www\.amadolibros\.com\/"/);
  assert.match(homeAstro, /jsonLd=\{jsonLd\}/);
  assert.doesNotMatch(homeAstro, /indexable=\{false\}|analytics=\{false\}/);
});

test('el primer pantallazo comunica búsqueda enfocada y encargo revisado por una persona', () => {
  assert.match(heroAstro, /Librería online uruguaya · búsqueda enfocada/);
  assert.match(heroAstro, /Libros difíciles de encontrar\./);
  assert.match(heroAstro, /Los conseguimos\./);
  assert.match(heroAstro, /una persona revisa opciones y lo busca por encargo/);
  assert.match(heroAstro, /Título, autor o ISBN/);
  assert.match(heroAstro, /Contanos qué libro buscás/);
  assert.match(heroAstro, /href="\/pedir-libro\/\?tipo=exacto"/);
  assert.doesNotMatch(heroAstro, /búsqueda humana/i);
});

test('el header editorial ofrece navegación comercial y cultural', () => {
  for (const label of ['Libros', 'Temas', 'Recomendados', 'Ideas', 'Pedir un libro', 'Nosotros']) {
    assert.match(headerAstro, new RegExp(`>${label}<`));
  }
  assert.match(headerAstro, /Envío gratis desde \$1\.500/);
  assert.match(headerAstro, /Entrega en el día en Montevideo/);
  assert.match(headerAstro, /Libros difíciles y búsquedas por encargo/);
});

test('el recorrido posterior combina temas, tapas grandes, contenido y confianza', () => {
  assert.match(topicsAstro, /Todo empieza por una curiosidad\./);
  assert.match(topicsAstro, /Literatura y ficción/);
  assert.match(topicsAstro, /Libros agotados/);
  assert.match(shelfAstro, /Tapas que piden que las mires\./);
  assert.match(shelfAstro, /responsiveBookCover/);
  assert.match(ideasAstro, /Amado Lee/);
  assert.match(ideasAstro, /Tu búsqueda nos importa\./);
  assert.match(ideasAstro, /No es una respuesta automática/);
});

test('el buscador del hero conserva la búsqueda expandida y el mobile accesible', () => {
  assert.match(heroAstro, /amado:openCatalogSearch/);
  assert.match(heroAstro, /detail: \{ query: input\.value\.trim\(\) \}/);
  assert.match(heroAstro, /@media \(max-width: 520px\)/);
  assert.match(heroAstro, /\.v2-search button \{ grid-column: 1 \/ -1; width: 100%; \}/);
  assert.match(catalogSearchOverlayAstro, /¿Qué libro estás buscando\?/);
  assert.match(catalogSearchOverlayAstro, /max-width: 820px/);
});

test('las animaciones respetan reducción de movimiento', () => {
  assert.match(heroAstro, /@keyframes v2-cover-float/);
  assert.match(heroAstro, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(ideasAstro, /@media \(prefers-reduced-motion: reduce\)/);
});
