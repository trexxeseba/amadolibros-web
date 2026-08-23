import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../../astro-front/src/components/CategoryAccess.astro', import.meta.url));
const source = readFileSync(file, 'utf8');

test('la portada abre con accesos distintos para Tarot, Biblias y Reina-Valera', () => {
  const tarot = source.indexOf("id: 'tarot'");
  const bibles = source.indexOf("id: 'biblias'");
  const reinaValera = source.indexOf("id: 'reina-valera'");
  const psychology = source.indexOf("id: 'psicologia'");
  assert.ok(tarot > -1 && bibles > tarot && reinaValera > bibles && psychology > reinaValera);
});

test('Tarot conserva su landing consolidada y Biblias usa filtros sin crear URLs caníbales', () => {
  assert.match(source, /name: 'Tarot y oráculos'/);
  assert.match(source, /href: '\/libros\/esoterismo-tarot'/);
  assert.match(source, /href: '\/catalogo\?categoria=religion-espiritualidad&subcategoria=biblia'/);
  assert.match(source, /href: '\/catalogo\?categoria=religion-espiritualidad&subcategoria=reina-valera'/);
  assert.match(source, /href={`\/libros\/\$\{encodeURIComponent\(cat\.id\)\}`}/);
  assert.doesNotMatch(source, /href="\/tarot"|href="\/oraculos"|href="\/biblias"/);
});

test('Cábala y Sufismo son accesos secundarios reales dentro de Esoterismo', () => {
  assert.match(source, /subcategoria=cabala-kabbalah/);
  assert.match(source, /subcategoria=sufismo/);
  assert.match(source, /name: 'Cábala y Kabbalah'/);
  assert.match(source, /name: 'Sufismo'/);
});

test('la portada enlaza incorporaciones reales y no las llama más vendidos', () => {
  assert.match(source, /href: '#incorporaciones-recientes'/);
  assert.match(source, /name: 'Incorporaciones recientes'/);
  assert.doesNotMatch(source, /más vendidos|bestsellers/i);
});
