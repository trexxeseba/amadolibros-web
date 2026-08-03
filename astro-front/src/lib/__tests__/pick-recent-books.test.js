import test from 'node:test';
import assert from 'node:assert/strict';
import { pickRecentBooks, isAntiqueObject } from '../pick-recent-books.js';

function book(overrides = {}) {
  return {
    id: 'MLU1', title: 'Libro Genérico', author: 'Autor Genérico',
    price: 1000, status: 'active', available_quantity: 1,
    start_time: '2026-01-01T00:00:00.000Z', condition: 'new',
    ...overrides,
  };
}

test('mezcla new/used/sin condición/pausado/sin stock: solo sobrevive activo+stock+new', () => {
  const items = [
    book({ id: 'MLU1', condition: 'new' }),
    book({ id: 'MLU2', condition: 'used' }),
    book({ id: 'MLU3', condition: undefined }),
    book({ id: 'MLU4', condition: null }),
    book({ id: 'MLU5', condition: 'new', status: 'paused' }),
    book({ id: 'MLU6', condition: 'new', available_quantity: 0 }),
    book({ id: 'MLU7', condition: 'not_specified' }),
    book({ id: 'MLU8', condition: 'NEW' }), // mayúsculas no cuentan como 'new' — sin normalización inventada
  ];
  const result = pickRecentBooks(items, 8);
  assert.deepEqual(result.map(b => b.id), ['MLU1']);
});

test('usados nunca aparecen aunque sean más recientes que los nuevos', () => {
  const items = [
    book({ id: 'MLU-USED-RECENT', condition: 'used', start_time: '2026-06-01T00:00:00.000Z' }),
    book({ id: 'MLU-NEW-OLDER', condition: 'new', start_time: '2026-01-01T00:00:00.000Z' }),
  ];
  const result = pickRecentBooks(items, 8);
  assert.deepEqual(result.map(b => b.id), ['MLU-NEW-OLDER']);
});

test('exclusión ocurre antes del corte: con pool grande, el límite no descarta nuevos por culpa de usados intercalados', () => {
  // 50 ítems: alternando new/used, todos con start_time distinto (los más
  // recientes primero). Si el filtro de condición se aplicara DESPUÉS de
  // cortar a un límite pequeño, se perderían nuevos legítimos.
  const items = [];
  for (let i = 0; i < 50; i++) {
    items.push(book({
      id: `MLU${i}`,
      condition: i % 2 === 0 ? 'used' : 'new',
      start_time: new Date(2026, 0, 50 - i).toISOString(),
      author: `Autor ${i}`, // evita colisiones de dedup
    }));
  }
  const result = pickRecentBooks(items, 20);
  assert.equal(result.length, 20, 'debería completar el límite pedido solo con nuevos disponibles');
  assert.ok(result.every(b => b.condition === 'new'));
});

test('menos de 8 nuevos disponibles: devuelve los que hay, sin romper', () => {
  const items = [
    book({ id: 'MLU1', condition: 'new' }),
    book({ id: 'MLU2', condition: 'new', author: 'Otro Autor' }),
    book({ id: 'MLU3', condition: 'used' }),
    book({ id: 'MLU4', condition: 'used' }),
  ];
  const result = pickRecentBooks(items, 8);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(b => b.id).sort(), ['MLU1', 'MLU2']);
});

test('cero nuevos disponibles: devuelve un array vacío, no rompe', () => {
  const items = [
    book({ id: 'MLU1', condition: 'used' }),
    book({ id: 'MLU2', condition: 'used' }),
  ];
  const result = pickRecentBooks(items, 8);
  assert.deepEqual(result, []);
});

test('array vacío o ausente no rompe', () => {
  assert.deepEqual(pickRecentBooks([], 8), []);
  assert.deepEqual(pickRecentBooks(undefined, 8), []);
});

test('mantiene el orden por start_time descendente entre los nuevos', () => {
  const items = [
    book({ id: 'MLU-OLD', condition: 'new', start_time: '2026-01-01T00:00:00.000Z', author: 'A' }),
    book({ id: 'MLU-NEW', condition: 'new', start_time: '2026-06-01T00:00:00.000Z', author: 'B' }),
    book({ id: 'MLU-MID', condition: 'new', start_time: '2026-03-01T00:00:00.000Z', author: 'C' }),
  ];
  const result = pickRecentBooks(items, 8);
  assert.deepEqual(result.map(b => b.id), ['MLU-NEW', 'MLU-MID', 'MLU-OLD']);
});

test('compatibilidad con el deduplicado por autor+precio: un usado no "libera" el cupo de su duplicado nuevo', () => {
  const items = [
    book({ id: 'MLU1', condition: 'new', author: 'Mismo Autor', price: 500, start_time: '2026-02-01T00:00:00.000Z' }),
    book({ id: 'MLU2', condition: 'new', author: 'Mismo Autor', price: 500, start_time: '2026-01-01T00:00:00.000Z' }),
    book({ id: 'MLU3', condition: 'used', author: 'Mismo Autor', price: 500, start_time: '2026-03-01T00:00:00.000Z' }),
  ];
  const result = pickRecentBooks(items, 8);
  // MLU3 (usado) queda afuera por condición antes de llegar al dedup;
  // entre MLU1/MLU2 (mismo autor+precio) el dedup se queda con el primero
  // en orden de recencia.
  assert.deepEqual(result.map(b => b.id), ['MLU1']);
});

test('compatibilidad con isAntiqueObject: un objeto antiguo "new" (mal etiquetado) sigue excluido por señal de título', () => {
  const items = [
    book({ id: 'MLU1', condition: 'new', author: '', title: 'Candelabro Bronce Antiguo Decorativo' }),
    book({ id: 'MLU2', condition: 'new', author: 'Autor Real', title: 'Un libro de verdad' }),
  ];
  const result = pickRecentBooks(items, 8);
  assert.deepEqual(result.map(b => b.id), ['MLU2']);
  assert.equal(isAntiqueObject(items[0]), true);
});

test('corta exactamente a max (8 por defecto en el uso real)', () => {
  const items = Array.from({ length: 15 }, (_, i) => book({
    id: `MLU${i}`, author: `Autor ${i}`, condition: 'new',
    start_time: new Date(2026, 0, 15 - i).toISOString(),
  }));
  const result = pickRecentBooks(items, 8);
  assert.equal(result.length, 8);
});
