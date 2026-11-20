import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispararVintageNube, dispararVintageVigia, dispararArnoia, dispararHermes, dispararGuardian, CRON_GUARDIAN, CRON_VINTAGE_NUBE, CRON_VINTAGE_VIGIA, CRON_ARNOIA, CRON_HERMES } from '../vintage-nube-trigger.js';
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

test('el vigía de propiedad intelectual se lanza cada 10 minutos, sin inputs y sin apilarse', async () => {
  assert.equal(CRON_VINTAGE_VIGIA, '*/10 * * * *');
  let post = null;
  const fetcher = async (url, o) => { if (o?.method === 'POST') { post = { url: String(url), body: JSON.parse(o.body) }; return new Response(null, { status: 204 }); } return J({ total_count: 0 }); };
  const vigia = await import('../vintage-nube-trigger.js');
  const r = await vigia.dispararVintageNube(env, { fetcher, workflow: 'vintage-vigia.yml', inputs: {} });
  assert.equal(r.state, 'disparado');
  assert.match(post.url, /vintage-vigia\.yml\/dispatches$/);
  assert.deepEqual(post.body, { ref: 'main', inputs: {} });
  assert.equal(typeof dispararVintageVigia, 'function');
});

test('Arnoia cada hora al :17 y Hermes de 09:07 a 15:07, pidiendo hermes-publicar.yml con sus inputs', async () => {
  assert.equal(CRON_ARNOIA, '17 * * * *');
  assert.equal(CRON_HERMES, '7 12-18 * * *');
  const posts = [];
  const fetcher = async (url, o) => { if (o?.method === 'POST') { posts.push({ url: String(url), body: JSON.parse(o.body) }); return new Response(null, { status: 204 }); } return J({ total_count: 0 }); };
  const orig = globalThis.fetch; globalThis.fetch = fetcher;
  try {
    assert.equal((await dispararArnoia(env)).state, 'disparado');
    assert.equal((await dispararHermes(env)).state, 'disparado');
  } finally { globalThis.fetch = orig; }
  assert.match(posts[0].url, /hermes-publicar\.yml\/dispatches$/);
  assert.deepEqual(posts[0].body, { ref: 'main', inputs: { modo: 'publicar', cantidad: '70', rama: 'main', fuente: 'arnoia', tradicional: 'false' } });
  assert.deepEqual(posts[1].body.inputs, { modo: 'publicar', cantidad: '25', rama: 'main', fuente: 'hermes', tradicional: 'false' });
});

test('el guardián se lanza cada 15 minutos pidiendo guardian.yml sin inputs', async () => {
  assert.equal(CRON_GUARDIAN, '*/15 * * * *');
  const posts = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, o) => { if (o?.method === 'POST') { posts.push({ url: String(url), body: JSON.parse(o.body) }); return new Response(null, { status: 204 }); } return J({ total_count: 0 }); };
  try { assert.equal((await dispararGuardian(env)).state, 'disparado'); } finally { globalThis.fetch = orig; }
  assert.match(posts[0].url, /guardian\.yml\/dispatches$/);
  assert.deepEqual(posts[0].body, { ref: 'main', inputs: {} });
});
