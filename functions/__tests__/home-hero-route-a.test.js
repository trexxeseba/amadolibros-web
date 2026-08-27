import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const heroAstro = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'components', 'Hero.astro'),
  'utf8',
);
const catalogSearchOverlayAstro = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'components', 'CatalogSearchOverlay.astro'),
  'utf8',
);

test('HOME-ARTE-2: el hero abre con catálogo y una segunda puerta humana de encargo', () => {
  assert.match(heroAstro, /Libros importados y búsquedas por encargo/);
  assert.match(heroAstro, /Libros difíciles de encontrar\./);
  assert.match(heroAstro, /Los conseguimos\./);
  assert.match(heroAstro, /Buscá en nuestro catálogo\./);
  assert.match(heroAstro, /títulos importados disponibles en Uruguay/);
  assert.match(heroAstro, /ediciones agotadas o descatalogadas/);
  assert.match(heroAstro, /Título, autor o ISBN/);
  assert.match(heroAstro, />Buscar libro</);
  assert.match(heroAstro, /¿No aparece en el catálogo\?/);
  assert.match(heroAstro, /La búsqueda por encargo la revisamos personalmente\./);
  assert.match(heroAstro, /href="\/pedir-libro\/\?tipo=exacto"/);
  assert.match(heroAstro, /Pedir una búsqueda →/);
  assert.doesNotMatch(heroAstro, /16\.000|16000|automátic|gratuit/i);
});

test('HOME-ARTE-2: la escala del titular respeta Ruta A', () => {
  assert.match(heroAstro, /font-size: clamp\(2\.125rem, 9vw, 2\.4rem\)/);
  assert.match(heroAstro, /font-weight:\s*600/);
  assert.match(heroAstro, /letter-spacing:\s*-0\.01em/);
  assert.match(heroAstro, /line-height:\s*1\.08/);
  assert.match(heroAstro, /@media \(min-width: 700px\)[\s\S]*?\.hero-h1\s*\{[\s\S]*?letter-spacing:\s*-0\.015em;[\s\S]*?line-height:\s*1\.05/);
  assert.match(heroAstro, /@media \(min-width: 1024px\)[\s\S]*?\.hero-h1\s*\{\s*font-size:\s*3\.5rem/);
  assert.doesNotMatch(heroAstro, /100svh|100vh|font-size:\s*clamp\(4\.5rem|font-size:\s*5\.4rem/);
});

test('HOME-ARTE-2: el énfasis del titular usa itálica y no color de acción', () => {
  assert.match(heroAstro, /\.hero-h1 span\s*\{[\s\S]*?color:\s*inherit;[\s\S]*?font-style:\s*italic;[\s\S]*?font-weight:\s*400/);
  assert.doesNotMatch(heroAstro, /\.hero-h1 span\s*\{[^}]*var\(--salmon(?:-hover)?\)/);
});

test('HOME-ARTE-2: los tres beneficios permanecen visibles junto al buscador', () => {
  assert.match(heroAstro, /Hasta 12 cuotas con Mercado Pago/);
  assert.match(heroAstro, /12% menos por transferencia/);
  assert.match(heroAstro, /Entrega coordinada en Montevideo/);
  assert.match(heroAstro, /class="hero-benefits"/);
  assert.doesNotMatch(heroAstro, /cuotas sin interés|cuotas sin recargo/i);
});

test('HOME-ARTE-2: el buscador conserva la superficie expandida existente', () => {
  assert.match(heroAstro, /amado:openCatalogSearch/);
  assert.match(heroAstro, /detail: \{ query: input\.value\.trim\(\) \}/);
  assert.match(catalogSearchOverlayAstro, /max-width: 820px/);
  assert.match(catalogSearchOverlayAstro, /¿Qué libro estás buscando\?/);
});
