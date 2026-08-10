import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBackoffMs,
  createMlRetryTelemetry,
  createSyncRetryBudget,
  mlGet,
  parseRetryAfterMs,
  sanitizeEndpoint,
} from '../meli-catalog.js';

const URL_WITH_SECRETS =
  'https://api.mercadolibre.com/items/search?access_token=TOKEN-SECRETO&scroll_id=SCROLL-SECRETO';

function fakeResponse(status, data = { ok: true }, retryAfter = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => name.toLowerCase() === 'retry-after' ? retryAfter : null },
    async json() { return data; },
  };
}

function sequenceFetch(responses, calls = []) {
  let index = 0;
  return async (url, options) => {
    calls.push({ url, options });
    const response = responses[Math.min(index, responses.length - 1)];
    index++;
    return response;
  };
}

function deterministicDeps(overrides = {}) {
  const waits = [];
  return {
    waits,
    deps: {
      sleepFn: async ms => { waits.push(ms); },
      random: () => 0,
      now: () => Date.parse('2026-08-07T12:00:00.000Z'),
      ...overrides,
    },
  };
}

test('mlGet devuelve JSON en el primer intento y envía Authorization', async () => {
  const calls = [];
  const { deps, waits } = deterministicDeps({
    fetchFn: sequenceFetch([fakeResponse(200, { value: 7 })], calls),
  });
  const result = await mlGet(URL_WITH_SECRETS, 'token-real', deps);
  assert.deepEqual(result, { value: 7 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token-real');
  assert.deepEqual(waits, []);
});
test('429 respeta Retry-After en segundos enteros', async () => {
  const { deps, waits } = deterministicDeps({
    fetchFn: sequenceFetch([fakeResponse(429, {}, '3'), fakeResponse(200)]),
  });
  await mlGet(URL_WITH_SECRETS, 'token', deps);
  assert.deepEqual(waits, [3000]);
});

test('429 respeta Retry-After como fecha HTTP', async () => {
  const { deps, waits } = deterministicDeps({
    fetchFn: sequenceFetch([
      fakeResponse(429, {}, 'Fri, 07 Aug 2026 12:00:04 GMT'),
      fakeResponse(200),
    ]),
  });
  await mlGet(URL_WITH_SECRETS, 'token', deps);
  assert.deepEqual(waits, [4000]);
});

test('Retry-After queda acotado a 30 segundos', () => {
  assert.equal(parseRetryAfterMs('120', { nowMs: 0 }), 30000);
});

test('telemetría conserva Retry-After anunciado aunque el comportamiento siga capado a 30 s', async () => {
  const telemetry = createMlRetryTelemetry();
  const { deps, waits } = deterministicDeps({
    fetchFn: sequenceFetch([fakeResponse(429, {}, '60'), fakeResponse(200)]),
    telemetry,
    requestContext: {
      phase: 'scan', catalog_status: 'active', page: 37, endpoint_kind: 'items_search',
    },
  });
  await mlGet(URL_WITH_SECRETS, 'token', deps);
  assert.deepEqual(waits, [30000]);
  assert.equal(telemetry.rate_limit_429_count, 1);
  assert.equal(telemetry.rate_limit_by_phase.scan, 1);
  assert.equal(telemetry.max_retry_after_ms, 60000);
  assert.equal(telemetry.max_applied_delay_ms, 30000);
  assert.deepEqual(telemetry.last_event, {
    status: 429,
    phase: 'scan',
    catalog_status: 'active',
    page: 37,
    batch: null,
    total_batches: null,
    endpoint_kind: 'items_search',
    attempt: 1,
    will_retry: true,
    stop_reason: null,
    retry_after_ms: 60000,
    applied_delay_ms: 30000,
  });
  const serialized = JSON.stringify(telemetry);
  assert.equal(serialized.includes('TOKEN-SECRETO'), false);
  assert.equal(serialized.includes('SCROLL-SECRETO'), false);
});

test('telemetría distingue la fase details y el batch sin guardar IDs ni query', async () => {
  const telemetry = createMlRetryTelemetry();
  const { deps } = deterministicDeps({
    fetchFn: sequenceFetch([fakeResponse(503), fakeResponse(200)]),
    telemetry,
    requestContext: { phase: 'details', batch: 12, total_batches: 80, endpoint_kind: 'items_details' },
  });
  await mlGet('https://api.mercadolibre.com/items?ids=MLU1,MLU2', 'token', deps);
  assert.equal(telemetry.transient_count, 1);
  assert.equal(telemetry.rate_limit_429_count, 0);
  assert.equal(telemetry.last_event.phase, 'details');
  assert.equal(telemetry.last_event.batch, 12);
  assert.equal(telemetry.last_event.total_batches, 80);
  assert.equal(telemetry.last_event.endpoint_kind, 'items_details');
  assert.equal(JSON.stringify(telemetry).includes('MLU1'), false);
});

test('Retry-After ausente usa equal jitter determinista', async () => {
  const { deps, waits } = deterministicDeps({
    fetchFn: sequenceFetch([fakeResponse(429), fakeResponse(200)]),
    random: () => 0.5,
  });
  await mlGet(URL_WITH_SECRETS, 'token', deps);
  assert.deepEqual(waits, [750]);
});

test('Retry-After inválido usa equal jitter', async () => {
  const { deps, waits } = deterministicDeps({
    fetchFn: sequenceFetch([fakeResponse(429, {}, 'mañana'), fakeResponse(200)]),
  });
  await mlGet(URL_WITH_SECRETS, 'token', deps);
  assert.deepEqual(waits, [500]);
});

test('equal jitter conserva el piso de la mitad', () => {
  assert.equal(computeBackoffMs(3, { random: () => 0 }), 4000);
});

test('equal jitter nunca supera el techo exponencial', () => {
  assert.equal(computeBackoffMs(3, { random: () => 1 }), 8000);
});

for (const status of [500, 502, 503, 504]) {
  test(`HTTP ${status} se reintenta y puede recuperarse`, async () => {
    const calls = [];
    const { deps, waits } = deterministicDeps({
      fetchFn: sequenceFetch([fakeResponse(status), fakeResponse(200)], calls),
    });
    const result = await mlGet(URL_WITH_SECRETS, 'token', deps);
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [500]);
  });
}

for (const status of [400, 401, 403, 404, 418]) {
  test(`HTTP ${status} falla de inmediato sin retry`, async () => {
    const calls = [];
    const { deps, waits } = deterministicDeps({
      fetchFn: sequenceFetch([fakeResponse(status)], calls),
    });
    await assert.rejects(mlGet(URL_WITH_SECRETS, 'token', deps), /no reintentable/);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });
}

test('se detiene tras 7 intentos totales', async () => {
  const calls = [];
  const { deps, waits } = deterministicDeps({
    fetchFn: sequenceFetch([fakeResponse(429, {}, '1')], calls),
  });
  await assert.rejects(mlGet(URL_WITH_SECRETS, 'token', deps), /Agotados 6 reintentos/);
  assert.equal(calls.length, 7);
  assert.equal(waits.length, 6);
});

test('el presupuesto por request aborta antes de volver a dormir', async () => {
  const { deps, waits } = deterministicDeps({
    fetchFn: sequenceFetch([fakeResponse(429, {}, '30')]),
    maxCumulativeWaitMs: 40000,
  });
  await assert.rejects(
    mlGet(URL_WITH_SECRETS, 'token', deps),
    /presupuesto de espera por request agotado/i,
  );
  assert.deepEqual(waits, [30000, 10000]);
});

test('el presupuesto global se comparte entre llamadas distintas', async () => {
  const budget = createSyncRetryBudget(1500);
  const first = deterministicDeps({
    fetchFn: sequenceFetch([fakeResponse(429, {}, '1'), fakeResponse(200)]),
    retryBudget: budget,
  });
  const second = deterministicDeps({
    fetchFn: sequenceFetch([fakeResponse(429, {}, '1'), fakeResponse(200)]),
    retryBudget: budget,
  });
  await mlGet(URL_WITH_SECRETS, 'token', first.deps);
  await mlGet(URL_WITH_SECRETS, 'token', second.deps);
  assert.deepEqual(first.waits, [1000]);
  assert.deepEqual(second.waits, [500]);
  assert.equal(budget.remainingMs, 0);
});

test('reintentos que luego tienen éxito consumen presupuesto global', async () => {
  const budget = createSyncRetryBudget(5000);
  const { deps, waits } = deterministicDeps({
    fetchFn: sequenceFetch([
      fakeResponse(500, {}, '1'),
      fakeResponse(503, {}, '2'),
      fakeResponse(200),
    ]),
    retryBudget: budget,
  });
  await mlGet(URL_WITH_SECRETS, 'token', deps);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(budget.remainingMs, 2000);
});

test('la última espera queda recortada al presupuesto global restante', async () => {
  const budget = createSyncRetryBudget(750);
  const { deps, waits } = deterministicDeps({
    fetchFn: sequenceFetch([fakeResponse(429, {}, '30'), fakeResponse(200)]),
    retryBudget: budget,
  });
  await mlGet(URL_WITH_SECRETS, 'token', deps);
  assert.deepEqual(waits, [750]);
  assert.equal(budget.remainingMs, 0);
});

test('con presupuesto global agotado no llama a sleep', async () => {
  const budget = createSyncRetryBudget(0);
  const { deps, waits } = deterministicDeps({
    fetchFn: sequenceFetch([fakeResponse(429)]),
    retryBudget: budget,
  });
  await assert.rejects(
    mlGet(URL_WITH_SECRETS, 'token', deps),
    /presupuesto de espera global del sync agotado/i,
  );
  assert.deepEqual(waits, []);
});

test('Retry-After superior al presupuesto por request queda recortado', async () => {
  const { deps, waits } = deterministicDeps({
    fetchFn: sequenceFetch([fakeResponse(429, {}, '30'), fakeResponse(200)]),
    maxCumulativeWaitMs: 500,
  });
  await mlGet(URL_WITH_SECRETS, 'token', deps);
  assert.deepEqual(waits, [500]);
});

test('errores y logs no exponen access_token, scroll_id ni query', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(String(message));
  try {
    const { deps } = deterministicDeps({
      fetchFn: sequenceFetch([fakeResponse(429), fakeResponse(403)]),
    });
    const error = await mlGet(URL_WITH_SECRETS, 'token', deps).catch(value => value);
    const output = `${error.message}\n${warnings.join('\n')}`;
    assert.equal(output.includes('TOKEN-SECRETO'), false);
    assert.equal(output.includes('SCROLL-SECRETO'), false);
    assert.equal(output.includes('?'), false);
    assert.equal(sanitizeEndpoint(URL_WITH_SECRETS), 'https://api.mercadolibre.com/items/search');
  } finally {
    console.warn = originalWarn;
  }
});
