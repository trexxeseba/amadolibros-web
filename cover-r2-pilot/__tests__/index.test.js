import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.js';

class EmptyR2 {
  async get() { return null; }
  async put() {}
  async head() { return null; }
}

const URL = 'https://amadolibros-cover-r2-pilot.example.workers.dev/status';

test('sin secret configurado responde 404', async () => {
  const response = await worker.fetch(new Request(URL), { COVER_R2: new EmptyR2() });
  assert.equal(response.status, 404);
});

test('con bearer incorrecto responde 401 sin revelar el secret', async () => {
  const response = await worker.fetch(new Request(URL, {
    headers: { Authorization: 'Bearer incorrecto' },
  }), { COVER_R2: new EmptyR2(), COVER_PILOT_SECRET: 'secreto-real' });
  assert.equal(response.status, 401);
  assert.equal((await response.text()).includes('secreto-real'), false);
});

test('status autenticado confirma el límite duro y manifest vacío', async () => {
  const response = await worker.fetch(new Request(URL, {
    headers: { Authorization: 'Bearer test-secret' },
  }), {
    COVER_R2: new EmptyR2(),
    COVER_PILOT_SECRET: 'test-secret',
    PILOT_SCOPE: 'preview-20',
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.max_items_per_run, 20);
  assert.equal(data.scope, 'preview-20');
  assert.equal(data.manifest.entries, 0);
});

test('import exige application/json', async () => {
  const response = await worker.fetch(new Request(URL.replace('/status', '/import'), {
    method: 'POST',
    headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'text/plain' },
    body: '{}',
  }), { COVER_R2: new EmptyR2(), COVER_PILOT_SECRET: 'test-secret' });
  assert.equal(response.status, 415);
  assert.equal((await response.json()).code, 'CONTENT_TYPE_INVALID');
});
