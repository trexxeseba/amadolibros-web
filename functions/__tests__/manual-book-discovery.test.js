import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = relativePath => readFileSync(path.join(ROOT, relativePath), 'utf8');
const home = read('astro-front/src/pages/index.astro');
const hero = read('astro-front/src/components/HomeV2Hero.astro');
const topics = read('astro-front/src/components/HomeV2Topics.astro');
const shelf = read('astro-front/src/components/HomeV2Shelf.astro');
const ideas = read('astro-front/src/components/HomeV2Ideas.astro');
const requestPage = read('astro-front/src/pages/pedir-libro.astro');
const footer = read('astro-front/src/components/Footer.astro');

test('la portada V2 incorpora descubrimiento editorial mobile-first', () => {
  assert.match(home, /import HomeV2Topics/);
  assert.match(home, /<HomeV2Topics\s*\/>/);
  assert.match(topics, /Todo empieza por una curiosidad\./);
  assert.equal((topics.match(/title: '/g) || []).length, 8);
  assert.match(topics, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(topics, /@media \(min-width: 700px\)/);
  assert.match(topics, /@media \(min-width: 1100px\)/);
});

test('la portada ordena búsqueda, temas, libros e ideas en un recorrido coherente', () => {
  const heroPosition = home.indexOf('<HomeV2Hero />');
  const topicsPosition = home.indexOf('<HomeV2Topics />');
  const booksPosition = home.indexOf('<HomeV2Shelf />');
  const ideasPosition = home.indexOf('<HomeV2Ideas />');

  assert.ok(heroPosition >= 0, 'falta el buscador principal');
  assert.ok(topicsPosition > heroPosition, 'los temas deben seguir al hero');
  assert.ok(booksPosition > topicsPosition, 'la estantería debe seguir a los temas');
  assert.ok(ideasPosition > booksPosition, 'Amado Lee debe seguir a los libros');
  assert.match(hero, /una persona revisa opciones y lo busca por encargo/);
  assert.match(shelf, /Tapas que piden que las mires\./);
  assert.match(ideas, /Ideas, guías y caminos entre libros\./);
});

test('los accesos editoriales cubren diferenciales concretos y conducen al formulario', () => {
  for (const topic of ['Literatura y ficción', 'Psicología', 'Tarot y oráculos', 'Medicina y salud', 'Infantiles y juveniles', 'Biblias y espiritualidad', 'Idiomas', 'Libros agotados']) {
    assert.match(topics, new RegExp(topic));
  }
  assert.match(hero, /href="\/pedir-libro\/\?tipo=exacto"/);
  assert.match(ideas, /href="\/pedir-libro\/\?tipo=exacto"/);
  assert.match(ideas, /No es una respuesta automática/i);
});

test('el pedido ordena los datos y termina en WhatsApp sin guardar información', () => {
  for (const field of ['request_type', 'query', 'author_isbn', 'format', 'language', 'budget', 'details']) {
    assert.match(requestPage, new RegExp(`name="${field}"`));
  }
  assert.match(requestPage, /Este formulario no guarda datos en la web/);
  assert.match(requestPage, /https:\/\/wa\.me\/\$\{WA_NUMBER\}\?text=/);
  assert.match(requestPage, /const WA_NUMBER = '59899841325'/);
  assert.doesNotMatch(requestPage, /Claude|Anthropic|anthropic/i);
  assert.doesNotMatch(requestPage, /localStorage|sessionStorage/);
});

test('el formulario recupera búsquedas sin resultado y conserva acceso desde el footer', () => {
  assert.match(requestPage, /params\.get\('q'\)/);
  assert.match(requestPage, /requestedType === 'sin-resultados'/);
  assert.match(footer, /href="\/pedir-libro\/"/);
  assert.match(footer, /¿No encontraste el libro\?/);
});
