import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyHealthcheck } from '../healthcheck.js';
import { runSync } from '../index.js';

const BASE_URL = 'https://hc-ping.com/11111111-2222-3333-4444-555555555555';

function timerDeps() {
  return {
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  };
}

function envWithKv(overrides = {}) {
  return {
    SYNC_HEALTHCHECK_URL: BASE_URL,
    AMADO_KV: {
      async put() {},
      async delete() {},
    },
    ...overrides,
  };
}

function successfulSyncDeps(notifyHealthcheckFn) {
  return {
    getAccessTokenFn: async () => 'token',
    buildCatalogFn: async () => ({
      total: 1,
      updated_at: '2026-08-07T12:00:00.000Z',
      items: [{}],
    }),
    publishToR2Fn: async () => {},
    notifyHealthcheckFn,
  };
}

test('sin SYNC_HEALTHCHECK_URL no llama a fetch', async () => {
  let fetchCalls = 0;
  const result = await notifyHealthcheck({}, 'success', {
    fetchFn: async () => { fetchCalls++; },
    ...timerDeps(),
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'not-configured');
  assert.equal(fetchCalls, 0);
});
test('cron envía start antes del éxito', async () => {
  const kinds = [];
  const result = await runSync(
    envWithKv(),
    { source: 'cron' },
    successfulSyncDeps(async (_env, kind) => { kinds.push(kind); }),
  );
  assert.equal(result.status, 'ok');
  assert.deepEqual(kinds, ['start', 'success']);
});

test('start usa el sufijo /start', async () => {
  let target;
  await notifyHealthcheck(envWithKv(), 'start', {
    fetchFn: async url => { target = url; return { ok: true, status: 200 }; },
    ...timerDeps(),
  });
  assert.equal(target, `${BASE_URL}/start`);
});

test('success usa exactamente la URL base', async () => {
  let target;
  await notifyHealthcheck(envWithKv(), 'success', {
    fetchFn: async url => { target = url; return { ok: true, status: 200 }; },
    ...timerDeps(),
  });
  assert.equal(target, BASE_URL);
});

test('fail usa el sufijo /fail', async () => {
  let target;
  await notifyHealthcheck(envWithKv(), 'fail', {
    fetchFn: async url => { target = url; return { ok: true, status: 200 }; },
    ...timerDeps(),
  });
  assert.equal(target, `${BASE_URL}/fail`);
});

test('ejecución manual no envía start', async () => {
  const kinds = [];
  await runSync(
    envWithKv(),
    { source: 'manual-await' },
    successfulSyncDeps(async (_env, kind) => { kinds.push(kind); }),
  );
  assert.equal(kinds.includes('start'), false);
});

test('ejecución manual exitosa envía success', async () => {
  const kinds = [];
  const result = await runSync(
    envWithKv(),
    { source: 'manual-async' },
    successfulSyncDeps(async (_env, kind) => { kinds.push(kind); }),
  );
  assert.equal(result.status, 'ok');
  assert.deepEqual(kinds, ['success']);
});

test('timeout del proveedor no altera un sync exitoso', async () => {
  const notify = (env, kind) => notifyHealthcheck(env, kind, {
    fetchFn: async (_url, { signal }) => {
      if (signal.aborted) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      return { ok: true, status: 200 };
    },
    setTimeoutFn: callback => { callback(); return 1; },
    clearTimeoutFn: () => {},
  });
  const result = await runSync(
    envWithKv(),
    { source: 'manual-await' },
    successfulSyncDeps(notify),
  );
  assert.equal(result.status, 'ok');
});

for (const status of [404, 503]) {
  test(`HTTP ${status} del proveedor no altera el resultado del sync`, async () => {
    const notify = (env, kind) => notifyHealthcheck(env, kind, {
      fetchFn: async () => ({ ok: false, status }),
      ...timerDeps(),
    });
    const result = await runSync(
      envWithKv(),
      { source: 'manual-await' },
      successfulSyncDeps(notify),
    );
    assert.equal(result.status, 'ok');
  });
}

test('fallo de la alarma no oculta el error original', async () => {
  const result = await runSync(envWithKv(), { source: 'manual-await' }, {
    getAccessTokenFn: async () => 'token',
    buildCatalogFn: async () => { throw new Error('error ML original'); },
    publishToR2Fn: async () => {},
    notifyHealthcheckFn: async () => { throw new Error('alarma rota'); },
  });
  assert.equal(result.status, 'error');
  assert.equal(result.error, 'error ML original');
});

test('fallo de KV no impide intentar /fail', async () => {
  const kinds = [];
  const env = envWithKv({
    AMADO_KV: {
      async put() { throw new Error('KV caído'); },
      async delete() {},
    },
  });
  const result = await runSync(env, { source: 'manual-await' }, {
    getAccessTokenFn: async () => { throw new Error('auth caída'); },
    buildCatalogFn: async () => {},
    publishToR2Fn: async () => {},
    notifyHealthcheckFn: async (_env, kind) => { kinds.push(kind); },
  });
  assert.equal(result.status, 'error');
  assert.deepEqual(kinds, ['fail']);
});

test('logs y errores no contienen la URL secreta', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(String(message));
  try {
    const result = await notifyHealthcheck(envWithKv(), 'success', {
      fetchFn: async () => ({ ok: false, status: 500 }),
      ...timerDeps(),
    });
    assert.equal(result.sent, false);
    assert.equal(warnings.join('\n').includes(BASE_URL), false);
  } finally {
    console.warn = originalWarn;
  }
});

test('no envía token de ML, catálogo ni cuerpo de error', async () => {
  let request;
  await notifyHealthcheck({
    SYNC_HEALTHCHECK_URL: BASE_URL,
    ML_ACCESS_TOKEN: 'TOKEN_ML',
    catalog: { title: 'CATALOGO_SECRETO' },
  }, 'fail', {
    fetchFn: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200 };
    },
    ...timerDeps(),
  });
  const serialized = JSON.stringify(request);
  assert.equal(serialized.includes('TOKEN_ML'), false);
  assert.equal(serialized.includes('CATALOGO_SECRETO'), false);
  assert.equal(Object.hasOwn(request.options, 'body'), false);
});

test('rechaza configuración que no sea HTTPS o use otro host', async () => {
  let fetchCalls = 0;
  for (const url of [
    'http://hc-ping.com/id',
    'https://example.com/id',
    'https://hc-ping.com.evil.example/id',
  ]) {
    const result = await notifyHealthcheck({ SYNC_HEALTHCHECK_URL: url }, 'success', {
      fetchFn: async () => { fetchCalls++; },
      ...timerDeps(),
    });
    assert.equal(result.reason, 'invalid-config');
  }
  assert.equal(fetchCalls, 0);
});

test('el timeout queda limitado a 5 segundos', async () => {
  let scheduledMs;
  await notifyHealthcheck(envWithKv(), 'success', {
    fetchFn: async () => ({ ok: true, status: 200 }),
    setTimeoutFn: (_callback, ms) => { scheduledMs = ms; return 1; },
    clearTimeoutFn: () => {},
    timeoutMs: 60000,
  });
  assert.equal(scheduledMs, 5000);
});
