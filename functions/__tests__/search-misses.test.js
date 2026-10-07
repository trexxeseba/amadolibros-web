// Búsquedas sin resultados: lo que se guarda, lo que no, y que nunca rompe.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isLikelyBot,
  montevideoDate,
  normalizeSearchMiss,
  recordSearchMiss,
} from '../_shared/search-misses.js';

test('normaliza para que la misma búsqueda cuente una sola vez', () => {
  assert.equal(normalizeSearchMiss('  García   MÁRQUEZ!! '), 'garcia marquez');
  assert.equal(normalizeSearchMiss('El niño y la garza'), 'el nino y la garza');
  assert.equal(normalizeSearchMiss('x'.repeat(200)).length, 80);
});

test('un ISBN se guarda; un correo o un teléfono no', () => {
  assert.equal(normalizeSearchMiss('978-84-376-0494-7'), '978-84-376-0494-7');
  assert.equal(normalizeSearchMiss('843760494X'), '843760494x');
  assert.equal(normalizeSearchMiss('ana@example.com'), '');
  assert.equal(normalizeSearchMiss('099 123 456'), '');
  assert.equal(normalizeSearchMiss('mi cedula 12345678'), '');
  assert.equal(normalizeSearchMiss('harry potter 1997'), 'harry potter 1997');
  assert.equal(normalizeSearchMiss('   '), '');
});

test('el día es el de Montevideo, no el de UTC', () => {
  assert.equal(montevideoDate(new Date('2026-10-05T02:30:00.000Z')), '2026-10-04');
  assert.equal(montevideoDate(new Date('2026-10-05T03:30:00.000Z')), '2026-10-05');
});

test('los robots no cuentan', () => {
  assert.equal(isLikelyBot('Mozilla/5.0 (compatible; Googlebot/2.1)'), true);
  assert.equal(isLikelyBot(''), true);
  assert.equal(isLikelyBot('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1'), false);
});

test('suma uno por día y por texto, con upsert', async () => {
  const calls = [];
  const db = { prepare: sql => ({ bind: (...params) => ({ run: async () => { calls.push({ sql, params }); } }) }) };
  const now = new Date('2026-10-05T15:00:00.000Z');
  assert.equal(await recordSearchMiss({ db, query: 'Rayuela Cortázar', now }), true);
  assert.match(calls[0].sql, /ON CONFLICT\(date, query\) DO UPDATE SET count = count \+ 1/);
  assert.deepEqual(calls[0].params, ['2026-10-05', 'rayuela cortazar', now.toISOString(), now.toISOString()]);
});

test('sin base, con texto descartado o con D1 caída no escribe ni lanza', async () => {
  assert.equal(await recordSearchMiss({ db: null, query: 'rayuela' }), false);
  const failing = { prepare: () => ({ bind: () => ({ run: async () => { throw new Error('D1 caída'); } }) }) };
  assert.equal(await recordSearchMiss({ db: failing, query: 'rayuela' }), false);
  let touched = false;
  const spy = { prepare: () => { touched = true; return {}; } };
  assert.equal(await recordSearchMiss({ db: spy, query: 'ana@example.com' }), false);
  assert.equal(touched, false);
});
