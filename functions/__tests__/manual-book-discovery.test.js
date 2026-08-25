import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = relativePath => readFileSync(path.join(ROOT, relativePath), 'utf8');
const home = read('astro-front/src/pages/index.astro');
const discovery = read('astro-front/src/components/BookDiscovery.astro');
const requestPage = read('astro-front/src/pages/pedir-libro.astro');
const footer = read('astro-front/src/components/Footer.astro');

test('la portada incorpora descubrimiento por preguntas mobile-first', () => {
  assert.match(home, /import BookDiscovery/);
  assert.match(home, /<BookDiscovery\s*\/>/);
  assert.match(discovery, /¿Qué libro querés que encontremos\?/);
  assert.equal((discovery.match(/type: '/g) || []).length, 6);
  assert.match(discovery, /grid-template-columns: 1fr/);
  assert.match(discovery, /@media \(min-width: 650px\)/);
  assert.match(discovery, /@media \(min-width: 980px\)/);
});

test('la portada prioriza búsqueda con categorías integradas y libros antes del descubrimiento asistido', () => {
  const heroPosition = home.indexOf('<Hero />');
  const booksPosition = home.indexOf('<BestsellerSection />');
  const discoveryPosition = home.indexOf('<BookDiscovery />');
  const hero = read('astro-front/src/components/Hero.astro');

  assert.ok(heroPosition >= 0, 'falta el buscador principal');
  assert.match(hero, /import CategoryAccess/);
  assert.match(hero, /<CategoryAccess \/>/);
  assert.ok(booksPosition > heroPosition, 'los libros deben seguir al hero de búsqueda y categorías');
  assert.ok(discoveryPosition > booksPosition, 'las preguntas deben aparecer después de los libros');
});

test('las preguntas cubren diferenciales concretos y conducen al formulario', () => {
  for (const type of ['agotado', 'novedades-tecnicas', 'digital', 'antiguo', 'tapa', 'bibliografia']) {
    assert.match(discovery, new RegExp(`type: '${type}'`));
  }
  assert.match(discovery, /href={`\/pedir-libro\?tipo=\$\{question\.type\}`}/);
  assert.match(discovery, /una persona de Amado Libros hace la búsqueda/i);
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
  assert.match(footer, /href="\/pedir-libro"/);
  assert.match(footer, /¿No encontraste el libro\?/);
});
