// Contrato del primer pantallazo comercial y editorial de la portada V2.
// Estas pruebas son estructurales: fijan mensaje, rutas, jerarquía mobile y
// guardrails de movimiento sin depender de navegador ni servicios externos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = relativePath => readFileSync(path.join(ROOT, relativePath), 'utf8');

const heroAstro = read('astro-front/src/components/Hero.astro');
const commercialAstro = read('astro-front/src/components/CommercialBenefits.astro');
const homeAstro = read('astro-front/src/pages/index.astro');
const headerAstro = read('astro-front/src/components/Header.astro');
const announcementAstro = read('astro-front/src/components/AnnouncementBar.astro');
const bookCardAstro = read('astro-front/src/components/BookCard.astro');
const categoryAccessAstro = read('astro-front/src/components/CategoryAccess.astro');
const catalogSearchOverlayAstro = read('astro-front/src/components/CatalogSearchOverlay.astro');
const amadoLeeAstro = read('astro-front/src/components/AmadoLee.astro');
const recentAstro = read('astro-front/src/components/BestsellerSection.astro');

test('la portada V2 comunica catálogo más búsqueda humana en el primer pantallazo', () => {
  assert.match(heroAstro, /Una librería online con gente detrás/);
  assert.match(heroAstro, /Libros difíciles de encontrar\./);
  assert.match(heroAstro, /Los conseguimos\./);
  assert.match(heroAstro, /Título, autor o ISBN/);
  assert.match(heroAstro, /una persona de Amado Libros revisa opciones/i);
  assert.match(heroAstro, /¿No aparece en el catálogo\?/);
  assert.match(heroAstro, /Pedir una búsqueda/);
  assert.match(heroAstro, /agotado o descatalogado/);
  assert.match(heroAstro, /href="\/pedir-libro\/\?tipo=exacto"/);
  assert.doesNotMatch(heroAstro, /automátic|gratuit/i);
});

test('la escena visual usa tapas reales, movimiento progresivo y alternativa sin animación', () => {
  assert.match(heroAstro, /pickRecentBooks/);
  assert.match(heroAstro, /responsiveBookCover/);
  assert.match(heroAstro, /class={`hero-book hero-book-\$\{index \+ 1\}`}/);
  assert.match(heroAstro, /@keyframes hero-book-float/);
  assert.match(heroAstro, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(heroAstro, /loading=\{index < 3 \? 'eager' : 'lazy'\}/);
  assert.match(heroAstro, /fetchpriority=\{index === 0 \? 'high' : 'auto'\}/);
  assert.doesNotMatch(heroAstro, /<video|youtube|vimeo/i);
});

test('en mobile la búsqueda y el encargo siguen antes de la escena de tapas', () => {
  assert.match(heroAstro, /@media \(max-width: 620px\)/);
  assert.match(heroAstro, /\.hero-search button \{\s*grid-column: 1 \/ -1;\s*width: 100%;/);
  assert.match(heroAstro, /\.hero-request \{\s*grid-template-columns: auto minmax\(0, 1fr\);/);
  assert.ok(heroAstro.indexOf('<div class="hero-copy">') < heroAstro.indexOf('<div class="hero-visual"'));
  assert.doesNotMatch(heroAstro, /min-height:\s*calc\(100svh/);
});

test('la cabecera de home ofrece navegación editorial y grilla horizontal de temas', () => {
  assert.match(homeAstro, /<Header showSearch=\{false\} \/>/);
  assert.match(headerAstro, /const homeMode = !showSearch/);
  assert.match(headerAstro, /<AnnouncementBar editorial=\{homeMode\} \/>/);
  for (const label of ['Libros', 'Temas', 'Recomendados', 'Ideas', 'Pedir un libro', 'Nosotros']) {
    assert.match(headerAstro, new RegExp(label));
  }
  for (const label of ['Literatura', 'Psicología', 'Medicina', 'Infantiles', 'Tarot y oráculos', 'Biblias', 'Idiomas']) {
    assert.match(headerAstro, new RegExp(label));
  }
  assert.match(headerAstro, /<details class="editorial-menu">/);
  assert.match(headerAstro, /class="subject-strip"/);
});

test('la cinta editorial combina beneficios reales sin alterar la barra interna', () => {
  assert.match(announcementAstro, /editorial \?/);
  assert.match(announcementAstro, /Envío gratis desde \$1\.500/);
  assert.match(announcementAstro, /Envíos en el día en Montevideo/);
  assert.match(announcementAstro, /Libros importados y búsquedas por encargo/);
  assert.match(announcementAstro, /@keyframes amado-editorial-ticker/);
  assert.match(announcementAstro, /prefers-reduced-motion/);
  assert.match(announcementAstro, /aria-label="Beneficio de envío"/);
});

test('libros, temas e ideas forman el primer recorrido editorial', () => {
  const heroPosition = homeAstro.indexOf('<Hero />');
  const booksPosition = homeAstro.indexOf('<BestsellerSection />');
  const topicsPosition = homeAstro.indexOf('<CategoryAccess />');
  const ideasPosition = homeAstro.indexOf('<AmadoLee />');

  assert.ok(heroPosition >= 0);
  assert.ok(booksPosition > heroPosition);
  assert.ok(topicsPosition > booksPosition);
  assert.ok(ideasPosition > topicsPosition);
  assert.match(homeAstro, /id="temas"/);
  assert.match(categoryAccessAstro, /Encontrá más rápido tu próxima lectura/);
});

test('la selección reciente muestra tapas grandes con precio y enlace a ficha', () => {
  assert.match(recentAstro, /Libros que acaban de llegar/);
  assert.match(recentAstro, /class="editorial-rail"/);
  assert.match(recentAstro, /responsiveBookCover/);
  assert.match(recentAstro, /displayPrice/);
  assert.match(recentAstro, /Ver libro/);
  assert.match(recentAstro, /scroll-snap-type: x mandatory/);
});

test('Amado Lee usa contenido propio y enlaza guías existentes', () => {
  assert.match(amadoLeeAstro, />Amado Lee</);
  assert.match(amadoLeeAstro, /\/como-identificar-edicion-correcta-isbn/);
  assert.match(amadoLeeAstro, /\/libros-agotados-importados-uruguay/);
  assert.match(amadoLeeAstro, /\/quienes-somos/);
  assert.match(amadoLeeAstro, /siempre enlazamos al artículo original/);
  assert.doesNotMatch(amadoLeeAstro, /Letras Libres|El País|Babelia/);
});

test('una portada de origen ausente no deja una imagen rota', () => {
  assert.match(bookCardAstro, /this\.src='\/images\/logo-amado\.webp'/);
  assert.match(bookCardAstro, /bc-img-fallback/);
  assert.match(heroAstro, /this\.src='\/images\/logo-amado\.webp'/);
  assert.match(recentAstro, /this\.src='\/images\/logo-amado\.webp'/);
});

test('el buscador del hero conserva la superficie expandida existente', () => {
  assert.match(heroAstro, /amado:openCatalogSearch/);
  assert.match(heroAstro, /detail: \{ query: input\.value\.trim\(\) \}/);
  assert.match(catalogSearchOverlayAstro, /max-width: 820px/);
  assert.match(catalogSearchOverlayAstro, /¿Qué libro estás buscando\?/);
  assert.match(catalogSearchOverlayAstro, /typeof event\.detail\.query === 'string'/);
});

test('el bloque comercial conserva beneficios con condiciones explícitas', () => {
  assert.match(commercialAstro, /Biblias seleccionadas en aprox\. 2 horas/);
  assert.match(commercialAstro, /stock, zona, horario y disponibilidad/);
  assert.match(commercialAstro, /Hasta 12 cuotas/);
  assert.match(commercialAstro, /12% menos por transferencia/);
  assert.match(commercialAstro, /Cuando corresponda para ese producto/);
  assert.match(commercialAstro, /Libros por encargo/);
  assert.doesNotMatch(commercialAstro, /cuotas sin interés|cuotas sin recargo/i);
});
