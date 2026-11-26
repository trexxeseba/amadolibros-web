import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendientes, resumenCalidad } from '../src/calidad.mjs';

const perf = { score: 86, buckets: [
  { key: 'CHARACTERISTICS', variables: [{ key: 'TECHNICAL_SPECIFICATIONS', title: 'Características', status: 'PENDING', rules: [{ key: 'MISSING_ATTRIBUTES', status: 'PENDING', wordings: { title: 'Completá las características' } }] }] },
  { key: 'PICTURES', variables: [{ key: 'VIDEO', title: 'Video', status: 'PENDING', rules: [] }, { key: 'PICTURES_QTY', status: 'COMPLETED', rules: [{ key: 'X', status: 'COMPLETED' }] }] },
] };

test('saca los objetivos pendientes y deja afuera los cumplidos', () => {
  assert.deepEqual(pendientes(perf).map(p => p.regla ?? p.objetivo), ['MISSING_ATTRIBUTES', 'VIDEO']);
});
test('una respuesta vacía no tiene pendientes', () => {
  assert.deepEqual(pendientes(null), []);
});
test('cuenta publicaciones por objetivo, por cantidad y por estado', () => {
  const r = resumenCalidad([{ estado: 'active', pendientes: pendientes(perf) }, { estado: 'paused', pendientes: [] }]);
  assert.equal(r.con_objetivos, 1);
  assert.deepEqual(r.por_objetivo, { TECHNICAL_SPECIFICATIONS: 1, VIDEO: 1 });
  assert.deepEqual(r.por_cantidad, { 2: 1, 0: 1 });
  assert.deepEqual(r.por_estado_con_objetivos, { active: 1 });
});
