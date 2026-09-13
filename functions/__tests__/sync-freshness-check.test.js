import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSummary,
  evaluateSyncStatus,
} from '../../scripts/ops/sync-freshness-check.mjs';

const AHORA = new Date('2026-09-13T21:00:00.000Z');

// `worker` y `catalog` se sacan del resto a propósito: si quedaran dentro del
// spread final pisarían el objeto ya combinado con su versión parcial, y cada
// test terminaría probando un estado sin `last_ok` sin querer.
function estado(overrides = {}) {
  const { worker = {}, catalog = {}, ...resto } = overrides;
  return {
    status: 'ok',
    healthy: true,
    warnings: [],
    ...resto,
    worker: {
      last_ok: '2026-09-13T07:20:00.000Z',
      has_error: false,
      in_progress: false,
      possibly_stuck: false,
      ...worker,
    },
    catalog: {
      available: true,
      meta_available: true,
      total_items: 7082,
      ...catalog,
    },
  };
}

test('un sync reciente y sin errores aprueba', () => {
  const veredicto = evaluateSyncStatus(estado(), { now: AHORA });
  assert.equal(veredicto.ok, true);
  assert.equal(veredicto.problemas.length, 0);
  assert.equal(veredicto.edadHoras, 13.7);
  assert.equal(veredicto.totalItems, 7082);
});

test('un sync viejo reprueba y dice cuántas horas hace', () => {
  const veredicto = evaluateSyncStatus(
    estado({ worker: { last_ok: '2026-09-11T07:20:00.000Z' } }),
    { now: AHORA },
  );
  assert.equal(veredicto.ok, false);
  assert.match(veredicto.problemas[0], /61\.7 h/);
  assert.match(veredicto.problemas[0], /26 h/);
});

test('nunca haber publicado no se confunde con haber publicado hace mucho', () => {
  const veredicto = evaluateSyncStatus(estado({ worker: { last_ok: '' } }), { now: AHORA });
  assert.equal(veredicto.ok, false);
  assert.match(veredicto.problemas[0], /nunca registró/);
  assert.equal(veredicto.edadHoras, null);
});

test('un error registrado por el Worker reprueba aunque la fecha sea fresca', () => {
  const veredicto = evaluateSyncStatus(estado({ worker: { has_error: true } }), { now: AHORA });
  assert.equal(veredicto.ok, false);
  assert.equal(veredicto.problemas.length, 1);
  assert.match(veredicto.problemas[0], /sync:last_error/);
});

test('un sync trabado reprueba', () => {
  const veredicto = evaluateSyncStatus(
    estado({ worker: { possibly_stuck: true, in_progress: true } }),
    { now: AHORA },
  );
  assert.equal(veredicto.ok, false);
  assert.match(veredicto.problemas.join(' '), /trabado/);
});

test('un catálogo caído reprueba aunque el sync haya terminado bien', () => {
  const veredicto = evaluateSyncStatus(
    estado({ catalog: { available: false, meta_available: true, total_items: null } }),
    { now: AHORA },
  );
  assert.equal(veredicto.ok, false);
  assert.match(veredicto.problemas.join(' '), /catalog\.json/);
});

test('un sync en curso es contexto, no una falla', () => {
  const veredicto = evaluateSyncStatus(estado({ worker: { in_progress: true } }), { now: AHORA });
  assert.equal(veredicto.ok, true);
  assert.match(veredicto.notas.join(' '), /en curso/);
});

test('el resumen dice sin rodeos si publicó o no', () => {
  const bien = buildSummary(evaluateSyncStatus(estado(), { now: AHORA }), 'https://x/api/status');
  assert.match(bien, /El sync publicó dentro de plazo/);

  const mal = buildSummary(
    evaluateSyncStatus(estado({ worker: { has_error: true } }), { now: AHORA }),
    'https://x/api/status',
  );
  assert.match(mal, /NO está publicando/);
  assert.match(mal, /sync:last_error/);
});
