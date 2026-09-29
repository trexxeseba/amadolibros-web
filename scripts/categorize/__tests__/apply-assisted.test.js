import test from 'node:test';
import assert from 'node:assert/strict';

import {
  acceptedEntries,
  mergeAssisted,
  patchActiveCategories,
} from '../apply-assisted-classifications.mjs';

test('sólo acepta confianza alta con una categoría real y válida', () => {
  const { accepted, rejected } = acceptedEntries([
    { mlu: 'MLU1', cat: 'psicologia', sub: 'psicoanalisis', conf: 'alta' },
    { mlu: 'MLU2', cat: 'psicologia', sub: null, conf: 'media' },
    { mlu: 'MLU3', cat: 'otros-libros', sub: null, conf: 'alta' },
    { mlu: 'MLU4', cat: 'psicologia', sub: 'novela', conf: 'alta' },
    { mlu: 'MLU5', cat: 'inventada', sub: null, conf: 'alta' },
  ], { date: '2026-09-24', source: 'test' });

  assert.deepEqual(accepted.map(entry => [entry.mlu, entry.primaryCategoryId, entry.subcategoryId]), [
    ['MLU1', 'psicologia', 'psicoanalisis'],
  ]);
  assert.match(accepted[0].note, /asistida 2026-09-24/);
  assert.deepEqual(rejected, { baja_o_media: 1, sin_categoria_real: 1, invalida: 2 });
});

test('el mapa de la web sólo reemplaza otros-libros o la falta de clasificación', () => {
  const payload = {
    schema_version: 2,
    items: {
      MLU1: [['otros-libros']],
      MLU2: [['medicina-salud']],
    },
  };
  const entries = [
    { mlu: 'MLU1', primaryCategoryId: 'psicologia', subcategoryId: 'psicoanalisis' },
    { mlu: 'MLU2', primaryCategoryId: 'psicologia', subcategoryId: null },
    { mlu: 'MLU3', primaryCategoryId: 'historia', subcategoryId: null },
  ];
  const { payload: result, patched } = patchActiveCategories(payload, entries);

  assert.equal(patched, 2);
  assert.deepEqual(result.items.MLU1, [['psicologia', 'psicoanalisis']]);
  assert.deepEqual(result.items.MLU2, [['medicina-salud']]);
  assert.deepEqual(result.items.MLU3, [['historia']]);
  const psicologia = result.categories.find(category => category.id === 'psicologia');
  assert.equal(psicologia.count, 1);
  assert.deepEqual(psicologia.subcategories.map(sub => [sub.id, sub.count]), [['psicoanalisis', 1]]);
  assert.equal(result.categories.some(category => category.id === 'otros-libros'), false);
});

test('una corrida nueva reemplaza la entrada anterior del mismo MLU', () => {
  const merged = mergeAssisted(
    [{ mlu: 'MLU2', primaryCategoryId: 'historia' }, { mlu: 'MLU1', primaryCategoryId: 'derecho' }],
    [{ mlu: 'MLU1', primaryCategoryId: 'psicologia' }],
  );
  assert.deepEqual(merged.map(entry => [entry.mlu, entry.primaryCategoryId]), [['MLU1', 'psicologia'], ['MLU2', 'historia']]);
});
