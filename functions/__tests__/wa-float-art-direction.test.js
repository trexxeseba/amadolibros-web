import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const waFloatAstro = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'components', 'WAFloat.astro'),
  'utf8',
);
const homeAstro = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'pages', 'index.astro'),
  'utf8',
);

test('HOME-ARTE-3: la home saca el WhatsApp flotante del primer viewport', () => {
  assert.doesNotMatch(homeAstro, /import\s+WAFloat\s+from/);
  assert.doesNotMatch(homeAstro, /<WAFloat\s*\/>/);
});

test('HOME-ARTE-3: donde se conserva, el flotante reduce su huella visual', () => {
  assert.match(waFloatAstro, /width:\s*44px/);
  assert.match(waFloatAstro, /height:\s*44px/);
  assert.match(waFloatAstro, /background:\s*var\(--surface\)/);
  assert.match(waFloatAstro, /color:\s*var\(--wa\)/);
  assert.doesNotMatch(waFloatAstro, /width:\s*56px|height:\s*56px/);
});

test('HOME-ARTE-3: escritorio conserva acceso directo sin volver a una píldora dominante', () => {
  assert.match(waFloatAstro, /@media \(min-width: 768px\)/);
  assert.match(waFloatAstro, /width:\s*48px/);
  assert.match(waFloatAstro, /height:\s*48px/);
  assert.doesNotMatch(waFloatAstro, /width:\s*auto|display:\s*inline;\s*font-size:\s*0\.9375rem/);
});

test('HOME-ARTE-3: conserva accesibilidad, safe-area y el contrato de WhatsApp', () => {
  assert.match(waFloatAstro, /class="wa-float"/);
  assert.match(waFloatAstro, /aria-label="Consultar por WhatsApp"/);
  assert.match(waFloatAstro, /target="_blank"/);
  assert.match(waFloatAstro, /rel="noopener noreferrer"/);
  assert.match(waFloatAstro, /buildWhatsAppMessage/);
  assert.match(waFloatAstro, /whatsappHref/);
  assert.match(waFloatAstro, /env\(safe-area-inset-bottom, 0px\)/);
  assert.match(waFloatAstro, /env\(safe-area-inset-right, 0px\)/);
  assert.match(waFloatAstro, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(waFloatAstro, /:focus-visible/);
});