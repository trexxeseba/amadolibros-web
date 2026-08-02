import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MINED_AUTHOR_SIGNALS,
  KEYWORD_SIGNALS,
  KEYWORD_SIGNALS_WEAK,
  OBJECT_SIGNALS,
  OBJECT_TYPE_SIGNALS,
} from '../rules.js';
import { CATEGORY_IDS, isValidSubcategoryId } from '../taxonomy.js';

test('todas las categorías usadas en rules.js existen en la taxonomía', () => {
  for (const categoryId of Object.keys(MINED_AUTHOR_SIGNALS)) {
    assert.ok(CATEGORY_IDS.has(categoryId), `categoría desconocida en MINED_AUTHOR_SIGNALS: ${categoryId}`);
  }
  for (const categoryId of Object.keys(KEYWORD_SIGNALS)) {
    assert.ok(CATEGORY_IDS.has(categoryId), `categoría desconocida en KEYWORD_SIGNALS: ${categoryId}`);
  }
  for (const categoryId of Object.keys(KEYWORD_SIGNALS_WEAK)) {
    assert.ok(CATEGORY_IDS.has(categoryId), `categoría desconocida en KEYWORD_SIGNALS_WEAK: ${categoryId}`);
  }
});

test('toda subcategoryId declarada en KEYWORD_SIGNALS pertenece a su categoría', () => {
  for (const categoryId of Object.keys(KEYWORD_SIGNALS)) {
    for (const { subcategoryId, phrase } of KEYWORD_SIGNALS[categoryId]) {
      assert.ok(
        isValidSubcategoryId(categoryId, subcategoryId),
        `"${phrase}" -> ${categoryId}/${subcategoryId} inválida`
      );
    }
  }
});

test('toda subcategoryId declarada en OBJECT_TYPE_SIGNALS pertenece a otros-productos', () => {
  for (const { phrase, subcategoryId } of OBJECT_TYPE_SIGNALS) {
    assert.ok(
      isValidSubcategoryId('otros-productos', subcategoryId),
      `"${phrase}" -> otros-productos/${subcategoryId} inválida`
    );
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

test('OBJECT_TYPE_SIGNALS declara un type válido para cada señal', () => {
  const validTypes = new Set(['book', 'magazine', 'music', 'object', 'other']);
  for (const { type, phrase } of OBJECT_TYPE_SIGNALS) {
    assert.ok(validTypes.has(type), `type inválido para "${phrase}": ${type}`);
  }
});
