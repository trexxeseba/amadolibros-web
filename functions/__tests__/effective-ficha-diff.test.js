import test from 'node:test';
import assert from 'node:assert/strict';

import { diffFichas, resumen } from '../../scripts/seo/effective-ficha-diff.mjs';
import { fieldsPresent } from '../../scripts/seo/effective-ficha-fields.mjs';

const noGenerico = author => /^(desconocido|varios)$/i.test(String(author || '').trim());

// La reconciliación compara la ficha efectiva de main contra la del PR sobre
// el MISMO snapshot. Sin reconstrucciones: se resta un lado del otro.

test('los campos presentes se leen de la ficha efectiva, no del catálogo crudo', () => {
  assert.deepEqual(
    fieldsPresent({ author: 'Autora Real', publisher: 'Ed', pages: 320, bibliographic: { language: 'Español' } }, noGenerico),
    ['author', 'publisher', 'pages', 'language'],
  );
  assert.deepEqual(fieldsPresent({ author: 'Desconocido', pages: 0, bibliographic: {} }, noGenerico), []);
  assert.deepEqual(fieldsPresent({ bibliographic: { subjects: ['Narrativa'] } }, noGenerico), ['topics']);
});

test('sólo cuenta como mejora lo que main no tenía', () => {
  const filas = diffFichas(
    { fichas: { MLU1: { isbn: 'A', campos: ['author'] }, MLU2: { isbn: 'B', campos: [] } } },
    { fichas: { MLU1: { isbn: 'A', campos: ['author', 'pages'] }, MLU2: { isbn: 'B', campos: [] } } },
  );
  assert.deepEqual(filas.find(f => f.id === 'MLU1').ganados, ['pages']);
  assert.deepEqual(filas.find(f => f.id === 'MLU2').ganados, []);
});

test('una ficha que no existía en main se informa como diferencia de catálogo', () => {
  const filas = diffFichas({ fichas: {} }, { fichas: { MLU9: { isbn: 'C', campos: ['pages'] } } });
  assert.equal(filas[0].soloEnDespues, true);
  assert.deepEqual(filas[0].ganados, []);
  assert.equal(resumen(filas).fichas_solo_en_despues, 1);
  assert.equal(resumen(filas).fichas_beneficiadas, 0);
});

test('un campo perdido se detecta en vez de pasar inadvertido', () => {
  const filas = diffFichas(
    { fichas: { MLU1: { isbn: 'A', campos: ['author', 'pages'] } } },
    { fichas: { MLU1: { isbn: 'A', campos: ['author'] } } },
  );
  assert.deepEqual(filas[0].perdidos, ['pages']);
  assert.equal(resumen(filas).fichas_que_pierden_algun_campo, 1);
});

test('el resumen separa ISBN únicos de fichas y cuenta >=3 campos', () => {
  const filas = [
    { id: 'MLU1', isbn: 'A', ganados: ['pages'] },
    { id: 'MLU2', isbn: 'A', ganados: ['pages'] },
    { id: 'MLU3', isbn: 'B', ganados: ['pages', 'publisher', 'language'] },
    { id: 'MLU4', isbn: 'C', ganados: [] },
  ];
  const r = resumen(filas);
  assert.equal(r.fichas_beneficiadas, 3);
  assert.equal(r.isbn_unicos_con_mejora, 2, 'dos publicaciones del mismo ISBN son un solo ISBN');
  assert.equal(r.fichas_con_3_o_mas, 1);
  assert.equal(r.mejoras_por_campo.pages, 3);
});
