// Contrato del primer pantallazo comercial de la portada.
//
// Hero.astro no se puede importar directamente con node --test. Estas pruebas
// estructurales fijan el mensaje comercial aprobado y el CTA guiado sin
// depender de un navegador ni de servicios externos.
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
const commercialAstro = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'components', 'CommercialBenefits.astro'),
  'utf8',
);
const homeAstro = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'pages', 'index.astro'),
  'utf8',
);
const headerAstro = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'components', 'Header.astro'),
  'utf8',
);
const bookCardAstro = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'components', 'BookCard.astro'),
  'utf8',
);
const categoryAccessAstro = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'components', 'CategoryAccess.astro'),
  'utf8',
);
const announcementAstro = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'components', 'AnnouncementBar.astro'),
  'utf8',
);
const catalogSearchOverlayAstro = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'components', 'CatalogSearchOverlay.astro'),
  'utf8',
);

test('el primer pantallazo prioriza búsqueda y categorías, no el bloque comercial', () => {
  assert.match(heroAstro, /<CategoryAccess \/>/);
  assert.match(heroAstro, /Título, autor o ISBN/);
  assert.match(heroAstro, /Libros difíciles de encontrar\./);
  assert.match(heroAstro, /Los conseguimos\./);
  assert.match(heroAstro, /títulos importados disponibles en Uruguay/i);
  assert.match(heroAstro, /¿No aparece en el catálogo\?/);
  assert.match(heroAstro, /Pedir una búsqueda/);
  assert.doesNotMatch(heroAstro, /Tarot, Biblias y libros difíciles/);
  assert.doesNotMatch(heroAstro, /Librería uruguaya · compra online/);
  assert.doesNotMatch(headerAstro, /class="brand-sub"/);
  assert.doesNotMatch(categoryAccessAstro, /Entrá por lo que estás buscando/);
  assert.match(categoryAccessAstro, /Encontrá más rápido tu próxima lectura/);
  assert.doesNotMatch(heroAstro, /Claro, rápido y con atención personal/);
  assert.ok(homeAstro.indexOf('<CommercialBenefits />') > homeAstro.indexOf('<BookDiscovery />'));
});

test('en 390px el hero mantiene búsqueda y encargo utilizables antes de las categorías', () => {
  assert.match(heroAstro, /@media \(max-width: 430px\)/);
  assert.match(heroAstro, /\.hero-search button \{\s*grid-column: 1 \/ -1;\s*width: 100%;/);
  assert.match(heroAstro, /\.hero-request \{\s*grid-template-columns: 1fr;/);
  assert.doesNotMatch(heroAstro, /min-height:\s*calc\(100svh/);
  assert.ok(heroAstro.indexOf('<div class="hero-content">') < heroAstro.indexOf('<CategoryAccess />'));
});

test('la cinta superior es estática y prioriza el beneficio de envío', () => {
  const visibleAnnouncement = announcementAstro.match(/<aside[\s\S]*?<\/aside>/)?.[0] || '';

  assert.match(headerAstro, /<AnnouncementBar \/>/);
  assert.match(visibleAnnouncement, /Envío gratis desde \$1\.500/);
  assert.doesNotMatch(visibleAnnouncement, /Hasta 12 cuotas|12% menos por transferencia|Entrega coordinada/);
  assert.doesNotMatch(announcementAstro, /<script\b|animation:/i);
  assert.doesNotMatch(announcementAstro, /2 horas|entrega express/i);
});

test('el header de portada queda compacto y reserva la búsqueda principal para el hero', () => {
  assert.match(headerAstro, /logo-amado\.webp/);
  assert.match(headerAstro, /showSearch = true/);
  assert.match(headerAstro, /\{showSearch && \(/);
  assert.match(homeAstro, /<Header showSearch=\{false\} \/>/);
  assert.match(headerAstro, /height: 56px/);
  assert.doesNotMatch(headerAstro, /Bienvenido a Amado Libros/);
  assert.doesNotMatch(headerAstro, /amado-cat-reading-lounge|amado-cat-reading-seated|amado-cat-welcome/);
});

test('una portada de origen ausente no deja una imagen rota en la vidriera', () => {
  assert.match(bookCardAstro, /this\.src='\/images\/logo-amado\.webp'/);
  assert.match(bookCardAstro, /bc-img-fallback/);
});

test('el buscador del hero abre una superficie blanca amplia con el texto preservado', () => {
  assert.match(heroAstro, /amado:openCatalogSearch/);
  assert.match(heroAstro, /detail: \{ query: input\.value\.trim\(\) \}/);
  assert.match(catalogSearchOverlayAstro, /max-width: 820px/);
  assert.match(catalogSearchOverlayAstro, /¿Qué libro estás buscando\?/);
  assert.match(catalogSearchOverlayAstro, /typeof event\.detail\.query === 'string'/);
  assert.match(catalogSearchOverlayAstro, /@media \(max-width: 599px\)/);
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

test('los CTA de encargos inician el formulario guiado y explican el servicio', () => {
  assert.match(heroAstro, /href="\/pedir-libro\/\?tipo=exacto"/);
  assert.match(commercialAstro, /href="\/pedir-libro\/\?tipo=exacto"/);
  assert.match(commercialAstro, /Buscamos agotados, importados y ediciones difíciles/i);
  assert.match(commercialAstro, />\s*Contanos qué libro buscás\s*</);
  assert.match(commercialAstro, /href="\/libros-agotados-importados-uruguay"/);
  assert.match(commercialAstro, /Cómo funciona nuestro servicio de encargos/);
  assert.doesNotMatch(`${heroAstro}\n${commercialAstro}`, /https:\/\/wa\.me/);
});
