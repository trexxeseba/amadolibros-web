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

test('el primer pantallazo prioriza catálogo y búsqueda humana por encargo', () => {
  assert.match(heroAstro, /<CategoryAccess \/>/);
  assert.match(heroAstro, /Libros importados y búsquedas por encargo/);
  assert.match(heroAstro, /Libros difíciles de encontrar\./);
  assert.match(heroAstro, /Los conseguimos\./);
  assert.match(heroAstro, /Buscá en nuestro catálogo\./);
  assert.match(heroAstro, /revisamos opciones para ayudarte a encontrarlo/);
  assert.match(heroAstro, /Título, autor o ISBN/);
  assert.match(heroAstro, />Buscar libro</);
  assert.match(heroAstro, /¿No aparece en el catálogo\?/);
  assert.match(heroAstro, /La búsqueda por encargo la revisamos personalmente\./);
  assert.match(heroAstro, /Pedir una búsqueda →/);
  assert.doesNotMatch(heroAstro, /16\.000|16000/);
  assert.doesNotMatch(heroAstro, /automátic|gratuit/i);
  assert.doesNotMatch(heroAstro, /Tarot, Biblias y libros difíciles/);
  assert.doesNotMatch(headerAstro, /class="brand-sub"/);
  assert.doesNotMatch(categoryAccessAstro, /Entrá por lo que estás buscando/);
  assert.match(categoryAccessAstro, /Encontrá más rápido tu próxima lectura/);
  assert.ok(homeAstro.indexOf('<CommercialBenefits />') > homeAstro.indexOf('<BookDiscovery />'));
});

test('la escala del hero respeta 34 px en 375 mobile y 56 px en desktop', () => {
  assert.match(heroAstro, /@media \(max-width: 430px\)/);
  assert.match(heroAstro, /font-size: clamp\(2\.125rem, 9vw, 2\.4rem\)/);
  assert.match(heroAstro, /@media \(min-width: 700px\)[\s\S]*?\.hero-h1\s*\{[\s\S]*?font-size:\s*3\.5rem/);
  assert.match(heroAstro, /padding: 1\.65rem 0\.25rem 2rem/);
  assert.doesNotMatch(heroAstro, /100svh|100vh/);
  assert.doesNotMatch(heroAstro, /font-size:\s*clamp\(4\.5rem|font-size:\s*5\.4rem/);
  assert.ok(heroAstro.indexOf('<div class="hero-content">') < heroAstro.indexOf('<CategoryAccess />'));
});

test('el hero conserva visibles los tres beneficios que luego saldrán de la marquesina', () => {
  assert.match(heroAstro, /Hasta 12 cuotas con Mercado Pago/);
  assert.match(heroAstro, /12% menos por transferencia/);
  assert.match(heroAstro, /Entrega coordinada en Montevideo/);
  assert.match(heroAstro, /class="hero-benefits"/);
  assert.doesNotMatch(heroAstro, /cuotas sin interés|cuotas sin recargo/i);
});

test('la cinta superior muestra los cuatro beneficios comerciales aprobados', () => {
  assert.match(headerAstro, /<AnnouncementBar \/>/);
  assert.match(announcementAstro, /Hasta 12 cuotas con Mercado Pago/);
  assert.match(announcementAstro, /12% menos por transferencia/);
  assert.match(announcementAstro, /Envío \$250 · gratis desde \$1\.500/);
  assert.match(announcementAstro, /Entrega coordinada en Montevideo/);
  assert.match(announcementAstro, /prefers-reduced-motion/);
  assert.doesNotMatch(announcementAstro, /2 horas|entrega express/i);
});

test('el header de portada recibe con tres gatos sin competir con las acciones', () => {
  assert.match(headerAstro, /Bienvenido a Amado Libros/);
  assert.match(headerAstro, /amado-cat-reading-lounge-v1\.webp/);
  assert.match(headerAstro, /amado-cat-reading-seated-v1\.webp/);
  assert.match(headerAstro, /amado-cat-welcome-v1\.webp/);
  assert.match(headerAstro, /!showSearch/);
  assert.match(headerAstro, /@media \(max-width: 700px\)/);
  assert.match(headerAstro, /\.header-welcome \{\s*display: none;/);
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
  assert.match(heroAstro, /Pedir una búsqueda →/);
  assert.match(heroAstro, /revisamos personalmente/);
  assert.match(commercialAstro, /href="\/pedir-libro\/\?tipo=exacto"/);
  assert.match(commercialAstro, /Buscamos agotados, importados y ediciones difíciles/i);
  assert.match(commercialAstro, />\s*Contanos qué libro buscás\s*</);
  assert.match(commercialAstro, /href="\/libros-agotados-importados-uruguay"/);
  assert.match(commercialAstro, /Cómo funciona nuestro servicio de encargos/);
  assert.doesNotMatch(`${heroAstro}\n${commercialAstro}`, /https:\/\/wa\.me/);
});