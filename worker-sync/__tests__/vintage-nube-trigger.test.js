import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispararVintageNube, CRON_VINTAGE_NUBE } from '../vintage-nube-trigger.js';
const J = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const env = { GITHUB_TOKEN: 'x' };

test('una vez por hora, a los 37', () => { assert.equal(CRON_VINTAGE_NUBE, '37 * * * *'); });

test('dispara vintage-nube.yml con accion=auto cuando no hay ninguna corriendo', async () => {
  let post = null;
  const fetcher = async (url, o) => { if (o?.method === 'POST') { post = { url: String(url), body: JSON.parse(o.body) }; return new Response(null, { status: 204 }); } return J({ total_count: 0 }); };
  assert.equal((await dispararVintageNube(env, { fetcher })).state, 'disparado');
  assert.match(post.url, /vintage-nube\.yml\/dispatches$/);
  assert.deepEqual(post.body, { ref: 'main', inputs: { accion: 'auto' } });
});

test('no apila: si hay una en curso o en cola no dispara', async () => {
  const posts = [];
  const fetcher = async (url, o) => { if (o?.method === 'POST') { posts.push(1); return new Response(null, { status: 204 }); } return J({ total_count: String(url).includes('in_progress') ? 1 : 0 }); };
  assert.equal((await dispararVintageNube(env, { fetcher })).state, 'ya_hay_una');
  assert.equal(posts.length, 0);
});

test('sin token no llama a GitHub', async () => {
  let calls = 0;
  assert.equal((await dispararVintageNube({}, { fetcher: async () => { calls++; return J({}); } })).state, 'sin_token');
  assert.equal(calls, 0);
});
