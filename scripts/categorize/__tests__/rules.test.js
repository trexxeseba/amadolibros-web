import test from 'node:test';
import assert from 'node:assert/strict';
import { MINED_AUTHOR_SIGNALS, KEYWORD_SIGNALS, OBJECT_SIGNALS } from '../rules.js';
import { CATEGORY_IDS } from '../taxonomy.js';

test('todas las categorías usadas en rules.js existen en la taxonomía', () => {
  for (const categoryId of Object.keys(MINED_AUTHOR_SIGNALS)) {
    assert.ok(CATEGORY_IDS.has(categoryId), `categoría desconocida en MINED_AUTHOR_SIGNALS: ${categoryId}`);
  }
  for (const categoryId of Object.keys(KEYWORD_SIGNALS)) {
    assert.ok(CATEGORY_IDS.has(categoryId), `categoría desconocida en KEYWORD_SIGNALS: ${categoryId}`);
  }
});

test('ninguna keyword de objeto es una sola letra o vacía (evita falsos positivos triviales)', () => {
  for (const phrase of OBJECT_SIGNALS) {
    assert.ok(phrase.trim().length >= 3, `señal de objeto sospechosamente corta: "${phrase}"`);
  }
});

test('no hay autores duplicados textualmente dentro de la misma categoría', () => {
  for (const categoryId of Object.keys(MINED_AUTHOR_SIGNALS)) {
    const authors = MINED_AUTHOR_SIGNALS[categoryId].authors;
    assert.equal(new Set(authors).size, authors.length, `autores duplicados en ${categoryId}`);
  }
});
