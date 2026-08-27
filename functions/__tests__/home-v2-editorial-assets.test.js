import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = relativePath => readFileSync(path.join(ROOT, relativePath), 'utf8');

const hero = read('astro-front/src/components/Hero.astro');
const header = read('astro-front/src/components/Header.astro');
const ideas = read('astro-front/src/components/AmadoLee.astro');

test('HOME-V2 no incorpora recursos visuales de las webs de referencia', () => {
  const combined = `${hero}\n${header}\n${ideas}`;
  assert.doesNotMatch(combined, /princeton|lastbookstore|tiemsach|artbook|awwwards/i);
  assert.doesNotMatch(combined, /https?:\/\/(?!www\.amadolibros\.com)/i);
});

test('HOME-V2 mantiene el movimiento en CSS y no agrega una isla hidratada', () => {
  const combined = `${hero}\n${header}\n${ideas}`;
  assert.doesNotMatch(combined, /client:(load|idle|visible|media|only)/);
  assert.doesNotMatch(combined, /import\s+.*from\s+['"](?:gsap|framer-motion|swiper|lottie)/i);
  assert.match(hero, /prefers-reduced-motion/);
  assert.match(ideas, /prefers-reduced-motion/);
});
