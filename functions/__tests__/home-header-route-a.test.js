import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const headerAstro = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'components', 'Header.astro'),
  'utf8',
);
const announcementAstro = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'components', 'AnnouncementBar.astro'),
  'utf8',
);

test('HOME-ARTE-1: la barra superior queda fija en 32 px con un único mensaje', () => {
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

test('HOME-ARTE-1: el header queda en 56 px con marca y carrito', () => {
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
