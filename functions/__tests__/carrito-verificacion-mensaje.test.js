import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../astro-front/src/pages/carrito.astro', import.meta.url), 'utf8');

test('carrito: la verificación humana avisa cuando tarda y se puede reintentar', () => {
  assert.match(src, /id="cf-ts-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(src, /Estamos verificando que sos una persona/);
  assert.match(src, /setTimeout\(function \(\) \{\s*tsShowStatus\(/);
  assert.doesNotMatch(src, /Recargá la página e intentá de nuevo/);
  assert.equal((src.match(/No pudimos completar la verificación de seguridad/g) || []).length, 2);
});

test('carrito: el aviso se borra al terminar la verificación', () => {
  assert.match(src, /var done = function \(\) \{ clearTimeout\(notice\); tsShowStatus\(''\); \}/);
});
