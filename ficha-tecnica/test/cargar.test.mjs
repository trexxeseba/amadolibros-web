import test from 'node:test';
import assert from 'node:assert/strict';
import { valorPara, proponer, verificar } from '../src/cargar.mjs';
import { decidir, desdeArnoia, desdeCelesa } from '../src/fuentes.mjs';

test('decidir: gana la fuente de mayor prioridad y anota la contradicción', () => {
  const d = decidir('pages', { registro: null, arnoia: null, celesa: { pages: '160' }, openlibrary: { pages: '158' }, googlebooks: { pages: '160' } });
  assert.equal(d.valor, '160'); assert.equal(d.fuente, 'celesa');
  assert.deepEqual(d.coinciden, ['celesa', 'googlebooks']);
  assert.equal(d.contradicciones.length, 1);
  assert.equal(decidir('pages', {}), null);
});

test('distribuidores: sólo lo explícito', () => {
  assert.equal(desdeCelesa({ encuadernacion: 'Cartoné', paginas: 160 }).cover, 'Dura');
  assert.equal(desdeArnoia({ encuadernacion: 'OTRO FORMATO LIBRO' }).cover, null);
  assert.equal(desdeArnoia(null), null);
});

test('valorPara: lista cerrada exige coincidencia, número entero, texto libre', () => {
  const lista = { value_type: 'list', values: [{ id: '1', name: 'Blanda' }, { id: '2', name: 'Dura' }] };
  assert.deepEqual(valorPara(lista, 'dura'), { value_id: '2', value_name: 'Dura' });
  assert.equal(valorPara(lista, 'Espiral'), null);
  assert.deepEqual(valorPara({ value_type: 'number' }, '320'), { value_name: '320' });
  assert.equal(valorPara({ value_type: 'number' }, 'x'), null);
  assert.deepEqual(valorPara({ value_type: 'string' }, 'Planeta'), { value_name: 'Planeta' });
  assert.equal(valorPara(undefined, 'Planeta'), null);
});

test('proponer nunca toca GTIN y verificar compara lo releído', () => {
  const defs = new Map([['PAGES_NUMBER', { value_type: 'number' }], ['GTIN', { value_type: 'string' }], ['AUTHOR', { value_type: 'string' }]]);
  const princ = [{ id: 'PAGES_NUMBER' }, { id: 'GTIN' }, { id: 'AUTHOR' }];
  const p = proponer({ attributes: [] }, defs, princ, { celesa: { pages: '200' } });
  assert.deepEqual(p.cambios.map(c => c.id), ['PAGES_NUMBER']);
  assert.ok(!p.faltan.includes('GTIN'));
  assert.deepEqual(p.sinDato, ['AUTHOR']);
  assert.deepEqual(verificar({ attributes: [{ id: 'PAGES_NUMBER', value_name: '200' }] }, p.cambios), [{ id: 'PAGES_NUMBER', ok: true, quedo: '200' }]);
  assert.equal(verificar({ attributes: [] }, p.cambios)[0].ok, false);
});
