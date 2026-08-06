import test from 'node:test';
import assert from 'node:assert/strict';
import { selectActiveItems, ACTIVE_COUNT } from '../generate-home-json.js';

function item(overrides = {}) {
  return {
    id: 'MLU1', title: 'Libro', status: 'active', available_quantity: 1,
    start_time: '2026-01-01T00:00:00.000Z', condition: 'new',
    ...overrides,
  };
}

test('ACTIVE_COUNT sigue siendo 40 (no se cambió sin querer)', () => {
  assert.equal(ACTIVE_COUNT, 40);
});

test('mezcla new/used/sin condición/pausado/sin stock: solo activo+stock+new sobrevive', () => {
  const items = [
    item({ id: 'MLU1', condition: 'new' }),
    item({ id: 'MLU2', condition: 'used' }),
    item({ id: 'MLU3', condition: undefined }),
    item({ id: 'MLU4', condition: null }),
    item({ id: 'MLU5', condition: 'new', status: 'paused' }),
    item({ id: 'MLU6', condition: 'new', available_quantity: 0 }),
  ];
  const result = selectActiveItems(items, 40);
  assert.deepEqual(result.map(b => b.id), ['MLU1']);
});

test('el filtro de condición corre antes del corte a ACTIVE_COUNT, no después', () => {
  // 50 nuevos + 50 usados, todos "activos con stock", start_time decreciente
  // por índice (los primeros del array son los más recientes). Si el corte
  // a `count` ocurriera ANTES del filtro de condición, con count=40 se
  // perderían nuevos legítimos que quedaron "detrás" de usados recientes.
  const items = [];
  for (let i = 0; i < 100; i++) {
    items.push(item({
      id: `MLU${i}`,
      condition: i % 2 === 0 ? 'used' : 'new',
      start_time: new Date(2026, 0, 100 - i).toISOString(),
    }));
  }
  const result = selectActiveItems(items, 40);
  assert.equal(result.length, 40, 'debe completar el cupo de 40 solo con nuevos, ignorando cuántos usados haya intercalados');
  assert.ok(result.every(b => b.condition === 'new'));
});

test('menos de 40 nuevos disponibles: devuelve los que hay', () => {
  const items = [
    item({ id: 'MLU1', condition: 'new' }),
    item({ id: 'MLU2', condition: 'new' }),
    item({ id: 'MLU3', condition: 'used' }),
  ];
  const result = selectActiveItems(items, 40);
  assert.equal(result.length, 2);
});

test('cero nuevos disponibles: devuelve un array vacío, no lanza', () => {
  const items = [
    item({ id: 'MLU1', condition: 'used' }),
    item({ id: 'MLU2', condition: null }),
  ];
  const result = selectActiveItems(items, 40);
  assert.deepEqual(result, []);
});

test('orden por start_time descendente entre los nuevos seleccionados', () => {
  const items = [
    item({ id: 'MLU-OLD', condition: 'new', start_time: '2026-01-01T00:00:00.000Z' }),
    item({ id: 'MLU-NEW', condition: 'new', start_time: '2026-06-01T00:00:00.000Z' }),
    item({ id: 'MLU-MID', condition: 'new', start_time: '2026-03-01T00:00:00.000Z' }),
  ];
  const result = selectActiveItems(items, 40);
  assert.deepEqual(result.map(b => b.id), ['MLU-NEW', 'MLU-MID', 'MLU-OLD']);
});

test('respeta un count explícito distinto al default (40)', () => {
  const items = Array.from({ length: 10 }, (_, i) => item({
    id: `MLU${i}`, condition: 'new', start_time: new Date(2026, 0, 10 - i).toISOString(),
  }));
  assert.equal(selectActiveItems(items, 5).length, 5);
});
