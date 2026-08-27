import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const orderHub = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'components', 'OrderHubAccess.astro'),
  'utf8',
);

test('HOME-ARTE-7: el servicio se presenta con el copy humano aprobado', () => {
  assert.match(orderHub, /Tu búsqueda nos importa/);
  assert.match(orderHub, /Nos gusta buscar esos libros que no aparecen fácil\./);
  assert.match(orderHub, /No es promesa automática ni magia\./);
  assert.match(orderHub, /Es trabajo, paciencia y ganas de ayudarte a conseguirlo\./);
  assert.doesNotMatch(orderHub, /especialista|experto|inteligencia artificial|automáticamente/i);
});

test('HOME-ARTE-7: conserva una condición comercial verificable y prudente', () => {
  assert.match(orderHub, /La disponibilidad, el precio y el plazo se confirman antes de iniciar cualquier encargo\./);
  assert.doesNotMatch(orderHub, /garantizamos|siempre conseguimos|seguro que lo encontramos/i);
});

test('HOME-ARTE-7: el CTA lleva al pedido exacto sin abrir un canal paralelo', () => {
  assert.match(orderHub, /href="\/pedir-libro\/\?tipo=exacto"/);
  assert.match(orderHub, /Contanos qué libro buscás/);
  assert.doesNotMatch(orderHub, /wa\.me|api\.whatsapp/);
});

test('HOME-ARTE-7: el bloque consume los tokens del sistema visual', () => {
  assert.match(orderHub, /background:\s*var\(--surface\)/);
  assert.match(orderHub, /border:\s*1px solid var\(--border\)/);
  assert.match(orderHub, /color:\s*var\(--ink\)/);
  assert.match(orderHub, /background:\s*var\(--salmon\)/);
  assert.match(orderHub, /font-family:\s*var\(--font-display\)/);
  assert.doesNotMatch(orderHub, /#fff8f4|#ead5ca|#a94e3d|#342820|#e49982/i);
});
