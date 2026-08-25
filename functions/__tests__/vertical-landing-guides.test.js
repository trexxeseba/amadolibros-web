// TAROT-SEARCH-GROWTH-1 — refuerza la landing consolidada de Tarot sin crear
// URLs nuevas y sin tocar el frente de Biblias, que ya se publicó por
// separado en #243 con su propia arquitectura (`kind` + landings propias).
//
// Rescate parcial de #236: se trae SÓLO la parte de Tarot. La parte de
// Biblias de aquel PR queda deliberadamente descartada — #243 ya resolvió
// ese vertical de otra forma y pisarlo sería una regresión.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findSeoCategory,
  SEO_CATEGORY_IDS,
} from '../_shared/seo-categories.js';
import { editorialGuideHtml } from '../libros/[[path]].js';

// ── Tarot: el reposicionamiento ────────────────────────────────────────────

test('conserva el hub general de Tarot y separa la intención comercial de mazos', () => {
  const category = findSeoCategory('esoterismo-tarot');
  assert.ok(category);
  assert.match(category.title, /Tarot y oráculos en Uruguay/);
  assert.match(category.h1, /Tarot, oráculos/);
  assert.deepEqual(category.about, ['Tarot', 'Cartas de oráculo', 'Libros de esoterismo']);

  const html = editorialGuideHtml(category);
  assert.match(html, /Cómo elegir un tarot, un oráculo o un libro de estudio/);
  assert.match(html, /Tipo de producto/);
  assert.match(html, /Sistema/);
  assert.match(html, /Idioma y guía/);
  assert.match(html, /No ofrece lecturas de tarot ni interpreta/);
  assert.doesNotMatch(html, /href="/);
  assert.equal(SEO_CATEGORY_IDS.has('tarot'), false);
  assert.equal(SEO_CATEGORY_IDS.has('oraculos'), false);
  assert.equal(SEO_CATEGORY_IDS.has('esoterismo-tarot/mazos'), true);
});

test('el título y la descripción de Tarot nombran el mazo, no sólo el libro', () => {
  const category = findSeoCategory('esoterismo-tarot');
  // El inventario real del vertical son mayoritariamente mazos; presentarse
  // sólo como "libros de tarot" dejaba fuera la consulta comercial real.
  assert.match(category.title, /Mazos/i);
  assert.match(category.description, /[Mm]azos de tarot/);
  assert.match(category.intro, /mazos/i);
});

// ── Biblias: no se toca ────────────────────────────────────────────────────

test('Biblias conserva intacta la arquitectura publicada en #243', () => {
  const religion = findSeoCategory('religion-espiritualidad');
  assert.ok(religion);
  // #243 sacó las Biblias de Religión con excludedClassificationIds y les dio
  // landings propias. Nada de eso cambia acá.
  assert.deepEqual(religion.excludedClassificationIds, ['biblia', 'reina-valera']);
  assert.equal(religion.title, 'Libros de religión y espiritualidad en Uruguay | Amado Libros');
  // Religión no declara buyerGuide: no debe recibir la guía editorial.
  assert.equal(editorialGuideHtml(religion), '');

  const biblias = findSeoCategory('biblias');
  assert.ok(biblias, 'la landing de Biblias de #243 sigue existiendo');
  assert.equal(biblias.kind, 'bibles');
  assert.equal(editorialGuideHtml(biblias), '', 'Biblias resuelve su contenido por su propia vía, no por buyerGuide');

  const reinaValera = findSeoCategory('biblias/reina-valera');
  assert.ok(reinaValera);
  assert.equal(reinaValera.kind, 'reina-valera');
  assert.equal(editorialGuideHtml(reinaValera), '');
});

// ── La guía es segura y acotada ────────────────────────────────────────────

test('la guía es semántica, visible y escapa contenido antes de insertarlo', () => {
  const html = editorialGuideHtml({
    id: 'prueba',
    buyerGuide: {
      title: 'Título <script>',
      intro: 'Introducción',
      points: [{ title: 'Dato', text: 'Texto <img src=x>' }],
      serviceNote: 'Nota',
    },
  });

  assert.match(html, /^<section class="buyer-guide" aria-labelledby=/);
  assert.match(html, /<h2 id=/);
  assert.match(html, /<article class="buyer-guide-card">/);
  assert.match(html, /<h3>Dato<\/h3>/);
  assert.match(html, /Servicio de Amado Libros:/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<script>|<img src=x>/);
});

test('las categorías sin guía no reciben contenido genérico', () => {
  const category = findSeoCategory('psicologia');
  assert.ok(category);
  assert.equal(editorialGuideHtml(category), '');
});

test('las guías quedan limitadas a verticales con contenido editorial propio', () => {
  const conGuia = [...SEO_CATEGORY_IDS]
    .map(findSeoCategory)
    .filter(category => category?.buyerGuide)
    .map(category => category.id);
  assert.deepEqual(conGuia, [
    'esoterismo-tarot',
    'esoterismo-tarot/mazos',
    'psicologia/psicoanalisis',
    'psicologia/psicomotricidad',
    'psicologia/autismo',
  ]);
});
