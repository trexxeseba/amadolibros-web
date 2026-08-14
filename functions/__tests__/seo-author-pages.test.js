import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAuthorPage, selectAuthorBooks } from '../_shared/author-page.js';
import {
  authorPageById,
  authorPageByName,
  authorPathForName,
  SEO_AUTHORS,
} from '../_shared/seo-authors.js';
import { STATIC_SITEMAP_PAGES } from '../sitemap-pages.xml.js';

function book(id, author, overrides = {}) {
  return {
    id,
    title: `Libro ${id}`,
    author,
    price: 1500,
    status: 'active',
    available_quantity: 1,
    pictures: [`https://http2.mlstatic.com/D_${id}-O.jpg`],
    ...overrides,
  };
}

test('el piloto contiene exactamente cinco autores con rutas únicas', () => {
  assert.equal(SEO_AUTHORS.length, 5);
  assert.equal(new Set(SEO_AUTHORS.map(item => item.path)).size, 5);
  assert.deepEqual(SEO_AUTHORS.map(item => item.name), [
    'María Montessori',
    'Walter Riso',
    'Jacobo Grinberg-Zylberbaum',
    'Jacques Lacan',
    'Boris Cyrulnik',
  ]);
});

test('normaliza variantes verificadas sin capturar coincidencias parciales', () => {
  assert.equal(authorPageByName('Riso, Walter')?.id, 'walter-riso');
  assert.equal(authorPageByName('MONTESSORI, MARIA')?.id, 'maria-montessori');
  assert.equal(authorPathForName('Cyrulnik, Boris'), '/libros-boris-cyrulnik-uruguay');
  assert.equal(authorPageByName('Grant Morrison'), null);
  assert.equal(authorPageByName('Sartre a Lacan'), null);
});

test('selecciona sólo libros activos, con stock y autor exacto del piloto', () => {
  const author = authorPageById('walter-riso');
  const items = selectAuthorBooks([
    book('MLU1', 'Walter Riso'),
    book('MLU2', 'Riso, Walter'),
    book('MLU3', 'Grant Morrison'),
    book('MLU4', 'Walter Riso', { status: 'paused', available_quantity: 0 }),
  ], author);
  assert.deepEqual(items.map(item => item.id), ['MLU1', 'MLU2']);
});

test('renderiza contenido visible, canonical, schema y enlaces rastreables', () => {
  const author = authorPageById('jacques-lacan');
  const html = renderAuthorPage(author, [book('MLU9', 'Jacques Lacan')]);
  assert.match(html, /<h1>Libros de Jacques Lacan en Uruguay<\/h1>/);
  assert.match(html, /rel="canonical" href="https:\/\/www\.amadolibros\.com\/libros-jacques-lacan-uruguay"/);
  assert.match(html, /"@type":"CollectionPage"/);
  assert.match(html, /"@type":"ItemList"/);
  assert.match(html, /"publisher":\{"@id":"https:\/\/www\.amadolibros\.com\/#bookstore"\}/);
  assert.match(html, /href="\/libro\/MLU9\/libro-mlu9"/);
  assert.match(html, /Quiénes somos y cómo trabajamos/);
});

test('incluye las cinco páginas de autores en el sitemap estático', () => {
  for (const author of SEO_AUTHORS) {
    assert.ok(STATIC_SITEMAP_PAGES.includes(`https://www.amadolibros.com${author.path}`));
  }
});
