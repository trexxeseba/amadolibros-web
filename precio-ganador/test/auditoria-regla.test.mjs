import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.PRECIO_GANADOR_SOLO_IMPORTAR = '1';
process.argv.push('--cuenta', 'vintage');
const { reglaEsperada } = await import('../src/auditoria.mjs');

const V = { umbral: 400, inclusivo: true, descuento: 0.01, tope: null, minimo: 1200 };
const f = (o = {}) => ({ precio: 2000, ganador: 1601, moneda: 'UYU', variaciones: false, promo: false, bloqueo: null, piso: 1200, ...o });

test('Vintage: baja al 99 % y la auditoría lo espera así', () => {
  assert.deepEqual(reglaEsperada(f(), V), { esperado: 'bajar', objetivo: 1584 });
  assert.equal(reglaEsperada(f({ ganador: 1600 }), V).esperado, 'bajar');
  assert.equal(reglaEsperada(f({ ganador: 1599 }), V).esperado, 'no_tocar');
});
test('Vintage: ganador inmediato o sin dato, piso y promo se esperan como saltear', () => {
  assert.equal(reglaEsperada(f({ bloqueo: 'ganador_inmediato' }), V).esperado, 'saltear');
  assert.equal(reglaEsperada(f({ precio: 1500, ganador: 1210 }), V).esperado, 'saltear');
  assert.equal(reglaEsperada(f({ promo: true }), V).esperado, 'saltear');
});
test('Libros: < 360, 30 %, precio exacto del ganador', () => {
  const L = { umbral: 360, inclusivo: false, descuento: 0, tope: 0.3, minimo: null };
  assert.deepEqual(reglaEsperada(f({ precio: 1000, ganador: 701, piso: null }), L), { esperado: 'bajar', objetivo: 701 });
  assert.equal(reglaEsperada(f({ precio: 1000, ganador: 640, piso: null }), L).esperado, 'no_tocar');
});
