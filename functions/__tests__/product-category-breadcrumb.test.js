import test from 'node:test';
import assert from 'node:assert/strict';

import {
  categoryTrailForPaths,
  enrichActiveCatalogBreadcrumbHtml,
} from '../libro/_middleware.js';
import { findSeoCategory } from '../_shared/seo-categories.js';

function activeProductHtml() {
  return `<!doctype html><html><head>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Inicio","item":"https://www.amadolibros.com/"},{"@type":"ListItem","position":2,"name":"Libro de prueba"}]}</script>
</head><body>
  <nav><a href="/">Inicio</a> › <span>Libro de prueba</span></nav>
  <main><span class="badge in-stock">En stock</span></main>
</body></html>`;
}

function breadcrumbSchema(html) {
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const parsed = JSON.parse(match[1]);
    if (parsed?.['@type'] === 'BreadcrumbList') return parsed;
  }
  return null;
}

test('la clasificación se traduce a la cadena de landings existentes', () => {
  assert.deepEqual(categoryTrailForPaths([['psicologia', 'psicoanalisis']]), [
    { name: 'Psicología', path: '/libros/psicologia' },
    { name: 'Psicoanálisis', path: '/libros/psicologia/psicoanalisis' },
  ]);
  assert.deepEqual(categoryTrailForPaths([['religion-espiritualidad', 'reina-valera']]).map(step => step.path), [
    '/libros/religion-espiritualidad',
    '/libros/biblias',
    '/libros/biblias/reina-valera',
  ]);
});

test('una subcategoría sin landing propia deja sólo la categoría', () => {
  assert.deepEqual(categoryTrailForPaths([['medicina-salud', 'anatomia']]), [
    { name: 'Medicina y salud', path: '/libros/medicina-salud' },
  ]);
});

test('el tarot no elige entre mazos y libros de estudio sólo por la clasificación', () => {
  assert.deepEqual(categoryTrailForPaths([['esoterismo-tarot', 'tarot-oraculos']]).map(step => step.path), [
    '/libros/esoterismo-tarot',
  ]);
});

test('sin landing autorizada no se inventa ninguna URL', () => {
  assert.deepEqual(categoryTrailForPaths([['otros-libros']]), []);
  assert.deepEqual(categoryTrailForPaths(undefined), []);
  // Se usa la primera clasificación que sí tenga landing.
  assert.equal(categoryTrailForPaths([['otros-libros'], ['psicologia']])[0].path, '/libros/psicologia');
});

test('toda URL de la cadena es una landing de la allowlist', () => {
  for (const paths of [[['psicologia', 'psicomotricidad']], [['religion-espiritualidad', 'biblia']], [['infantil-juvenil']]]) {
    for (const step of categoryTrailForPaths(paths)) {
      assert.ok(findSeoCategory(step.path.replace('/libros/', '')), step.path);
    }
  }
});

test('la ficha activa muestra la categoría en HTML y en BreadcrumbList', () => {
  const trail = categoryTrailForPaths([['psicologia', 'psicoanalisis']]);
  const html = enrichActiveCatalogBreadcrumbHtml(activeProductHtml(), trail);

  assert.match(html, /<a href="\/">Inicio<\/a> ›\s*<a href="\/libros\/psicologia">Psicología<\/a> ›\s*<a href="\/libros\/psicologia\/psicoanalisis">Psicoanálisis<\/a> ›\s*<span>Libro de prueba<\/span>/);
  assert.doesNotMatch(html, /Catálogo/);
  const schema = breadcrumbSchema(html);
  assert.deepEqual(schema.itemListElement.map(item => [item.position, item.name, item.item]), [
    [1, 'Inicio', 'https://www.amadolibros.com/'],
    [2, 'Psicología', 'https://www.amadolibros.com/libros/psicologia'],
    [3, 'Psicoanálisis', 'https://www.amadolibros.com/libros/psicologia/psicoanalisis'],
    [4, 'Libro de prueba', undefined],
  ]);
  assert.equal(enrichActiveCatalogBreadcrumbHtml(html, trail), html);
});

test('la ficha ampliada enlaza la landing de la categoría y del autor', async () => {
  const { buildAutomaticProductShowcase } = await import('../_shared/automatic-product-showcase.js');
  const config = buildAutomaticProductShowcase(
    { id: 'MLU1', title: 'Resiliencia', author: 'Boris Cyrulnik', isbn: '9788497847766' },
    { categoryTrail: categoryTrailForPaths([['psicologia', 'psicoanalisis']]) },
  );
  assert.deepEqual(config.links.map(link => link.href), [
    '/libros/psicologia/psicoanalisis',
    '/libros-boris-cyrulnik-uruguay',
  ]);
});

test('la meta description suma editorial, año y páginas verificados', async () => {
  const { buildAutomaticProductShowcase } = await import('../_shared/automatic-product-showcase.js');
  const withFacts = buildAutomaticProductShowcase({
    id: 'MLU1', title: 'El arte de amar', author: 'Erich Fromm', publisher: 'Paidós', pages: 160,
    isbn: '9788449331817', bibliographic: { publication_year: '2019' },
  });
  assert.match(withFacts.metaDescription, /^Comprá El arte de amar de Erich Fromm en Uruguay\. Edición Paidós, 2019, 160 págs\. /);
  assert.ok(withFacts.metaDescription.length <= 170);

  const withoutFacts = buildAutomaticProductShowcase({ id: 'MLU1', title: 'El arte de amar', isbn: '9788449331817' });
  assert.match(withoutFacts.metaDescription, /ISBN 9788449331817\./);
});
