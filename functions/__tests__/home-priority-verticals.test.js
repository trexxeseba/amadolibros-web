import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../../astro-front/src/components/CategoryAccess.astro', import.meta.url));
const source = readFileSync(file, 'utf8');

test('Tarot y Biblias son los dos primeros accesos de categoría de la portada', () => {
  const tarot = source.indexOf("'esoterismo-tarot'");
  const bibles = source.indexOf("'religion-espiritualidad'");
  const children = source.indexOf("'infantil-juvenil'");
  assert.ok(tarot > -1 && bibles > tarot && children > bibles);
});

test('los nombres comerciales explican las dos verticales sin cambiar sus URLs', () => {
  assert.match(source, /displayName: 'Tarot y oráculos'/);
  assert.match(source, /scope: 'Mazos, oráculos y libros de esoterismo'/);
  assert.match(source, /displayName: 'Biblias y religión'/);
  assert.match(source, /scope: 'Reina-Valera, católicas y libros de religión'/);
  assert.match(source, /href={`\/libros\/\$\{encodeURIComponent\(cat\.id\)\}`}/);
  assert.doesNotMatch(source, /href="\/tarot"|href="\/oraculos"|href="\/biblias"/);
});

test('sólo las verticales prioritarias reciben el tratamiento visual destacado', () => {
  assert.match(source, /featured: Boolean\(presentation\)/);
  assert.match(source, /ca-chip\$\{cat\.featured \? ' ca-chip-featured' : ''\}/);
  assert.match(source, /data-priority-vertical={cat\.featured \? cat\.id : undefined}/);
  assert.match(source, /scope: presentation\?\.scope \|\| 'Disponibles y por encargo'/);
});
