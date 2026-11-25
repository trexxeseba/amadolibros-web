import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buscarActual, buscarRenovada, planRenovacion, cuerpoItem, idsDePagina, contar } from '../src/volumen-logica.mjs';

// Datos reales de LIKI leídos el 19/11/2026.
const LIKI = { id: 'C-MLU1010327', type: 'VOLUME', sub_type: 'SPONTH', status: 'started', start_date: '2026-10-20T03:00:00Z', finish_date: '2026-11-20T02:59:59Z', name: 'LIKI', buy_quantity: 2, discount_percentage: 30, allow_combination: true };
const AHORA = Date.parse('2026-11-19T13:00:00Z');

test('encuentra la promo de volumen vigente por nombre', () => {
  const promos = [{ id: 'X', type: 'DEAL', name: 'LIKI', status: 'started' }, LIKI, { id: 'Y', type: 'VOLUME', name: 'otra', status: 'started' }];
  assert.equal(buscarActual(promos, 'liki').id, 'C-MLU1010327');
  assert.equal(buscarActual(promos, 'inexistente'), null);
  assert.equal(buscarActual([{ ...LIKI, status: 'finished' }], 'LIKI'), null);
});

test('el plan renueva igual: mismo N, porcentaje y largo, desde que termina la actual', () => {
  const p = planRenovacion({ actual: LIKI, ficha: LIKI, porcentajeEsperado: 30, ahora: AHORA });
  assert.deepEqual(p.body, { promotion_type: 'VOLUME', sub_type: 'SPONTH', name: 'LIKI', start_date: '2026-11-20T00:00:00', finish_date: '2026-12-20T23:59:59', buy_quantity: 2, discount_percentage: 30, allow_combination: true });
  assert.equal(p.dias, 31);
});

test('el plan se frena si algo no es lo aprobado', () => {
  assert.equal(planRenovacion({ actual: LIKI, ficha: LIKI, porcentajeEsperado: 20, ahora: AHORA }).error, 'porcentaje_distinto_del_aprobado');
  assert.equal(planRenovacion({ actual: { ...LIKI, type: 'DEAL' }, ficha: {}, porcentajeEsperado: 30, ahora: AHORA }).error, 'no_es_volumen');
  assert.equal(planRenovacion({ actual: LIKI, ficha: { buy_quantity: null }, porcentajeEsperado: 30, ahora: AHORA }).error, 'ficha_incompleta');
  assert.equal(planRenovacion({ actual: { ...LIKI, start_date: '2026-09-01T03:00:00Z', finish_date: '2026-10-01T02:59:59Z' }, ficha: {}, porcentajeEsperado: 30, ahora: AHORA }).error, 'la_actual_ya_termino');
});

test('no crea dos veces: reconoce una renovación ya cargada', () => {
  const nueva = { id: 'C-NUEVA', type: 'VOLUME', name: 'LIKI', status: 'pending', start_date: '2026-11-20T03:00:00Z', finish_date: '2026-12-21T02:59:59Z' };
  assert.equal(buscarRenovada([LIKI, nueva], LIKI).id, 'C-NUEVA');
  assert.equal(buscarRenovada([LIKI], LIKI), null);
  assert.equal(buscarRenovada([LIKI, { ...nueva, start_date: '2026-11-01T00:00:00Z' }], LIKI), null);
});

test('cuerpo para sumar un libro, ids de página y conteo', () => {
  assert.deepEqual(cuerpoItem('C-NUEVA'), { promotion_id: 'C-NUEVA', promotion_type: 'VOLUME' });
  assert.deepEqual(idsDePagina({ results: [{ id: 'MLU1' }, { id: 'xx' }, {}] }), ['MLU1']);
  assert.deepEqual(contar(['ok', 'ok', 'http_400']), { ok: 2, http_400: 1 });
});

test('la renovación verifica la cuenta antes de escribir y no nombra Amado Libros', () => {
  const src = fs.readFileSync(new URL('../src/renovar-volumen.mjs', import.meta.url), 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const primeraEscritura = src.search(/\.(post|put|delete)\(/);
  assert.ok(primeraEscritura > 0);
  assert.ok(src.indexOf('await exigirVintage(ml)') > 0 && src.indexOf('await exigirVintage(ml)') < primeraEscritura);
  assert.match(src, /process\.env\.MODO === 'real'/);
  assert.ok(!src.includes('440298103') && !/CUENTAS\s*(\.\s*libros|\[\s*['"]libros)/.test(src));
  const wf = fs.readFileSync(new URL('../../.github/workflows/vintage-promos-volumen.yml', import.meta.url), 'utf8');
  assert.match(wf, /github\.ref != 'refs\/heads\/main'/);
});
