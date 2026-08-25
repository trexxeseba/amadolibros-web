import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasClassificationId,
  matchesCategoryPath,
  normalizeCategoryPaths,
  primaryCategoryPath,
} from '../_shared/category-paths.js';

test('normaliza el formato V1 sin romper despliegues intermedios', () => {
  assert.deepEqual(normalizeCategoryPaths(['psicologia', 'psicoanalisis']), [
    ['psicologia', 'psicoanalisis'],
  ]);
});

test('normaliza y deduplica múltiples rutas V2', () => {
  const raw = [
    ['psicologia', 'psicomotricidad'],
    ['educacion', 'pedagogia'],
    ['educacion', 'pedagogia'],
  ];
  assert.deepEqual(normalizeCategoryPaths(raw), raw.slice(0, 2));
  assert.equal(matchesCategoryPath(raw, 'educacion'), true);
  assert.equal(matchesCategoryPath(raw, 'educacion', 'pedagogia'), true);
  assert.equal(matchesCategoryPath(raw, 'educacion', 'formacion-docente'), false);
  assert.equal(hasClassificationId(raw, 'psicomotricidad'), true);
  assert.deepEqual(primaryCategoryPath(raw), ['psicologia', 'psicomotricidad']);
});
