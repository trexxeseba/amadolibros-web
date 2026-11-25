import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispararPoda, CRONS_PODA, accionDelHorario, CRON_PODA_AUDITAR } from '../poda-trigger.js';

const J = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

test('11:30 y 21:30 de Montevideo, en UTC', () => assert.deepEqual(CRONS_PODA, ['30 14 * * *', '30 0 * * *']));
test('la de las 21:30 es la auditoría', () => { assert.equal(accionDelHorario(CRON_PODA_AUDITAR), 'auditar'); assert.equal(accionDelHorario('30 14 * * *'), 'correr'); });

test('sin token no dispara', async () => assert.equal((await dispararPoda({})).state, 'sin_token'));

test('dispara poda-anuncios.yml en main con la acción del horario', async () => {
  let url = null, body = null;
  const fetcher = async (u, o) => { if (o?.method === 'POST') { url = String(u); body = JSON.parse(o.body); return new Response(null, { status: 204 }); } return J({ total_count: 0 }); };
  const r = await dispararPoda({ GITHUB_TOKEN: 'x' }, { cron: CRON_PODA_AUDITAR, fetcher });
  assert.equal(r.state, 'disparado');
  assert.match(url, /workflows\/poda-anuncios\.yml\/dispatches$/);
  assert.deepEqual(body, { ref: 'main', inputs: { accion: 'auditar' } });
});

test('si ya hay una corrida en curso no apila otra', async () => {
  let posts = 0;
  const fetcher = async (u, o) => { if (o?.method === 'POST') posts++; return J({ total_count: 1 }); };
  assert.equal((await dispararPoda({ GITHUB_TOKEN: 'x' }, { fetcher })).state, 'ya_hay_una');
  assert.equal(posts, 0);
});

test('reintenta una vez y después informa la falla', async () => {
  let posts = 0;
  const fetcher = async (u, o) => { if (o?.method === 'POST') { posts++; return new Response('x', { status: 500 }); } return J({ total_count: 0 }); };
  const r = await dispararPoda({ GITHUB_TOKEN: 'x' }, { fetcher, sleep: async () => {} });
  assert.equal(posts, 2); assert.equal(r.state, 'fallo_disparo');
});
