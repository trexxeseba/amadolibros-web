import { test } from 'node:test';
import assert from 'node:assert/strict';
import { veredicto, mediana, markdown } from '../src/cotizar.mjs';

const base = { estado: 'competing', ganador_entrega: 'demanda', objetivo: 1500, queda_objetivo: 300, sobre_costo_objetivo: 30 };
const op = { piso: 1200, margenPiso: 0.18, excluidos: new Set(['pocholib']) };

test('veredicto: ya ganamos, no compite y sin costo', () => {
  assert.equal(veredicto({ estado: 'winning' }, op), 'ya ganamos');
  assert.match(veredicto({ estado: 'listed' }, op), /tiempo de entrega/);
  assert.match(veredicto({ sin_costo: true, estado: 'competing' }, op), /sin costo/);
});
test('veredicto: pierde y se puede competir, o por qué no', () => {
  assert.equal(veredicto(base, op), 'se puede competir');
  assert.match(veredicto({ ...base, ganador_vendedor: 'POCHOLIB' }, op), /no competir: gana POCHOLIB/);
  assert.match(veredicto({ ...base, ganador_entrega: 'inmediato' }, op), /entrega de inmediato/);
  assert.match(veredicto({ ...base, objetivo: 1100 }, op), /piso de 1200/);
  assert.equal(veredicto({ ...base, queda_objetivo: -20 }, op), 'perderíamos plata');
  assert.match(veredicto({ ...base, sobre_costo_objetivo: 9 }, op), /margen flaco/);
});
test('mediana ignora vacíos', () => {
  assert.equal(mediana([3, null, 1, 2, undefined]), 2);
  assert.equal(mediana([]), null);
});
test('markdown arma las tres tablas', () => {
  const o = { fecha: 'x', info: { lista_sbs: '2026-11-20T00:00:00', dias_lista: 1, comision: 0.17, margen_publicado: 0.3, margen_piso: 0.18, entrega_dias: 18 }, grupos: { A: {}, B: {}, C: {} }, filas: [{ grupo: 'A', id: 'MLU1', titulo: 'Libro', precio: 2000, estado: 'winning', veredicto: 'ya ganamos' }] };
  const m = markdown(o);
  assert.match(m, /A\. Al azar/);
  assert.match(m, /C\. Pierden la ficha/);
  assert.match(m, /MLU1/);
});
