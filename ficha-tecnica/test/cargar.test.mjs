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

import { puedeNoAplica } from '../src/cargar.mjs';
test('No aplica sólo en Serie y Volumen, con ficha de Open Library sin serie y título sin tomo', () => {
  const ol = { ficha_openlibrary: { existe: true, con_serie: false } };
  assert.equal(puedeNoAplica('El arte de la guerra', ol), true);
  assert.equal(puedeNoAplica('Jujutsu Kaisen 26', ol), false);
  assert.equal(puedeNoAplica('Harry Potter Tomo II', ol), false);
  assert.equal(puedeNoAplica('Saga Crepúsculo', ol), false);
  assert.equal(puedeNoAplica('El arte de la guerra', { ficha_openlibrary: { existe: true, con_serie: true } }), false);
  assert.equal(puedeNoAplica('El arte de la guerra', {}), false);
  const defs = new Map([['BOOK_SUBTITLE', { value_type: 'string' }]]);
  const p = proponer({ title: 'El arte de la guerra', attributes: [] }, defs, [{ id: 'BOOK_SERIE' }, { id: 'BOOK_VOLUME' }, { id: 'BOOK_SUBTITLE' }, { id: 'BOOK_EDITION' }], ol);
  assert.deepEqual(p.cambios.map(c => c.id + ':' + c.value_id), ['BOOK_SERIE:-1', 'BOOK_VOLUME:-1']);
  assert.deepEqual(p.sinDato, ['BOOK_SUBTITLE', 'BOOK_EDITION']);
  assert.equal(verificar({ attributes: [{ id: 'BOOK_SERIE', value_id: '-1', value_name: null }] }, p.cambios)[0].ok, true);
});
