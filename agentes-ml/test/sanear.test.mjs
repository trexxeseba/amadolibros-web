import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forma, texto, mascara, elegir } from '../src/sanear.mjs';

test('forma tapa números y textos, reconoce fechas y cuenta listas', () => {
  const f = forma({ total_amount: 1234.5, buyer: { nickname: 'X' }, date: '2026-11-10T05:00:00.000-03:00', ok: true, nada: null, lista: [{ a: 1 }, { a: 2 }], vacia: [] });
  assert.deepEqual(f, { total_amount: 'num', buyer: { nickname: 'str' }, date: 'fecha', ok: 'bool', nada: 'null', lista: [{ a: 'num' }, 'n=2'], vacia: [] });
  assert.equal(JSON.stringify(f).includes('1234'), false);
});

test('texto deja solo caracteres seguros y recorta', () => {
  assert.equal(texto('No permissions <script>found</script> for user_id'), 'No permissions scriptfound/script for user_id');
  assert.equal(texto('x'.repeat(500)).length, 200);
});

test('mascara deja ver que hay un identificador sin exponerlo', () => {
  assert.equal(mascara('1234567890'), '123…90');
  assert.equal(mascara('12'), '****');
});

test('elegir se queda solo con las claves pedidas', () => {
  assert.deepEqual(elegir({ a: 1, b: 2, c: undefined }, ['a', 'c', 'z']), { a: 1 });
  assert.deepEqual(elegir(null, ['a']), {});
});
