import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clasificarAvisos, decidirEnvio, huella } from '../src/avisos.mjs';
import { normalizeIsbn, itemIsbn } from '../src/isbn.mjs';

const caso = (over = {}) => ({ tipo: 'pierde_con_plazo', item: { id: 'MLU1' }, ganador: { item_id: 'MLU9', precio: 800, plazo_dias: 20 }, mi_precio: 1000, ...over });

test('un aviso repetido sin novedades no vuelve a salir; un cambio sí', () => {
  const t0 = '2026-11-03T10:00:00.000Z', t1 = '2026-11-03T13:00:00.000Z';
  const a = clasificarAvisos([caso()], {}, t0);
  assert.equal(a.novedades.length, 1);
  const b = clasificarAvisos([caso()], a.avisos, t1);
  assert.equal(b.novedades.length, 0); assert.equal(b.repetidos.length, 1);
  const c = clasificarAvisos([caso({ ganador: { item_id: 'MLU9', precio: 700, plazo_dias: 20 } })], b.avisos, t1);
  assert.equal(c.novedades.length, 1);
});

test('huellas de oportunidad distinguen revisar de importe', () => {
  const op = { tipo: 'oportunidad', item: { id: 'MLU1' }, estado: 'solo_con_plazo', precio_actual: 1000, sugerido: null };
  assert.notEqual(huella(op), huella({ ...op, sugerido: 1200 }));
});

test('política de envío: resumen diario una vez por día, después sólo novedades', () => {
  assert.equal(decidirEnvio({ fechaMontevideo: '2026-11-03', ultimoResumen: null, novedades: [] }).motivo, 'resumen_diario');
  assert.equal(decidirEnvio({ fechaMontevideo: '2026-11-03', ultimoResumen: '2026-11-03', novedades: [] }).enviar, false);
  assert.equal(decidirEnvio({ fechaMontevideo: '2026-11-03', ultimoResumen: '2026-11-03', novedades: [caso()] }).motivo, 'novedades');
});

test('ISBN-10 e ISBN-13 se normalizan al mismo valor', () => {
  assert.equal(normalizeIsbn('950-12-0399-9'), '9789501203998');
  assert.equal(normalizeIsbn('978-950-12-0399-8'), '9789501203998');
  assert.equal(normalizeIsbn('9789501203999'), null);
  assert.equal(normalizeIsbn('abc'), null);
  assert.equal(itemIsbn({ attributes: [{ id: 'GTIN', value_name: '9501203999' }] }), '9789501203998');
});
