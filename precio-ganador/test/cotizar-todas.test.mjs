import test from 'node:test';
import assert from 'node:assert/strict';
import { agregar, reglaActual, reglaMargen } from '../src/cotizar-todas.mjs';

const f = (o) => ({ estado: 'competing', precio: 2000, ganador_precio: 1800, objetivo: 1782, queda_objetivo: 100, sobre_costo_objetivo: 20, ganador_entrega: 'a_demanda', ganador_vendedor: 'x', ganador_vendedor_id: '1', veredicto: 'se puede competir', ...o });

test('la regla actual mira la diferencia en pesos y el piso; la de margen mira lo que queda', () => {
  assert.equal(reglaActual(f({})), true);
  assert.equal(reglaActual(f({ precio: 2600 })), false);
  assert.equal(reglaActual(f({ objetivo: 1100, precio: 1200 })), false);
  assert.equal(reglaMargen(f({}), 18), true);
  assert.equal(reglaMargen(f({ sobre_costo_objetivo: 10 }), 18), false);
  assert.equal(reglaMargen(f({ ganador_entrega: 'inmediato' }), 0), false);
  assert.equal(reglaMargen(f({ ganador_vendedor: 'POCHOLIB' }), 0, new Set(['pocholib'])), false);
});

test('agregar arma el ranking de rivales y la sensibilidad por margen', () => {
  const a = agregar([f({}), f({ ganador_vendedor_id: '2', ganador_vendedor: 'y', sobre_costo_objetivo: 5, veredicto: 'margen flaco' }), f({}), f({ estado: 'winning' })]);
  assert.equal(a.pierden, 3);
  assert.equal(a.vendedores[0].id, '1');
  assert.equal(a.vendedores[0].n, 2);
  assert.equal(a.sensibilidad_margen[18].bajarian, 2);
  assert.equal(a.sensibilidad_margen[0].bajarian, 3);
});
