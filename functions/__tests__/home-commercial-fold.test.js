// Contratos estructurales de la portada que no pertenecen al hero.
// HOME-ARTE-1 es dueño de header/barra; HOME-ARTE-2 mantiene su contrato
// de hero en un archivo separado para que ambos lotes puedan fusionarse sin
// expectativas cruzadas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const commercialAstro = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'components', 'CommercialBenefits.astro'),
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
const announcementAstro = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'components', 'AnnouncementBar.astro'),
  'utf8',
);

test('HOME-ARTE-1: la cinta superior prioriza un beneficio fijo y deja documentados los restantes', () => {
  assert.match(headerAstro, /<AnnouncementBar \/>/);
  assert.match(announcementAstro, /Envío gratis desde \$1\.500/);
  assert.match(announcementAstro, /Hasta 12 cuotas con Mercado Pago/);
  assert.match(announcementAstro, /12% menos por transferencia/);
  assert.match(announcementAstro, /Entrega coordinada en Montevideo/);
  assert.match(announcementAstro, /height: 32px/);
  assert.match(announcementAstro, /background: #1F1B18/);
  assert.match(announcementAstro, /color: #FAF6EF/);
  assert.doesNotMatch(announcementAstro, /@keyframes|animation:/);
  assert.doesNotMatch(announcementAstro, /2 horas|entrega express/i);
});

test('HOME-ARTE-1: el header queda reducido a marca y carrito sin decoración ni WhatsApp duplicado', () => {
  assert.match(headerAstro, /<CartIcon \/>/);
  assert.match(headerAstro, /height: 56px/);
  assert.match(headerAstro, /logo-amado\.webp/);
  assert.doesNotMatch(headerAstro, /Bienvenido a Amado Libros/);
  assert.doesNotMatch(headerAstro, /amado-cat-reading-lounge-v1\.webp/);
  assert.doesNotMatch(headerAstro, /amado-cat-reading-seated-v1\.webp/);
  assert.doesNotMatch(headerAstro, /amado-cat-welcome-v1\.webp/);
  assert.doesNotMatch(headerAstro, /class="wa-btn"/);
  assert.doesNotMatch(headerAstro, /whatsappHref|buildWhatsAppMessage/);
});

test('una portada de origen ausente no deja una imagen rota en la vidriera', () => {
  assert.match(bookCardAstro, /this\.src='\/images\/logo-amado\.webp'/);
  assert.match(bookCardAstro, /bc-img-fallback/);
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

test('el bloque comercial de encargos inicia el formulario y explica el servicio', () => {
  assert.match(commercialAstro, /href="\/pedir-libro\/\?tipo=exacto"/);
  assert.match(commercialAstro, /Buscamos agotados, importados y ediciones difíciles/i);
  assert.match(commercialAstro, />\s*Contanos qué libro buscás\s*</);
  assert.match(commercialAstro, /href="\/libros-agotados-importados-uruguay"/);
  assert.match(commercialAstro, /Cómo funciona nuestro servicio de encargos/);
  assert.doesNotMatch(commercialAstro, /https:\/\/wa\.me/);
});
