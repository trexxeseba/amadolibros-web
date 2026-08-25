import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { normalizeCategoryPaths } from '../_shared/category-paths.js';

const dataPath = fileURLToPath(new URL('../../astro-front/public/data/active-categories.json', import.meta.url));
const data = JSON.parse(readFileSync(dataPath, 'utf8'));

test('el artefacto usa rutas múltiples V2 y conserva las versiones de reglas', () => {
  assert.equal(data.schema_version, 2);
  assert.equal(data.taxonomy_version, 4);
  assert.equal(data.rules_version, 14);
  assert.ok(Object.values(data.items).some(paths => normalizeCategoryPaths(paths).length > 1));
});

test('los cuatro productos señalados quedan en su ubicación curada', () => {
  assert.deepEqual(normalizeCategoryPaths(data.items.MLU669381182), [
    ['filosofia-ciencias-sociales', 'ciencia-politica'],
  ]);
  assert.deepEqual(normalizeCategoryPaths(data.items.MLU1045409526), [
    ['psicologia', 'psicoterapia'],
  ]);
  assert.deepEqual(normalizeCategoryPaths(data.items.MLU725213570), [
    ['medicina-salud', 'dermatologia'],
  ]);
  assert.deepEqual(normalizeCategoryPaths(data.items.MLU637272813), [
    ['ciencia-tecnologia', 'informatica-software'],
  ]);
});

test('la taxonomía pública incluye Autismo, Psicomotricidad, Maternidad y Crianza', () => {
  const psychology = data.categories.find(category => category.id === 'psicologia');
  const family = data.categories.find(category => category.id === 'familia-crianza');
  const psychologyIds = new Set((psychology?.subcategories || []).map(entry => entry.id));
  const familyIds = new Set((family?.subcategories || []).map(entry => entry.id));

  assert.ok(psychologyIds.has('autismo-neurodesarrollo'));
  assert.ok(psychologyIds.has('psicomotricidad'));
  assert.ok(psychologyIds.has('psicoanalisis'));
  assert.ok(familyIds.has('maternidad'));
  assert.ok(familyIds.has('crianza'));
});
