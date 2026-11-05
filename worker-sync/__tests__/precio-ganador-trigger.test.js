import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispararPrecioGanador, CRONS_PRECIO_GANADOR, cuentaDelHorario } from '../precio-ganador-trigger.js';

const J = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const env = { GITHUB_TOKEN: 'x', RESEND_API_KEY: 'r', PRECIO_GANADOR_EMAIL_TO: 'a@b.c' };
const ahora = Date.parse('2026-11-05T12:00:00Z');

test('tres horarios fijos en UTC', () => { assert.deepEqual(CRONS_PRECIO_GANADOR, ['0 12 * * *', '0 18 * * *', '0 0 * * *']); });

test('no dispara si ya hubo una corrida exitosa en las últimas 2 horas', async () => {
  const llamadas = [];
  const fetcher = async (url, o) => { llamadas.push([String(url), o?.method ?? 'GET']); return J({ workflow_runs: [{ event: 'schedule', created_at: '2026-11-05T11:10:00Z', status: 'completed', conclusion: 'success', html_url: 'u' }] }); };
  const r = await dispararPrecioGanador(env, { fetcher, now: () => ahora });
  assert.equal(r.state, 'ya_corrio');
  assert.ok(!llamadas.some(([, m]) => m === 'POST'));
});

test('dispara con cuenta=ambas cuando no hay corrida reciente', async () => {
  let body = null;
  const fetcher = async (url, o) => { if (o?.method === 'POST') { body = JSON.parse(o.body); return new Response(null, { status: 204 }); } return J({ workflow_runs: [{ event: 'schedule', created_at: '2026-11-05T05:00:00Z', status: 'completed', conclusion: 'success' }] }); };
  const r = await dispararPrecioGanador(env, { fetcher, now: () => ahora });
  assert.equal(r.state, 'disparado');
  assert.deepEqual(body, { ref: 'main', inputs: { accion: 'correr', cuenta: 'ambas' } });
});

test('reintenta una vez y, si no pudo, manda la alerta por Resend', async () => {
  let posts = 0, mail = null;
  const fetcher = async (url, o) => {
    if (String(url).includes('resend.com')) { mail = JSON.parse(o.body); return J({ id: '1' }); }
    if (o?.method === 'POST') { posts++; return J({ message: 'no' }, 500); }
    return J({ workflow_runs: [] });
  };
  const r = await dispararPrecioGanador(env, { fetcher, now: () => ahora, sleep: async () => {} });
  assert.deepEqual([r.state, r.alerta, posts], ['fallo_disparo', 'enviada', 2]);
  assert.match(mail.subject, /ALARMA Precio Ganador/);
  assert.ok(!JSON.stringify(mail).includes('x"'), 'el mail no lleva el token');
});

test('sin GITHUB_TOKEN no llama a GitHub y avisa', async () => {
  let github = 0;
  const fetcher = async url => { if (String(url).includes('github')) github++; return J({ id: '1' }); };
  const r = await dispararPrecioGanador({ ...env, GITHUB_TOKEN: '' }, { fetcher });
  assert.deepEqual([r.state, r.alerta, github], ['sin_token', 'enviada', 0]);
});

test('Vintage corre dos veces por día (09:00 y 21:00 de Montevideo); Libros en los tres horarios', async () => {
  assert.equal(cuentaDelHorario('0 0 * * *'), 'ambas');
  assert.equal(cuentaDelHorario('0 12 * * *'), 'ambas');
  assert.equal(cuentaDelHorario('0 18 * * *'), 'libros');
  let body = null;
  const fetcher = async (url, o) => { if (o?.method === 'POST') { body = JSON.parse(o.body); return new Response(null, { status: 204 }); } return J({ workflow_runs: [] }); };
  await dispararPrecioGanador(env, { cron: '0 18 * * *', fetcher, now: () => ahora });
  assert.equal(body.inputs.cuenta, 'libros');
});
