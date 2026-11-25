import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.PRECIO_GANADOR_SOLO_IMPORTAR = '1';
process.argv.push('--cuenta', 'libros');
const { motivosDeFalla } = await import('../src/auditoria.mjs');

test('1 discrepancia de la muestra no tumba el job; 3 sí', () => {
  assert.deepEqual(motivosDeFalla({ porTipo: { muestra: 1, estado: 0, regla: 0 }, muestraN: 10, erroresAplicar: 0, intentos: 100 }), []);
  assert.equal(motivosDeFalla({ porTipo: { muestra: 3, estado: 0, regla: 0 }, muestraN: 10, erroresAplicar: 0, intentos: 100 }).length, 1);
});
test('una discrepancia de regla siempre tumba el job', () => {
  assert.equal(motivosDeFalla({ porTipo: { muestra: 0, estado: 0, regla: 1 }, muestraN: 10, erroresAplicar: 0, intentos: 0 }).length, 1);
});
test('errores de aplicación: pocos no tumban, muchos sí', () => {
  assert.deepEqual(motivosDeFalla({ porTipo: { muestra: 0, estado: 0, regla: 0 }, muestraN: 10, erroresAplicar: 4, intentos: 1500 }), []);
  assert.equal(motivosDeFalla({ porTipo: { muestra: 0, estado: 0, regla: 0 }, muestraN: 10, erroresAplicar: 40, intentos: 1500 }).length, 1);
  assert.equal(motivosDeFalla({ porTipo: { muestra: 0, estado: 0, regla: 0 }, muestraN: 10, erroresAplicar: 4, intentos: 5 }).length, 1);
});
