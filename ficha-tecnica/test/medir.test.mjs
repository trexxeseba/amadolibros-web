import test from 'node:test';
import assert from 'node:assert/strict';
import { cargado, isbnDe, principales, faltantes, NUNCA } from '../src/comun.mjs';
import { clasificar, resumir } from '../src/medir.mjs';

test('cargado: valor, no aplica y vacío', () => {
  assert.equal(cargado({ id: 'AUTHOR', value_name: 'Borges' }), true);
  assert.equal(cargado({ id: 'AUTHOR', value_id: '-1', value_name: null }), true);
  assert.equal(cargado({ id: 'AUTHOR', value_name: null, value_id: null, values: [] }), false);
  assert.equal(cargado(undefined), false);
});

test('isbnDe toma el ISBN-13 del GTIN', () => {
  assert.equal(isbnDe({ attributes: [{ id: 'GTIN', value_name: '978-84-376-0494-7' }] }), '9788437604947');
  assert.equal(isbnDe({ attributes: [{ id: 'AUTHOR', value_name: 'x' }] }), null);
});

test('principales usa el grupo MAIN y nunca incluye ISBN/GTIN ni ocultos', () => {
  const attrs = [{ id: 'AUTHOR', name: 'Autor', tags: {} }, { id: 'GTIN', tags: { required: true } }, { id: 'PAGES_NUMBER', tags: {} }, { id: 'X', tags: { hidden: true } }];
  const specs = { groups: [{ id: 'MAIN', components: [{ attributes: [{ id: 'AUTHOR' }, { id: 'GTIN' }, { id: 'X' }] }] }] };
  assert.deepEqual(principales(attrs, specs).map(a => a.id), ['AUTHOR']);
  assert.ok(NUNCA.has('GTIN'));
  assert.deepEqual(faltantes({ attributes: [] }, principales(attrs, specs)), ['AUTHOR']);
});

test('clasificar y resumir separan ficha, video y stock', () => {
  const filas = [
    { pendientes: [{ objetivo: 'UP_TECHNICAL_SPECIFICATIONS_MAIN', regla: 'UP_TS_MAIN_QUANTITY' }], faltan: ['AUTHOR'], isbn: '9788437604947' },
    { pendientes: [{ objetivo: 'UP_SHORTS', regla: 'UP_HAS_SHORTS' }, { objetivo: 'UP_TECHNICAL_SPECIFICATIONS_MAIN' }], faltan: [], isbn: null },
    { pendientes: [], faltan: [] },
    { pendientes: [], performance_http: 400 },
  ];
  assert.equal(clasificar(filas[0]).solo_ficha, true);
  const r = resumir(filas);
  assert.equal(r.con_objetivos, 2);
  assert.equal(r.sin_dato_de_calidad, 1);
  assert.equal(r.ficha.solo_ficha, 1);
  assert.equal(r.ficha.por_atributo_faltante.AUTHOR, 1);
});
