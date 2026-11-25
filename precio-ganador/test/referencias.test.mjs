import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filaReferencia, resumenReferencias } from '../src/referencias.mjs';

test('fila de referencia: precio propio, sugerido y brecha', () => {
  const f = filaReferencia({ id: 'MLU1', title: 'Libro', price: 2000, available_quantity: 3, catalog_listing: false }, { status: 'with_benchmark_high', suggested_price: { amount: 1700 }, lowest_price: { amount: 1500 } });
  assert.equal(f.sugerido, 1700); assert.equal(f.minimo, 1500); assert.equal(f.brecha_pct, 15); assert.equal(f.estado, 'with_benchmark_high');
  assert.equal(filaReferencia({ id: 'MLU2', price: 1000 }, { suggested_price: 900 }).brecha_pct, 10);
  assert.equal(filaReferencia({ id: 'MLU3', price: 1000 }, {}).sugerido, null);
});

test('resumen: cuenta por estado y por tamaño de brecha', () => {
  const r = resumenReferencias([
    { estado: 'a', precio: 1000, sugerido: 950, brecha_pct: 5 }, { estado: 'a', precio: 1000, sugerido: 800, brecha_pct: 20 },
    { estado: 'b', precio: 1000, sugerido: 600, brecha_pct: 40 }, { estado: 'b', precio: 1000, sugerido: 1200, brecha_pct: -20 }, { estado: '', precio: 1000, sugerido: null, brecha_pct: null },
  ]);
  assert.deepEqual(r, { con_interno: 0, mas_caras_que_el_interno: 0, leidas: 5, por_estado: { a: 2, b: 2, sin_estado: 1 }, con_sugerido: 4, mas_caras_que_el_sugerido: 3, brecha_mediana_pct: 20, brecha_hasta_10: 1, brecha_10_a_25: 1, brecha_mas_de_25: 1 });
});

test('precio interno y externo por separado: la brecha interna ignora las otras tiendas', () => {
  const f = filaReferencia({ id: 'MLU9', price: 2000 }, { suggested_price: 1500, internal_price: 1800, external_price: 1500 });
  assert.equal(f.interno, 1800); assert.equal(f.externo, 1500); assert.equal(f.brecha_interna_pct, 10);
  assert.equal(filaReferencia({ id: 'MLU9', price: 2000 }, { suggested_price: 1500 }).brecha_interna_pct, null);
});
