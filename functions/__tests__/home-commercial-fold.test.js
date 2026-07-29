// Contrato del primer pantallazo comercial de la portada.
//
// Hero.astro no se puede importar directamente con node --test. Estas pruebas
// estructurales fijan el mensaje comercial aprobado y el CTA de WhatsApp sin
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

test('Hero: muestra las cuatro ventajas comerciales sin prometer cuotas sin interés', () => {
  assert.match(heroAstro, /Entrega en 2 horas/);
  assert.match(heroAstro, /Hasta 12 cuotas/);
  assert.match(heroAstro, /12% menos/);
  assert.match(heroAstro, /Libros por encargo/);
  assert.doesNotMatch(heroAstro, /cuotas sin interés/i);
});

test('Hero: el CTA de encargos abre WhatsApp con los datos necesarios prellenados', () => {
  assert.match(heroAstro, /https:\/\/wa\.me\/59899841325\?text=/);
  assert.match(heroAstro, /encodeURIComponent\(requestText\)/);
  assert.match(heroAstro, /título, autor, ISBN o una foto de la tapa/i);
  assert.match(heroAstro, />\s*Pedir un libro por WhatsApp\s*</);
  assert.match(heroAstro, /target="_blank"/);
  assert.match(heroAstro, /rel="noopener noreferrer"/);
});
