import assert from 'node:assert/strict';
import test from 'node:test';

import { WORKFLOWS_VIGILADOS } from '../../functions/_shared/health-rules.js';
import { construirCache } from '../ops/panel-salud-cache.mjs';

const NOW = new Date('2026-10-24T22:00:00.000Z');

test('arma la caché del panel con el token del job y solo tres campos por corrida', async () => {
  const pedidos = [];
  const fetchFn = async (url, init) => {
    pedidos.push({ url: String(url), auth: init.headers.Authorization });
    return Response.json({ workflow_runs: [{ conclusion: 'success', created_at: '2026-10-24T20:00:00Z', html_url: 'https://github.com/x/y/actions/runs/1', head_sha: 'no-va' }] });
  };
  const { completa, valor } = await construirCache({ token: 'token-de-prueba', now: NOW, fetchFn });
  assert.equal(completa, true);
  assert.equal(pedidos.length, WORKFLOWS_VIGILADOS.length);
  assert.ok(pedidos.every(p => p.auth === 'Bearer token-de-prueba'));
  assert.equal(valor.consultadoEn, NOW.toISOString());
  const una = valor.corridas[WORKFLOWS_VIGILADOS[0].archivo];
  assert.deepEqual(Object.keys(una.corrida).sort(), ['conclusion', 'created_at', 'html_url']);
});

test('si una consulta falla, la lectura queda marcada incompleta', async () => {
  let n = 0;
  const fetchFn = async () => (n++ === 0 ? new Response('', { status: 404 }) : Response.json({ workflow_runs: [] }));
  const { completa } = await construirCache({ now: NOW, fetchFn });
  assert.equal(completa, false);
});
