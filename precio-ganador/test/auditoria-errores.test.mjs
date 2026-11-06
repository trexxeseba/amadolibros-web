import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.PRECIO_GANADOR_SOLO_IMPORTAR = '1';
process.argv.push('--cuenta', 'libros');
const { motivosDeFalla, reglaEsperada } = await import('../src/auditoria.mjs');

test('un solo error de aplicación en 40 intentos no tumba el job', () => {
  assert.deepEqual(motivosDeFalla({ porTipo: { muestra: 0, estado: 0, regla: 0 }, muestraN: 10, erroresAplicar: 1, intentos: 40 }), []);
});
test('un error de aplicación no cuenta como discrepancia de regla (la regla esperaba bajar)', () => {
  const fila = { precio: 898, ganador: 875, moneda: 'UYU', variaciones: false, promo: false, bloqueo: null, piso: null };
  assert.equal(reglaEsperada(fila, { umbral: 360, inclusivo: false, descuento: 0, tope: 0.3, minimo: null }).esperado, 'bajar');
});
