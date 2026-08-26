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
const categoryAccessAstro = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'components', 'CategoryAccess.astro'),
  'utf8',
);

test('el primer pantallazo prioriza búsqueda y categorías, no el bloque comercial', () => {
  assert.match(heroAstro, /<CategoryAccess \/>/);
  assert.match(heroAstro, /Título, autor o ISBN/);
  assert.match(heroAstro, /Libros difíciles de encontrar\. Los conseguimos\./);
  assert.match(heroAstro, /Miles de títulos importados disponibles en Uruguay/);
  assert.match(heroAstro, /¿No aparece\?/);
  assert.doesNotMatch(heroAstro, /Tarot, Biblias y libros difíciles/);
  assert.doesNotMatch(heroAstro, /Librería uruguaya · compra online/);
  assert.doesNotMatch(headerAstro, /class="brand-sub"/);
  assert.doesNotMatch(categoryAccessAstro, /Entrá por lo que estás buscando/);
  assert.match(categoryAccessAstro, /Encontrá más rápido tu próxima lectura/);
  assert.doesNotMatch(heroAstro, /Claro, rápido y con atención personal/);
  assert.ok(homeAstro.indexOf('<CommercialBenefits />') > homeAstro.indexOf('<BookDiscovery />'));
});

test('en 390px el bloque de búsqueda ocupa el primer pantallazo antes de las categorías', () => {
  assert.match(heroAstro, /@media \(max-width: 430px\)/);
  assert.match(heroAstro, /min-height: calc\(100svh - 110px\)/);
  assert.ok(heroAstro.indexOf('<div class="hero-content">') < heroAstro.indexOf('<CategoryAccess />'));
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
  assert.match(heroAstro, /href="\/pedir-libro\?tipo=exacto"/);
  assert.match(commercialAstro, /href="\/pedir-libro\?tipo=exacto"/);
  assert.match(commercialAstro, /Buscamos agotados, importados y ediciones difíciles/i);
  assert.match(commercialAstro, />\s*Contanos qué libro buscás\s*</);
  assert.match(commercialAstro, /href="\/libros-agotados-importados-uruguay"/);
  assert.match(commercialAstro, /Cómo funciona nuestro servicio de encargos/);
  assert.doesNotMatch(`${heroAstro}\n${commercialAstro}`, /https:\/\/wa\.me/);
});
