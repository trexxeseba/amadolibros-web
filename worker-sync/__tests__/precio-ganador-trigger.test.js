import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispararPrecioGanador, CRONS_PRECIO_GANADOR, CRON_RESUMEN, cuentaDelHorario } from '../precio-ganador-trigger.js';

const J = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const env = { GITHUB_TOKEN: 'x', RESEND_API_KEY: 'r', PRECIO_GANADOR_EMAIL_TO: 'a@b.c' };
const ahora = Date.parse('2026-11-05T12:00:00Z');

test('cada 2 horas de 09:00 a 21:00 de Montevideo, en UTC', () => { assert.deepEqual(CRONS_PRECIO_GANADOR, ['0 12 * * *', '0 14 * * *', '0 16 * * *', '0 18 * * *', '0 20 * * *', '0 22 * * *', '0 0 * * *']); });

test('no dispara si ya hay una corrida de esta franja (creada en los últimos 10 minutos)', async () => {
  const llamadas = [];
  const fetcher = async (url, o) => { llamadas.push([String(url), o?.method ?? 'GET']); return J({ workflow_runs: [{ event: 'schedule', created_at: '2026-11-05T11:55:00Z', status: 'completed', conclusion: 'success', html_url: 'u' }] }); };
  const r = await dispararPrecioGanador(env, { fetcher, now: () => ahora });
  assert.equal(r.state, 'ya_corrio');
  assert.ok(!llamadas.some(([, m]) => m === 'POST'));
});

test('dispara con cuenta=ambas cuando no hay corrida reciente', async () => {
  let body = null;
  const fetcher = async (url, o) => { if (o?.method === 'POST') { body = JSON.parse(o.body); return new Response(null, { status: 204 }); } return J({ workflow_runs: [{ event: 'schedule', created_at: '2026-11-05T05:00:00Z', status: 'completed', conclusion: 'success' }] }); };
  const r = await dispararPrecioGanador(env, { cron: '0 12 * * *', fetcher, now: () => ahora });
  assert.equal(r.state, 'disparado');
  assert.deepEqual(body, { ref: 'main', inputs: { accion: 'correr', cuenta: 'ambas' } });
});

test('una corrida atrasada de la franja anterior no tapa a la de las 21:00 y la de las 21:00 pide el mail', async () => {
  // El 05/11 la programada de las 18:00 UTC arrancó a las 23:13: 47 minutos antes de las 00:00 UTC.
  const medianoche = Date.parse('2026-11-06T00:00:00Z');
  let body = null;
  const fetcher = async (url, o) => { if (o?.method === 'POST') { body = JSON.parse(o.body); return new Response(null, { status: 204 }); } return J({ workflow_runs: [{ event: 'schedule', created_at: '2026-11-05T23:13:52Z', status: 'completed', conclusion: 'success' }] }); };
  const r = await dispararPrecioGanador(env, { cron: CRON_RESUMEN, fetcher, now: () => medianoche });
  assert.equal(r.state, 'disparado');
  assert.deepEqual(body, { ref: 'main', inputs: { accion: 'correr', cuenta: 'ambas', correo: 'true' } });
});

test('sólo el horario de las 21:00 pide el mail de resumen', async () => {
  let body = null;
  const fetcher = async (url, o) => { if (o?.method === 'POST') { body = JSON.parse(o.body); return new Response(null, { status: 204 }); } return J({ workflow_runs: [] }); };
  await dispararPrecioGanador(env, { cron: '0 12 * * *', fetcher, now: () => ahora });
  assert.equal(body.inputs.correo, undefined);
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

test('Libros corre en todos los horarios y Vintage sólo a las 09:00 y 21:00 (Seba, 11/11/2026)', async () => {
  assert.deepEqual(CRONS_PRECIO_GANADOR.filter(c => cuentaDelHorario(c) === 'ambas'), ['0 12 * * *', '0 0 * * *']);
  for (const c of CRONS_PRECIO_GANADOR.filter(c => c !== '0 12 * * *' && c !== '0 0 * * *')) assert.equal(cuentaDelHorario(c), 'libros');
  let body = null;
  const fetcher = async (url, o) => { if (o?.method === 'POST') { body = JSON.parse(o.body); return new Response(null, { status: 204 }); } return J({ workflow_runs: [] }); };
  await dispararPrecioGanador(env, { cron: '0 16 * * *', fetcher, now: () => ahora });
  assert.deepEqual(body.inputs, { accion: 'correr', cuenta: 'libros' });
  await dispararPrecioGanador(env, { cron: '0 12 * * *', fetcher, now: () => ahora });
  assert.deepEqual(body.inputs, { accion: 'correr', cuenta: 'ambas' });
});
