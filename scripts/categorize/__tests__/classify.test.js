import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, validateClassification, normalizeText, REVIEW_THRESHOLD } from '../classify.js';
import { CATEGORY_IDS, TYPES } from '../taxonomy.js';

test('un mismo MLU produce un único resultado (determinístico)', () => {
  const record = { mlu: 'MLU1', title: 'Tarot De Los Ángeles', author: '', publisher: '', isbn: '123', status: 'active' };
  const a = classify(record);
  const b = classify(record);
  assert.deepEqual(a, b);
});

test('solo devuelve categorías autorizadas', () => {
  const record = { mlu: 'MLU2', title: 'Historia Del Uruguay', author: 'Ian Kershaw', publisher: '', isbn: '1', status: 'active' };
  const result = classify(record);
  assert.ok(result.categoryId === null || CATEGORY_IDS.has(result.categoryId));
});

test('un objeto nunca recibe categoryId (no es libro)', () => {
  const record = { mlu: 'MLU3', title: 'Candelabro Bronce Antiguo Decorativo', author: '', publisher: 'Genérica', isbn: '', status: 'active' };
  const result = classify(record);
  assert.equal(result.type, TYPES.OBJECT);
  assert.equal(result.categoryId, null);
});

test('un caso dudoso nunca recibe categoría inventada', () => {
  const record = { mlu: 'MLU4', title: 'xkzq blorp fnarp', author: '', publisher: '', isbn: '', status: 'active' };
  const result = classify(record);
  assert.equal(result.type, TYPES.UNCERTAIN);
  assert.equal(result.categoryId, null);
  assert.equal(result.needsReview, true);
});

test('autor reconocido clasifica como libro con alta confianza', () => {
  const record = { mlu: 'MLU5', title: 'Cualquier título', author: 'Judith Butler', publisher: '', isbn: '1', status: 'active' };
  const result = classify(record);
  assert.equal(result.type, TYPES.BOOK);
  assert.equal(result.categoryId, 'filosofia-ciencias-sociales');
  assert.ok(result.confidence >= 0.9);
  assert.equal(result.needsReview, false);
});

test('frase de título distintiva (tarot) clasifica sin necesitar autor', () => {
  const record = { mlu: 'MLU6', title: 'Mazo De Tarot Egipcio', author: '', publisher: '', isbn: '1', status: 'active' };
  const result = classify(record);
  assert.equal(result.type, TYPES.BOOK);
  assert.equal(result.categoryId, 'esoterismo-tarot');
});

test('una palabra corta y genérica sola no decide categoría', () => {
  // "de" no es una keyword de ninguna categoría — nada debe matchear por ella.
  const record = { mlu: 'MLU7', title: 'Un libro de nada en particular', author: '', publisher: '', isbn: '', status: 'active' };
  const result = classify(record);
  assert.equal(result.categoryId, null);
});

test('objeto con señal débil pero con autor e ISBN queda dudoso, no objeto', () => {
  // Simula "libro sobre candelabros" — no debería asumirse objeto solo por la palabra.
  const record = { mlu: 'MLU8', title: 'Historia Del Candelabro En El Arte Antiguo', author: 'Autor Real Conocido', publisher: '', isbn: '9781234567890', status: 'active' };
  const result = classify(record);
  assert.equal(result.type, TYPES.UNCERTAIN);
  assert.equal(result.needsReview, true);
});

test('corrección manual gana siempre, incluso contra una regla fuerte', () => {
  const record = { mlu: 'MLU9', title: 'Cualquier título', author: 'Judith Butler', publisher: '', isbn: '1', status: 'active' };
  const correction = { type: 'book', categoryId: 'historia', subcategoryId: null, tags: [], note: 'corrección de prueba' };
  const result = classify(record, correction);
  assert.equal(result.categoryId, 'historia');
  assert.equal(result.method, 'manual');
  assert.equal(result.confidence, 1);
  assert.equal(result.needsReview, false);
});

test('un CD con palabra de categoría en el título no se clasifica como libro de esa categoría', () => {
  // Caso real encontrado en la revisión manual: "Vox Dei La Biblia Cd Nuevo"
  // es un disco de rock, no una Biblia — "biblia" no debe ganarle a "cd".
  const record = { mlu: 'MLU10', title: 'Vox Dei La Biblia Cd Nuevo Estándar', author: '', publisher: 'AMADO LIBROS', isbn: '1', status: 'active' };
  const result = classify(record);
  assert.equal(result.type, TYPES.OBJECT);
  assert.equal(result.categoryId, null);
});

test('"cd" como substring dentro de otra palabra no dispara falso positivo de objeto', () => {
  const record = { mlu: 'MLU11', title: 'Manual De Acdc Y Otras Bandas', author: 'Autor Real', publisher: '', isbn: '9781234567890', status: 'active' };
  const result = classify(record);
  assert.notEqual(result.type, TYPES.OBJECT);
});

test('validateClassification detecta categoryId inválido', () => {
  const bad = { type: TYPES.BOOK, categoryId: 'categoria-inventada' };
  const errors = validateClassification(bad);
  assert.ok(errors.length > 0);
});

test('validateClassification detecta objeto con categoría (inconsistente)', () => {
  const bad = { type: TYPES.OBJECT, categoryId: 'historia' };
  const errors = validateClassification(bad);
  assert.ok(errors.some(e => e.includes('objeto')));
});

test('normalizeText quita acentos y normaliza espacios', () => {
  assert.equal(normalizeText('Educación Física'), 'educacion fisica');
});

test('REVIEW_THRESHOLD está definido y es coherente con el umbral usado', () => {
  assert.equal(typeof REVIEW_THRESHOLD, 'number');
  assert.ok(REVIEW_THRESHOLD > 0 && REVIEW_THRESHOLD < 1);
});
