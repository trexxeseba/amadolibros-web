import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findSeoCategory,
  SEO_CATEGORY_IDS,
} from '../_shared/seo-categories.js';
import { editorialGuideHtml } from '../libros/[[path]].js';

test('refuerza Tarot en la landing consolidada sin crear otra URL indexable', () => {
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
});

test('la landing existente de religión pasa a ser una entrada clara para Biblias', () => {
  const category = findSeoCategory('religion-espiritualidad');
  assert.ok(category);
  assert.equal(category.title, 'Biblias y libros de religión en Uruguay | Amado Libros');
  assert.equal(category.h1, 'Biblias y libros de religión en Uruguay');
  assert.match(category.description, /Reina-Valera/);
  assert.match(category.description, /Biblias católicas/);
  assert.deepEqual(category.about, ['Biblia', 'Reina-Valera 1960', 'Biblia católica', 'Libros de religión']);

  const html = editorialGuideHtml(category);
  assert.match(html, /Cómo elegir una Biblia por la edición/);
  assert.match(html, /Traducción o versión/);
  assert.match(html, /Letra y tamaño/);
  assert.match(html, /Encuadernación y ayudas/);
  assert.match(html, /pedido institucional/);
  assert.match(html, /sin recomendar una interpretación doctrinal/);
  assert.match(html, /aproximadamente 2 horas en Montevideo, según zona, horario y disponibilidad/);
  assert.doesNotMatch(html, /plan espiritual|cómo leer la Biblia/i);
  assert.doesNotMatch(html, /href="/);
  assert.equal(SEO_CATEGORY_IDS.has('biblias'), false);
});

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
