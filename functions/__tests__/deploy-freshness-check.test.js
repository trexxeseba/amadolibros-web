import test from 'node:test';
import assert from 'node:assert/strict';

import {
  construirResumen,
  decidirAccion,
  evaluarDeployAlDia,
} from '../../scripts/ops/deploy-freshness-check.mjs';

const AHORA = new Date('2026-10-05T21:00:00.000Z');
const PROD = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);

function commit(fecha, login = 'trexxeseba', type = 'User') {
  return { author: { login, type }, commit: { committer: { date: fecha } } };
}

test('mismo commit en producción y en main: al día', () => {
  const v = evaluarDeployAlDia({ shaProduccion: MAIN, shaMain: MAIN, pendientes: [], now: AHORA });
  assert.equal(v.estado, 'al_dia');
  assert.equal(v.ok, true);
});

test('sin /build.json no hay veredicto ni falla', () => {
  const v = evaluarDeployAlDia({ shaProduccion: '', shaMain: MAIN, pendientes: null, now: AHORA });
  assert.equal(v.estado, 'sin_dato');
  assert.equal(v.ok, true);
});

test('si no se pudo comparar no se inventa un atraso', () => {
  const v = evaluarDeployAlDia({ shaProduccion: PROD, shaMain: MAIN, pendientes: null, now: AHORA });
  assert.equal(v.estado, 'sin_dato');
});

test('un commit de hace 10 minutos es un deploy en curso, no una falla', () => {
  const v = evaluarDeployAlDia({
    shaProduccion: PROD, shaMain: MAIN, now: AHORA,
    pendientes: [commit('2026-10-05T20:50:00Z')],
  });
  assert.equal(v.estado, 'publicando');
  assert.equal(v.ok, true);
});

test('un commit de hace dos horas sin publicar es un atraso', () => {
  const v = evaluarDeployAlDia({
    shaProduccion: PROD, shaMain: MAIN, now: AHORA,
    pendientes: [commit('2026-10-05T19:00:00Z'), commit('2026-10-05T20:55:00Z')],
  });
  assert.equal(v.estado, 'atrasado');
  assert.equal(v.ok, false);
  // Se mide desde el commit pendiente más viejo.
  assert.equal(v.minutos, 120);
  assert.equal(v.pendientesHumanos, 2);
  assert.match(v.problema, /aaaaaaa.*bbbbbbb/);
});

test('los commits de bots no cuentan: un push con el token de Actions no despliega', () => {
  const v = evaluarDeployAlDia({
    shaProduccion: PROD, shaMain: MAIN, now: AHORA,
    pendientes: [commit('2026-10-05T10:00:00Z', 'github-actions[bot]', 'Bot')],
  });
  assert.equal(v.estado, 'al_dia');
});

const ATRASADO = { estado: 'atrasado' };

test('sin atraso no se hace nada', () => {
  assert.equal(decidirAccion({ estado: 'al_dia' }, []).accion, 'nada');
});

test('con un deploy en cola se espera', () => {
  const d = decidirAccion(ATRASADO, [{ status: 'queued', event: 'push', created_at: '2026-10-05T20:59:00Z' }],
    { desdeIso: '2026-10-05T19:00:00Z' });
  assert.equal(d.accion, 'esperar');
});

test('atrasado, sin deploy en curso y sin reintento previo: se relanza', () => {
  const d = decidirAccion(ATRASADO, [
    { status: 'completed', conclusion: 'cancelled', event: 'push', created_at: '2026-10-05T19:01:00Z' },
    // Un relanzamiento anterior al commit pendiente no cuenta para este.
    { status: 'completed', conclusion: 'success', event: 'workflow_dispatch', created_at: '2026-10-04T12:00:00Z' },
  ], { desdeIso: '2026-10-05T19:00:00Z' });
  assert.equal(d.accion, 'relanzar');
});

test('si ya se relanzó para estos commits y sigue atrás, falla en vez de repetir', () => {
  const d = decidirAccion(ATRASADO, [
    { status: 'completed', conclusion: 'cancelled', event: 'workflow_dispatch', created_at: '2026-10-05T19:40:00Z' },
  ], { desdeIso: '2026-10-05T19:00:00Z' });
  assert.equal(d.accion, 'fallar');
});

test('el resumen dice qué se hizo', () => {
  const v = evaluarDeployAlDia({
    shaProduccion: PROD, shaMain: MAIN, now: AHORA,
    pendientes: [commit('2026-10-05T19:00:00Z')],
  });
  assert.match(construirResumen(v, { accion: 'relanzar' }), /se relanza deploy\.yml/);
  assert.match(construirResumen(v, { accion: 'fallar', corrida: {} }), /a mano/);
});
