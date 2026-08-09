import fs from 'node:fs';

function replaceOnce(source, from, to, label) {
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: esperado 1 match, encontrados ${count}`);
  return source.replace(from, to);
}

// ---------------------------------------------------------------------------
// worker-sync/meli-catalog.js
// ---------------------------------------------------------------------------
{
  const file = 'worker-sync/meli-catalog.js';
  let s = fs.readFileSync(file, 'utf8');

  const constantsAnchor = `const ML_TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);\n`;
  const constantsReplacement = `${constantsAnchor}
export function createMlRetryTelemetry() {
  return {
    schema_version: 1,
    transient_count: 0,
    rate_limit_429_count: 0,
    rate_limit_by_phase: { scan: 0, details: 0, unknown: 0 },
    max_retry_after_ms: null,
    max_applied_delay_ms: 0,
    last_event: null,
  };
}

function normalizedRetryContext(requestContext = {}) {
  const phase = ['scan', 'details'].includes(requestContext?.phase)
    ? requestContext.phase
    : 'unknown';
  const catalogStatus = ['active', 'paused'].includes(requestContext?.catalog_status)
    ? requestContext.catalog_status
    : null;
  const positiveInt = value => Number.isInteger(value) && value > 0 ? value : null;
  return {
    phase,
    catalog_status: catalogStatus,
    page: positiveInt(requestContext?.page),
    batch: positiveInt(requestContext?.batch),
    total_batches: positiveInt(requestContext?.total_batches),
    endpoint_kind: ['items_search', 'items_details'].includes(requestContext?.endpoint_kind)
      ? requestContext.endpoint_kind
      : 'other',
  };
}

function recordRetryTelemetry(telemetry, event) {
  if (!telemetry || typeof telemetry !== 'object') return;
  const ctx = normalizedRetryContext(event.requestContext);
  telemetry.transient_count = (Number(telemetry.transient_count) || 0) + 1;
  if (event.status === 429) {
    telemetry.rate_limit_429_count = (Number(telemetry.rate_limit_429_count) || 0) + 1;
    telemetry.rate_limit_by_phase ||= { scan: 0, details: 0, unknown: 0 };
    telemetry.rate_limit_by_phase[ctx.phase] = (Number(telemetry.rate_limit_by_phase[ctx.phase]) || 0) + 1;
  }
  if (Number.isFinite(event.retryAfterMs)) {
    telemetry.max_retry_after_ms = Math.max(Number(telemetry.max_retry_after_ms) || 0, event.retryAfterMs);
  }
  if (Number.isFinite(event.appliedDelayMs)) {
    telemetry.max_applied_delay_ms = Math.max(Number(telemetry.max_applied_delay_ms) || 0, event.appliedDelayMs);
  }
  telemetry.last_event = {
    status: event.status,
    phase: ctx.phase,
    catalog_status: ctx.catalog_status,
    page: ctx.page,
    batch: ctx.batch,
    total_batches: ctx.total_batches,
    endpoint_kind: ctx.endpoint_kind,
    attempt: event.attempt,
    will_retry: Boolean(event.willRetry),
    stop_reason: event.stopReason || null,
    retry_after_ms: Number.isFinite(event.retryAfterMs) ? event.retryAfterMs : null,
    applied_delay_ms: Number.isFinite(event.appliedDelayMs) ? event.appliedDelayMs : null,
  };
}
`;
  s = replaceOnce(s, constantsAnchor, constantsReplacement, 'telemetry helpers');

  s = replaceOnce(
    s,
    `  mlGetDeps = {},\n} = {}) {`,
    `  mlGetDeps = {},\n  telemetry = createMlRetryTelemetry(),\n} = {}) {`,
    'buildCatalog telemetry option',
  );

  s = replaceOnce(
    s,
    `    retryBudget,\n    mlGetDeps,\n  );`,
    `    retryBudget,\n    mlGetDeps,\n    telemetry,\n  );`,
    'fetchAllIds telemetry arg',
  );

  s = replaceOnce(
    s,
    `  const rawItems = await fetchDetails(allIds, accessToken, retryBudget, mlGetDeps);`,
    `  const rawItems = await fetchDetails(allIds, accessToken, retryBudget, mlGetDeps, telemetry);`,
    'fetchDetails telemetry arg',
  );

  s = replaceOnce(
    s,
    `  retryBudget,\n  mlGetDeps = {},\n) {`,
    `  retryBudget,\n  mlGetDeps = {},\n  telemetry = null,\n) {`,
    'fetchAllIds signature',
  );

  s = replaceOnce(
    s,
    `      const data = await mlGet(url, accessToken, { ...mlGetDeps, retryBudget });`,
    `      const data = await mlGet(url, accessToken, {\n        ...mlGetDeps,\n        retryBudget,\n        telemetry,\n        requestContext: {\n          phase: 'scan',\n          catalog_status: status,\n          page,\n          endpoint_kind: 'items_search',\n        },\n      });`,
    'scan context',
  );

  s = replaceOnce(
    s,
    `async function fetchDetails(ids, accessToken, retryBudget, mlGetDeps = {}) {`,
    `async function fetchDetails(ids, accessToken, retryBudget, mlGetDeps = {}, telemetry = null) {`,
    'fetchDetails signature',
  );

  s = replaceOnce(
    s,
    `      const data = await mlGet(url, accessToken, { ...mlGetDeps, retryBudget });`,
    `      const data = await mlGet(url, accessToken, {\n        ...mlGetDeps,\n        retryBudget,\n        telemetry,\n        requestContext: {\n          phase: 'details',\n          batch: batchNum,\n          total_batches: totalBatches,\n          endpoint_kind: 'items_details',\n        },\n      });`,
    'details context',
  );

  s = replaceOnce(
    s,
    `  maxCumulativeWaitMs = ML_MAX_CUMULATIVE_WAIT_MS,\n} = {}) {`,
    `  maxCumulativeWaitMs = ML_MAX_CUMULATIVE_WAIT_MS,\n  telemetry = null,\n  requestContext = null,\n} = {}) {`,
    'mlGet telemetry options',
  );

  const oldTransient = `    if (attempt >= maxRetries) {
      throw new Error(
        \`[Catalog] Agotados ${'${maxRetries}'} reintentos tras HTTP ${'${resp.status}'} en ${'${endpoint}'}\`
      );
    }

    const requestRemainingMs = maxCumulativeWaitMs - cumulativeWaitMs;
    if (requestRemainingMs <= 0) throw retryBudgetError('request', endpoint);

    const globalRemainingMs = retryBudget == null
      ? Number.POSITIVE_INFINITY
      : Number(retryBudget.remainingMs);
    if (globalRemainingMs <= 0) throw retryBudgetError('global', endpoint);

    const retryAfterMs = parseRetryAfterMs(resp.headers?.get?.('Retry-After'), {
      nowMs: now(),
      maxBackoffMs,
    });
    const calculatedDelayMs = retryAfterMs ?? computeBackoffMs(attempt, {
      random,
      baseBackoffMs,
      maxBackoffMs,
    });
    const delayMs = Math.max(0, Math.floor(Math.min(
      calculatedDelayMs,
      maxBackoffMs,
      requestRemainingMs,
      globalRemainingMs,
    )));

    console.warn(
      \`[Catalog] HTTP ${'${resp.status}'} transitorio en ${'${endpoint}'}. \` +
      \`Reintento ${'${attempt + 1}'}/${'${maxRetries}'} en ${'${delayMs}'}ms.\`
    );`;

  const newTransient = `    // Observamos el Retry-After anunciado sin alterar la política vigente:
    // mlGet sigue aplicando el cap maxBackoffMs (30 s por defecto). Guardamos
    // ambos valores para poder distinguir "ML pidió 60 s" de "esperamos 30 s".
    const retryAfterObservedMs = parseRetryAfterMs(resp.headers?.get?.('Retry-After'), {
      nowMs: now(),
      maxBackoffMs: Number.MAX_SAFE_INTEGER,
    });

    if (attempt >= maxRetries) {
      recordRetryTelemetry(telemetry, {
        status: resp.status,
        requestContext,
        attempt: attempt + 1,
        willRetry: false,
        stopReason: 'max_retries',
        retryAfterMs: retryAfterObservedMs,
        appliedDelayMs: null,
      });
      throw new Error(
        \`[Catalog] Agotados ${'${maxRetries}'} reintentos tras HTTP ${'${resp.status}'} en ${'${endpoint}'}\`
      );
    }

    const requestRemainingMs = maxCumulativeWaitMs - cumulativeWaitMs;
    if (requestRemainingMs <= 0) {
      recordRetryTelemetry(telemetry, {
        status: resp.status, requestContext, attempt: attempt + 1,
        willRetry: false, stopReason: 'request_budget',
        retryAfterMs: retryAfterObservedMs, appliedDelayMs: null,
      });
      throw retryBudgetError('request', endpoint);
    }

    const globalRemainingMs = retryBudget == null
      ? Number.POSITIVE_INFINITY
      : Number(retryBudget.remainingMs);
    if (globalRemainingMs <= 0) {
      recordRetryTelemetry(telemetry, {
        status: resp.status, requestContext, attempt: attempt + 1,
        willRetry: false, stopReason: 'global_budget',
        retryAfterMs: retryAfterObservedMs, appliedDelayMs: null,
      });
      throw retryBudgetError('global', endpoint);
    }

    const retryAfterAppliedMs = Number.isFinite(retryAfterObservedMs)
      ? Math.min(retryAfterObservedMs, maxBackoffMs)
      : null;
    const calculatedDelayMs = retryAfterAppliedMs ?? computeBackoffMs(attempt, {
      random,
      baseBackoffMs,
      maxBackoffMs,
    });
    const delayMs = Math.max(0, Math.floor(Math.min(
      calculatedDelayMs,
      maxBackoffMs,
      requestRemainingMs,
      globalRemainingMs,
    )));

    recordRetryTelemetry(telemetry, {
      status: resp.status,
      requestContext,
      attempt: attempt + 1,
      willRetry: true,
      stopReason: null,
      retryAfterMs: retryAfterObservedMs,
      appliedDelayMs: delayMs,
    });

    console.warn(
      \`[Catalog] HTTP ${'${resp.status}'} transitorio en ${'${endpoint}'}. \` +
      \`Reintento ${'${attempt + 1}'}/${'${maxRetries}'} en ${'${delayMs}'}ms.\`
    );`;
  s = replaceOnce(s, oldTransient, newTransient, 'mlGet transient block');

  fs.writeFileSync(file, s);
}

// ---------------------------------------------------------------------------
// worker-sync/index.js
// ---------------------------------------------------------------------------
{
  const file = 'worker-sync/index.js';
  let s = fs.readFileSync(file, 'utf8');

  s = replaceOnce(
    s,
    `import { buildCatalog   } from './meli-catalog.js';`,
    `import { buildCatalog, createMlRetryTelemetry } from './meli-catalog.js';`,
    'index import telemetry',
  );

  const runStart = `  const startedAt = new Date().toISOString();
  const source = options.source || 'unknown';`;
  const runReplacement = `  const startedAt = new Date().toISOString();
  const source = options.source || 'unknown';
  const mlRetryTelemetry = createMlRetryTelemetry();`;
  s = replaceOnce(s, runStart, runReplacement, 'runSync telemetry init');

  s = replaceOnce(
    s,
    `    const catalog = await buildCatalogFn(env, accessToken, { statuses: ['active'] });`,
    `    const catalog = await buildCatalogFn(env, accessToken, {\n      statuses: ['active'],\n      telemetry: mlRetryTelemetry,\n    });`,
    'runSync pass telemetry',
  );

  s = replaceOnce(
    s,
    `    await kvPut(env, 'sync:last_ok', finishedAt);\n    await kvDelete(env, 'sync:last_error');`,
    `    await kvPut(env, 'sync:last_ok', finishedAt);\n    await kvDelete(env, 'sync:last_error');\n    await kvDelete(env, 'sync:last_error_detail:v1');\n    await kvPut(env, 'sync:last_rate_limit:v1', JSON.stringify(rateLimitSummary(mlRetryTelemetry, finishedAt, source)));`,
    'success persist telemetry',
  );

  s = replaceOnce(
    s,
    `      duration_ms:    durationMs,\n    };`,
    `      duration_ms:    durationMs,\n      rate_limit:     rateLimitSummary(mlRetryTelemetry, finishedAt, source),\n    };`,
    'success result telemetry',
  );

  s = replaceOnce(
    s,
    `    const summary = \`${'${finishedAt}'} — ${'${err.message}'}\`.slice(0, 400);\n    await kvPut(env, 'sync:last_error', summary);`,
    `    const summary = \`${'${finishedAt}'} — ${'${err.message}'}\`.slice(0, 400);\n    const rateLimit = rateLimitSummary(mlRetryTelemetry, finishedAt, source);\n    const errorDetail = {\n      schema_version: 1,\n      finished_at: finishedAt,\n      source,\n      last_retry_event: mlRetryTelemetry.last_event || null,\n      rate_limit: rateLimit,\n    };\n    await kvPut(env, 'sync:last_error', summary);\n    await kvPut(env, 'sync:last_error_detail:v1', JSON.stringify(errorDetail));\n    await kvPut(env, 'sync:last_rate_limit:v1', JSON.stringify(rateLimit));`,
    'failure persist telemetry',
  );

  s = replaceOnce(
    s,
    `      duration_ms: durationMs,\n      error:       err.message,\n    };`,
    `      duration_ms: durationMs,\n      error:       err.message,\n      rate_limit:  rateLimitSummary(mlRetryTelemetry, finishedAt, source),\n    };`,
    'failure result telemetry',
  );

  const helperAnchor = `async function safeNotifyHealthcheck(notifyFn, env, kind) {`;
  const helper = `function rateLimitSummary(telemetry, finishedAt, source) {
  return {
    schema_version: 1,
    finished_at: finishedAt,
    source,
    transient_count: Number(telemetry?.transient_count) || 0,
    rate_limit_429_count: Number(telemetry?.rate_limit_429_count) || 0,
    rate_limit_by_phase: {
      scan: Number(telemetry?.rate_limit_by_phase?.scan) || 0,
      details: Number(telemetry?.rate_limit_by_phase?.details) || 0,
      unknown: Number(telemetry?.rate_limit_by_phase?.unknown) || 0,
    },
    max_retry_after_ms: Number.isFinite(telemetry?.max_retry_after_ms)
      ? telemetry.max_retry_after_ms
      : null,
    max_applied_delay_ms: Number(telemetry?.max_applied_delay_ms) || 0,
    last_event: telemetry?.last_event || null,
  };
}

${helperAnchor}`;
  s = replaceOnce(s, helperAnchor, helper, 'rateLimitSummary helper');

  fs.writeFileSync(file, s);
}

// ---------------------------------------------------------------------------
// worker-sync/__tests__/mlget-rate-limit.test.js
// ---------------------------------------------------------------------------
{
  const file = 'worker-sync/__tests__/mlget-rate-limit.test.js';
  let s = fs.readFileSync(file, 'utf8');
  s = replaceOnce(
    s,
    `  computeBackoffMs,\n  createSyncRetryBudget,`,
    `  computeBackoffMs,\n  createMlRetryTelemetry,\n  createSyncRetryBudget,`,
    'test import telemetry',
  );

  const afterCapTest = `test('Retry-After queda acotado a 30 segundos', () => {
  assert.equal(parseRetryAfterMs('120', { nowMs: 0 }), 30000);
});
`;
  const telemetryTests = `${afterCapTest}
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
`;
  s = replaceOnce(s, afterCapTest, telemetryTests, 'telemetry tests insert');
  fs.writeFileSync(file, s);
}

// ---------------------------------------------------------------------------
// worker-sync/__tests__/run-sync-no-partial-publish.test.js
// ---------------------------------------------------------------------------
{
  const file = 'worker-sync/__tests__/run-sync-no-partial-publish.test.js';
  let s = fs.readFileSync(file, 'utf8');

  s = replaceOnce(
    s,
    `  assert.equal(result.status, 'ok');\n  assert.deepEqual(receivedOptions, { statuses: ['active'] });`,
    `  assert.equal(result.status, 'ok');\n  assert.deepEqual(receivedOptions.statuses, ['active']);\n  assert.equal(receivedOptions.telemetry.schema_version, 1);\n  assert.equal(receivedOptions.telemetry.rate_limit_429_count, 0);`,
    'runSync options expectation',
  );

  s = replaceOnce(
    s,
    `  assert.ok(puts.some(entry => entry.key === 'sync:last_ok'));\n  assert.deepEqual(deletes, ['sync:last_error']);`,
    `  assert.ok(puts.some(entry => entry.key === 'sync:last_ok'));\n  assert.ok(puts.some(entry => entry.key === 'sync:last_rate_limit:v1'));\n  assert.deepEqual(deletes, ['sync:last_error', 'sync:last_error_detail:v1']);`,
    'success telemetry expectations',
  );

  const insertBefore = `test('si falla publishToR2 el resultado final conserva ese error', async () => {`;
  const newTest = `test('429 fatal en scan persiste fase, página y Retry-After sin guardar query ni scroll', async () => {
  const { env, puts } = fakeEnv();
  env.USER_ID = '123';
  env.MIN_ACTIVE_ITEMS = '1';
  const fetchFn = async () => ({
    ok: false,
    status: 429,
    headers: { get: name => name.toLowerCase() === 'retry-after' ? '60' : null },
    async json() { return {}; },
  });

  const result = await runSync(env, { source: 'manual-await' }, {
    getAccessTokenFn: async () => 'token',
    buildCatalogFn: (buildEnv, token, options) => buildCatalog(buildEnv, token, {
      ...options,
      mlGetDeps: {
        fetchFn,
        sleepFn: async () => {},
        random: () => 0,
        maxRetries: 1,
      },
    }),
    publishToR2Fn: async () => { throw new Error('no debe publicar'); },
    notifyHealthcheckFn: noHealthcheck,
  });

  assert.equal(result.status, 'error');
  const summaryEntry = puts.find(entry => entry.key === 'sync:last_rate_limit:v1');
  const detailEntry = puts.find(entry => entry.key === 'sync:last_error_detail:v1');
  assert.ok(summaryEntry);
  assert.ok(detailEntry);
  const summary = JSON.parse(summaryEntry.value);
  const detail = JSON.parse(detailEntry.value);
  assert.equal(summary.rate_limit_429_count, 2);
  assert.equal(summary.rate_limit_by_phase.scan, 2);
  assert.equal(summary.max_retry_after_ms, 60000);
  assert.equal(summary.max_applied_delay_ms, 30000);
  assert.equal(detail.last_retry_event.phase, 'scan');
  assert.equal(detail.last_retry_event.catalog_status, 'active');
  assert.equal(detail.last_retry_event.page, 1);
  assert.equal(detail.last_retry_event.status, 429);
  assert.equal(detail.last_retry_event.stop_reason, 'max_retries');
  const serialized = `${summaryEntry.value}${detailEntry.value}`;
  assert.equal(serialized.includes('scroll_id'), false);
  assert.equal(serialized.includes('?'), false);
});

${insertBefore}`;
  s = replaceOnce(s, insertBefore, newTest, 'runSync 429 persistence test');

  fs.writeFileSync(file, s);
}

console.log('OPS-SYNC-RATELIMIT-1 observability patch aplicado.');
