import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limites, elegirRegla, esAutomatizable, compararRegla, minimoOk, sinIds } from '../src/automatizacion.mjs';

test('límites: mínimo 60 % y máximo 145 % del precio de lista, en pesos enteros', () => {
  // Seba 26/11: mínimo 60 % nunca debajo de $500; máximo = precio base.
  assert.deepEqual(limites(2000), { min_price: 1200, max_price: 2000 });
  assert.deepEqual(limites(700), { min_price: 500, max_price: 700 });
  assert.equal(limites(500), null);
  assert.equal(limites(0), null); assert.equal(limites('x'), null);
});

test('regla: prefiere INT_EXT, después INT; si no hay ninguna conocida, nada', () => {
  assert.equal(elegirRegla([{ rule_id: 'INT' }, { rule_id: 'INT_EXT' }]), 'INT_EXT');
  assert.equal(elegirRegla([{ rule_id: 'INT' }]), 'INT');
  assert.equal(elegirRegla(['INT']), 'INT');
  assert.equal(elegirRegla([]), null); assert.equal(elegirRegla([{ rule_id: 'OTRA' }]), null);
});

test('automatizable: activa, en pesos, con stock, con regla y sin automatización puesta', () => {
  const f = { estado: 'active', moneda: 'UYU', variaciones: false, stock: 2, regla_elegida: 'INT', automatizada: false };
  assert.equal(esAutomatizable(f), true);
  assert.equal(esAutomatizable({ ...f, automatizada: true }), false);
  assert.equal(esAutomatizable({ ...f, regla_elegida: null }), false);
  assert.equal(esAutomatizable({ ...f, stock: 0 }), false);
  assert.equal(esAutomatizable({ ...f, estado: 'paused' }), false);
});

test('comparar (26/11): ML compite dentro de mínimo y máximo; Precio Ganador sólo si la diferencia es menor a $400', () => {
  assert.deepEqual(compararRegla({ precio: 2000, lista: 2000, estado: 'competing', ganador: 1800 }), { compite: true, ml: 1800, pg: 1782, diferencia: 18 });
  const lejos = compararRegla({ precio: 2000, lista: 2000, estado: 'competing', ganador: 1000 });
  assert.equal(lejos.ml, 1200); assert.equal(lejos.pg, 2000);
  assert.deepEqual(compararRegla({ precio: 1500, lista: 2000, estado: 'winning', ganador: null }), { compite: false, ml: 2000, pg: 2000, diferencia: 0 });
  assert.equal(compararRegla({ precio: 600, lista: 600, estado: 'competing', ganador: 450 }).pg, 500);
});

test('minimoOk: el mínimo de ML coincide con la regla de Seba (mayor entre $500 y 60 % del precio de lista)', () => {
  assert.equal(minimoOk({ precio_lista: 2290, automatizacion_antes: { min_price: 1374 } }), true);
  assert.equal(minimoOk({ precio_lista: 600, automatizacion_antes: { min_price: 500 } }), true);
  assert.equal(minimoOk({ precio_lista: 2600, automatizacion_antes: { min_price: 2350 } }), false);
  assert.equal(minimoOk({ precio_lista: 2600, automatizacion_antes: null }), false);
});

test('sinIds: el error que va al log público no lleva números de publicación', () => {
  assert.deepEqual(sinIds({ http: 412, detalle: { message: 'Cannot perform for item with id [MLU478651427]' } }), { http: 412, detalle: { message: 'Cannot perform for item with id [MLU…]' } });
  assert.equal(sinIds(null), null);
});
