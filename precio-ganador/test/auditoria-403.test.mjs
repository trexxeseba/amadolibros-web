import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.PRECIO_GANADOR_SOLO_IMPORTAR = '1';
process.argv.push('--cuenta', 'libros');
const { ofertas } = await import('../src/auditoria.mjs');
const falla = status => ({ get: async () => { throw Object.assign(new Error('x'), { status }); } });

test('un 403 de la ficha (PolicyAgent) deja las ofertas sin leer y no tumba la auditoría', async () => {
  assert.equal(await ofertas('MLU1', falla(403)), null);
});
test('un 404 de la ficha sigue siendo "sin ofertas"', async () => {
  assert.deepEqual(await ofertas('MLU1', falla(404)), []);
});
test('otros errores siguen cortando la auditoría', async () => {
  await assert.rejects(ofertas('MLU1', falla(500)));
});
test('con respuesta, devuelve las ofertas', async () => {
  assert.deepEqual(await ofertas('MLU1', { get: async () => ({ results: [{ id: 'a' }] }) }), [{ id: 'a' }]);
});
