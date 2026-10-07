import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EDITION_FIELDS,
  buildFieldTable,
  existingFact,
  gainedFields,
  summarizeFichas,
  withoutLoteFacts,
} from '../../scripts/seo/enrichment-impact-report.mjs';

// "Investigar 1.000 ISBN" no es "mejorar 1.000 fichas": una edición cubre
// varias publicaciones y una publicación puede no ganar nada. Estas pruebas
// fijan que las tres cifras se cuenten por separado y sobre la ficha efectiva.

test('un autor genérico cuenta como ausencia, no como dato', () => {
  assert.equal(existingFact({ author: 'Desconocido' }, 'author'), null);
  assert.equal(existingFact({ author: 'Ursula K. Le Guin' }, 'author'), 'Ursula K. Le Guin');
});

test('el antes conserva lo que el catálogo ya traía y quita sólo lo del lote', () => {
  const after = { publisher: 'Minotauro', pages: 320, bibliographic: { publication_year: '2019' } };
  const before = withoutLoteFacts(after, { facts: { publisher: 'Minotauro' } });
  assert.equal(existingFact(before, 'publisher'), null);
  assert.equal(existingFact(before, 'pages'), 320);
  assert.equal(existingFact(before, 'publication_year'), '2019');
  assert.deepEqual(gainedFields(before, after), ['publisher']);
});

test('sólo el campo que aporta el lote cuenta como ganancia', () => {
  const after = { bibliographic: { publication_year: '2022', language: 'Español' } };
  // El lote aporta el año; el idioma ya venía del catálogo.
  const before = withoutLoteFacts(after, { facts: { bibliographic: { publication_year: '2022' } } });
  assert.equal(existingFact(before, 'language'), 'Español');
  assert.equal(existingFact(before, 'publication_year'), null);
  assert.deepEqual(gainedFields(before, after), ['publication_year']);
});

test('los campos medidos son los ocho de la edición', () => {
  assert.equal(EDITION_FIELDS.length, 8);
  assert.ok(EDITION_FIELDS.includes('pages'));
  assert.ok(EDITION_FIELDS.includes('publisher'));
});

test('la tabla por campo informa antes, después y cuántas fichas más', () => {
  const tabla = buildFieldTable([
    { antes: ['author'], despues: ['author', 'pages'], ganados: ['pages'] },
    { antes: [], despues: ['pages'], ganados: ['pages'] },
    { antes: ['author', 'pages'], despues: ['author', 'pages'], ganados: [] },
  ]);
  assert.deepEqual(tabla.pages, { antes: 1, despues: 3, mas_fichas: 2 });
  assert.deepEqual(tabla.author, { antes: 2, despues: 2, mas_fichas: 0 });
});

test('el resumen separa sin mejora, >=1 y >=3 datos', () => {
  const resumen = summarizeFichas([
    { ganados: [] },
    { ganados: ['pages'] },
    { ganados: ['pages', 'publisher', 'language'] },
  ]);
  assert.equal(resumen.fichas_evaluadas, 3);
  assert.equal(resumen.sin_mejora, 1);
  assert.equal(resumen.con_1_o_mas, 2);
  assert.equal(resumen.con_3_o_mas, 1);
});
