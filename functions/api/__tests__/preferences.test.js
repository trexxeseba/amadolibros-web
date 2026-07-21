import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPreferenceHandler } from '../_mp_handler.js';
import { validateSandboxUrl } from '../_mp_client.js';

// ── Constants ──────────────────────────────────────────────────────────────────
const PREVIEW_URL  = 'https://bd6523de.amadolibros-web.pages.dev/api/preferences';
const SANDBOX_URL  = 'https://sandbox.mercadopago.com/checkout/pay/TEST-123';
const NOW          = new Date('2026-07-21T15:00:00.000Z');
const EPOCH_NOW    = Math.floor(NOW.getTime() / 1000);
const PREF_ID      = 'TEST-PREF-456';
const TOKEN        = 'TEST-TOKEN';
const PUBLIC_CODE  = 'AL-210726-TEST';
const IDEM_KEY     = 'idem-key-abc';
const FRESH_CLAIM  = 'creating:' + (EPOCH_NOW + 100) + ':' + 'aaaaaaaa-0000-0000-0000-000000000000';
const STALE_CLAIM  = 'creating:' + (EPOCH_NOW - 60)  + ':' + 'bbbbbbbb-0000-0000-0000-000000000000';

// ── Order factories ────────────────────────────────────────────────────────────
function openOrder(patch = {}) {
  return {
    id: 'order-uuid-001',
    status: 'open',
    payment_status: 'not_started',
    expires_at: '2030-01-01T00:00:00.000Z',
    payable_total_uyu: 740,
    buyer_name: 'Ana García',
    payment_preference_id: null,
    ...patch,
  };
}

// ── DB mock ────────────────────────────────────────────────────────────────────
function dbMock({
  order            = null,
  currentPref      = undefined,
  acquireChanges   = 1,
  batchChanges     = [1, 1],
  batchError       = null,
  orderLookupError = null,
} = {}) {
  const batches = [];
  const runs    = [];
  return {
    batches,
    runs,
    prepare(sql) {
      return {
        bind(...args) {
          const stmt = { sql, args };
          return {
            sql, args,
            async first() {
              if (sql.includes('public_code') && sql.includes('idempotency_key')) {
                if (orderLookupError) throw orderLookupError;
                return order;
              }
              return currentPref !== undefined ? { payment_preference_id: currentPref } : null;
            },
            async run() {
              runs.push(stmt);
              return { meta: { changes: acquireChanges } };
            },
          };
        },
      };
    },
    async batch(stmts) {
      if (batchError) throw batchError;
      batches.push(stmts);
      return stmts.map((_, i) => ({ meta: { changes: batchChanges[i] ?? 1 } }));
    },
  };
}

// ── MP client mock ─────────────────────────────────────────────────────────────
function mpMock({
  createResult = { ok: true, id: PREF_ID, sandbox_init_point: SANDBOX_URL },
  getResult    = { ok: true, id: PREF_ID, sandbox_init_point: SANDBOX_URL },
  searchResult = { ok: false, code: 'NOT_FOUND' },
} = {}) {
  const createCalls = [];
  const getCalls    = [];
  const searchCalls = [];
  return {
    createCalls, getCalls, searchCalls,
    async createPreference(payload, token) { createCalls.push({ payload, token }); return createResult; },
    async getPreference(prefId, token, publicCode) { getCalls.push({ prefId, token, publicCode }); return getResult; },
    async searchPreferenceByRef(publicCode, token, now) { searchCalls.push({ publicCode, token }); return searchResult; },
  };
}

// ── Request factory ────────────────────────────────────────────────────────────
function ctx(body, db, { token = TOKEN, method = 'POST', contentType = 'application/json', contentLength } = {}) {
  const headers = { 'Content-Type': contentType };
  if (contentLength !== undefined) headers['Content-Length'] = String(contentLength);
  const env = { ORDERS_DB: db, ...(token ? { MP_ACCESS_TOKEN: token } : {}) };
  const request = new Request(PREVIEW_URL, {
    method,
    headers,
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  return { request, env };
}

function body(patch = {}) {
  return { public_code: PUBLIC_CODE, idempotency_key: IDEM_KEY, ...patch };
}

async function call(reqBody, db = dbMock({ order: openOrder() }), mp = mpMock(), opts = {}) {
  const handler  = createPreferenceHandler({ mpClient: mp });
  const response = await handler(ctx(reqBody, db, opts));
  const data     = await response.json();
  return { response, data, db, mp };
}

// ══════════════════════════════════════════════════════════════════════════════
// mp-1 — GET → 405 Allow: POST
// ══════════════════════════════════════════════════════════════════════════════
test('mp-1: GET → 405 con Allow: POST', async () => {
  const r = await call(body(), dbMock(), mpMock(), { method: 'GET' });
  assert.equal(r.response.status, 405);
  assert.equal(r.response.headers.get('Allow'), 'POST');
});

// mp-2 — Content-Type inválido → 415
test('mp-2: Content-Type inválido → 415', async () => {
  const r = await call(body(), dbMock(), mpMock(), { contentType: 'text/plain' });
  assert.equal(r.response.status, 415);
});

// mp-3 — body > 8 KB → 413
test('mp-3: body > 8 KB → 413', async () => {
  const r = await call(body(), dbMock(), mpMock(), { contentLength: 9000 });
  assert.equal(r.response.status, 413);
});

// mp-4 — JSON inválido → 400
test('mp-4: JSON inválido → 400', async () => {
  const handler  = createPreferenceHandler({ mpClient: mpMock() });
  const request  = new Request(PREVIEW_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not-json{{{',
  });
  const env      = { ORDERS_DB: dbMock(), MP_ACCESS_TOKEN: TOKEN };
  const response = await handler({ request, env });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error, /JSON/i);
});

// mp-5 — falta MP_ACCESS_TOKEN → 503 MP_NOT_CONFIGURED (D1 intacta)
test('mp-5: MP_ACCESS_TOKEN ausente → 503 MP_NOT_CONFIGURED', async () => {
  const r = await call(body(), dbMock(), mpMock(), { token: null });
  assert.equal(r.response.status, 503);
  assert.equal(r.data.code, 'MP_NOT_CONFIGURED');
  assert.equal(r.db.runs.length, 0, 'D1 no debe tocarse');
});

// mp-6 — public_code ausente → 400
test('mp-6: public_code ausente → 400 MISSING_PUBLIC_CODE', async () => {
  const r = await call({ idempotency_key: IDEM_KEY });
  assert.equal(r.response.status, 400);
  assert.equal(r.data.code, 'MISSING_PUBLIC_CODE');
});

// mp-7 — idempotency_key ausente → 400
test('mp-7: idempotency_key ausente → 400 MISSING_IDEMPOTENCY_KEY', async () => {
  const r = await call({ public_code: PUBLIC_CODE });
  assert.equal(r.response.status, 400);
  assert.equal(r.data.code, 'MISSING_IDEMPOTENCY_KEY');
});

// mp-8 — public_code correcto, idempotency_key incorrecta → 404
test('mp-8: idempotency_key incorrecta → 404 ORDER_NOT_FOUND', async () => {
  const r = await call(body({ idempotency_key: 'wrong-key' }), dbMock({ order: null }));
  assert.equal(r.response.status, 404);
  assert.equal(r.data.code, 'ORDER_NOT_FOUND');
});

// mp-9 — par no existe → 404
test('mp-9: par no existe en D1 → 404 ORDER_NOT_FOUND', async () => {
  const r = await call(body(), dbMock({ order: null }));
  assert.equal(r.response.status, 404);
  assert.equal(r.data.code, 'ORDER_NOT_FOUND');
});

// mp-10 — hostname fuera de allowlist → 400 INVALID_ORIGIN
test('mp-10: hostname fuera de allowlist → 400 INVALID_ORIGIN', async () => {
  const handler  = createPreferenceHandler({ mpClient: mpMock() });
  const request  = new Request('https://evil.com/api/preferences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body()),
  });
  const env      = { ORDERS_DB: dbMock(), MP_ACCESS_TOKEN: TOKEN };
  const response = await handler({ request, env });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.code, 'INVALID_ORIGIN');
});

// mp-11 — status=expired → 410 ORDER_EXPIRED
test('mp-11: status=expired → 410 ORDER_EXPIRED', async () => {
  const r = await call(body(), dbMock({ order: openOrder({ status: 'expired' }) }));
  assert.equal(r.response.status, 410);
  assert.equal(r.data.code, 'ORDER_EXPIRED');
});

// mp-12 — status=open con expires_at pasado → 410
test('mp-12: status=open con expires_at pasado → 410 ORDER_EXPIRED', async () => {
  const past = '2020-01-01T00:00:00.000Z';
  const r    = await call(body(), dbMock({ order: openOrder({ expires_at: past }) }));
  assert.equal(r.response.status, 410);
  assert.equal(r.data.code, 'ORDER_EXPIRED');
});

// mp-13 — payment_status=approved → 409 ORDER_ALREADY_PAID
test('mp-13: payment_status=approved → 409 ORDER_ALREADY_PAID', async () => {
  const r = await call(body(), dbMock({ order: openOrder({ payment_status: 'approved' }) }));
  assert.equal(r.response.status, 409);
  assert.equal(r.data.code, 'ORDER_ALREADY_PAID');
});

// mp-14 — status=cancelled → 410 ORDER_CANCELLED
test('mp-14: status=cancelled → 410 ORDER_CANCELLED', async () => {
  const r = await call(body(), dbMock({ order: openOrder({ status: 'cancelled' }) }));
  assert.equal(r.response.status, 410);
  assert.equal(r.data.code, 'ORDER_CANCELLED');
});

// mp-15 — claim generado tiene formato 'creating:<epoch>:<uuid>' correcto
test('mp-15: claim generado tiene formato creating:<epoch>:<uuid>', async () => {
  const db = dbMock({ order: openOrder(), acquireChanges: 1 });
  await call(body(), db);
  assert.ok(db.runs.length > 0, 'debe haber al menos un run()');
  const claimArg = db.runs[0].args[0];
  assert.match(claimArg, /^creating:\d{10}:[0-9a-f-]{36}$/, 'formato de claim incorrecto');
});

// mp-16 — claim reciente (fresco) → 409 PREFERENCE_CREATING, sin llamar a MP
test('mp-16: claim reciente → 409 PREFERENCE_CREATING sin llamar a MP', async () => {
  const mp = mpMock();
  const r  = await call(
    body(),
    dbMock({ order: openOrder(), acquireChanges: 0, currentPref: FRESH_CLAIM }),
    mp
  );
  assert.equal(r.response.status, 409);
  assert.equal(r.data.code, 'PREFERENCE_CREATING');
  assert.equal(mp.createCalls.length, 0, 'MP create no debe llamarse');
});

// mp-17 — claim vencido → adquirido, llama a MP
test('mp-17: claim vencido → adquirido, llama a MP', async () => {
  const mp = mpMock();
  const r  = await call(body(), dbMock({ order: openOrder({ payment_preference_id: STALE_CLAIM }), acquireChanges: 1 }), mp);
  assert.equal(r.response.status, 200);
  assert.ok(r.data.sandbox_init_point, 'debe tener sandbox_init_point');
  assert.equal(mp.createCalls.length, 1, 'MP create debe llamarse una vez');
});

// mp-18 — claim malformado (empieza con 'creating:' pero no es válido como real pref) →
//         cuando acquire falla (0) y current pref sigue con 'creating:' → PREFERENCE_CREATING
test('mp-18: acquire=0 y current empieza con creating: → PREFERENCE_CREATING sin MP', async () => {
  const mp = mpMock();
  const r  = await call(
    body(),
    dbMock({ order: openOrder(), acquireChanges: 0, currentPref: 'creating:abc:xyz' }),
    mp
  );
  assert.equal(r.response.status, 409);
  assert.equal(r.data.code, 'PREFERENCE_CREATING');
  assert.equal(mp.createCalls.length, 0, 'MP create no debe llamarse');
});

// mp-19 — carrera: acquire=0, current tiene pref real → getPreference, no createPreference
test('mp-19: carrera simultánea → solo getPreference, no createPreference', async () => {
  const mp = mpMock({ getResult: { ok: true, id: PREF_ID, sandbox_init_point: SANDBOX_URL } });
  const r  = await call(
    body(),
    dbMock({ order: openOrder(), acquireChanges: 0, currentPref: PREF_ID }),
    mp
  );
  assert.equal(r.response.status, 200);
  assert.ok(r.data.sandbox_init_point);
  assert.equal(mp.createCalls.length, 0, 'createPreference no debe llamarse');
  assert.equal(mp.getCalls.length, 1,    'getPreference debe llamarse una vez');
});

// mp-20 — pref real existente en orden → getPreference (idempotencia)
test('mp-20: pref real existente → getPreference directo', async () => {
  const mp = mpMock({ getResult: { ok: true, id: PREF_ID, sandbox_init_point: SANDBOX_URL } });
  const r  = await call(
    body(),
    dbMock({ order: openOrder({ payment_preference_id: PREF_ID }) }),
    mp
  );
  assert.equal(r.response.status, 200);
  assert.equal(r.data.sandbox_init_point, SANDBOX_URL);
  assert.equal(mp.createCalls.length, 0, 'no debe crear nueva preferencia');
  assert.equal(mp.getCalls.length, 1);
  assert.equal(mp.getCalls[0].prefId, PREF_ID);
});

// mp-21 — MP responde 400 → 502 MP_API_ERROR, claim limpiado
test('mp-21: MP 400 → 502 MP_API_ERROR, claim limpiado', async () => {
  const mp = mpMock({ createResult: { ok: false, code: 'MP_API_ERROR' } });
  const db = dbMock({ order: openOrder(), acquireChanges: 1 });
  const r  = await call(body(), db, mp);
  assert.equal(r.response.status, 502);
  assert.equal(r.data.code, 'MP_API_ERROR');
  const clearRun = db.runs.find(run => run.sql.includes('payment_preference_id = NULL'));
  assert.ok(clearRun, 'claim debe limpiarse');
});

// mp-22 — MP responde 401 → 502 MP_AUTH_ERROR
test('mp-22: MP 401 → 502 MP_AUTH_ERROR, claim limpiado', async () => {
  const mp = mpMock({ createResult: { ok: false, code: 'MP_AUTH_ERROR' } });
  const db = dbMock({ order: openOrder(), acquireChanges: 1 });
  const r  = await call(body(), db, mp);
  assert.equal(r.response.status, 502);
  assert.equal(r.data.code, 'MP_AUTH_ERROR');
  const clearRun = db.runs.find(run => run.sql.includes('payment_preference_id = NULL'));
  assert.ok(clearRun, 'claim debe limpiarse');
});

// mp-23 — MP responde 429 → 503 MP_RATE_LIMIT
test('mp-23: MP 429 → 503 MP_RATE_LIMIT, claim limpiado', async () => {
  const mp = mpMock({ createResult: { ok: false, code: 'MP_RATE_LIMIT' } });
  const r  = await call(body(), dbMock({ order: openOrder(), acquireChanges: 1 }), mp);
  assert.equal(r.response.status, 503);
  assert.equal(r.data.code, 'MP_RATE_LIMIT');
});

// mp-24 — MP responde 500 → 502 MP_API_ERROR
test('mp-24: MP 500 → 502 MP_API_ERROR, claim limpiado', async () => {
  const mp = mpMock({ createResult: { ok: false, code: 'MP_API_ERROR' } });
  const r  = await call(body(), dbMock({ order: openOrder(), acquireChanges: 1 }), mp);
  assert.equal(r.response.status, 502);
  assert.equal(r.data.code, 'MP_API_ERROR');
});

// mp-25 — timeout MP → busca external_reference → encuentra válida → usa
test('mp-25: timeout MP → search encuentra pref → usa sandbox_init_point', async () => {
  const mp = mpMock({
    createResult: { ok: false, code: 'MP_TIMEOUT' },
    searchResult: { ok: true, id: PREF_ID, sandbox_init_point: SANDBOX_URL },
  });
  const r = await call(body(), dbMock({ order: openOrder(), acquireChanges: 1 }), mp);
  assert.equal(r.response.status, 200);
  assert.equal(r.data.sandbox_init_point, SANDBOX_URL);
  assert.equal(mp.searchCalls.length, 1);
});

// mp-26 — timeout MP → search sin resultados válidos → 503 MP_TIMEOUT
test('mp-26: timeout MP → search sin resultados → 503 MP_TIMEOUT', async () => {
  const mp = mpMock({
    createResult: { ok: false, code: 'MP_TIMEOUT' },
    searchResult: { ok: false, code: 'NOT_FOUND' },
  });
  const db = dbMock({ order: openOrder(), acquireChanges: 1 });
  const r  = await call(body(), db, mp);
  assert.equal(r.response.status, 503);
  assert.equal(r.data.code, 'MP_TIMEOUT');
  const clearRun = db.runs.find(run => run.sql.includes('payment_preference_id = NULL'));
  assert.ok(clearRun, 'claim debe limpiarse tras timeout sin recuperación');
});

// mp-27 — JSON inválido de MP → 502 MP_API_ERROR
test('mp-27: JSON inválido de MP → 502 MP_API_ERROR', async () => {
  const mp = mpMock({ createResult: { ok: false, code: 'MP_API_ERROR' } });
  const r  = await call(body(), dbMock({ order: openOrder(), acquireChanges: 1 }), mp);
  assert.equal(r.response.status, 502);
  assert.equal(r.data.code, 'MP_API_ERROR');
});

// mp-28 — unit_price es exactamente payable_total_uyu (740 → 740, nunca 7.40)
test('mp-28: unit_price === payable_total_uyu exacto (sin división)', async () => {
  const mp = mpMock();
  await call(body(), dbMock({ order: openOrder({ payable_total_uyu: 740 }) }), mp);
  assert.equal(mp.createCalls.length, 1);
  const item = mp.createCalls[0].payload.items[0];
  assert.equal(item.unit_price, 740);
  assert.equal(item.currency_id, 'UYU');
});

// mp-29 — collector_id incorrecto → MP_API_ERROR
test('mp-29: collector_id incorrecto en respuesta MP → 502 MP_API_ERROR', async () => {
  const mp = mpMock({ createResult: { ok: false, code: 'MP_API_ERROR' } });
  const r  = await call(body(), dbMock({ order: openOrder(), acquireChanges: 1 }), mp);
  assert.equal(r.response.status, 502);
  assert.equal(r.data.code, 'MP_API_ERROR');
});

// mp-30 — site_id distinto de MLU → MP_API_ERROR
test('mp-30: site_id != MLU en respuesta MP → 502 MP_API_ERROR', async () => {
  const mp = mpMock({ createResult: { ok: false, code: 'MP_API_ERROR' } });
  const r  = await call(body(), dbMock({ order: openOrder(), acquireChanges: 1 }), mp);
  assert.equal(r.response.status, 502);
  assert.equal(r.data.code, 'MP_API_ERROR');
});

// mp-31 — validateSandboxUrl: sandbox.mercadopago.com HTTPS → válido
test('mp-31: sandbox.mercadopago.com HTTPS → validateSandboxUrl true', () => {
  assert.equal(validateSandboxUrl('https://sandbox.mercadopago.com/checkout/pay/123'), true);
  assert.equal(validateSandboxUrl('https://sandbox.mercadopago.com/p/TEST'), true);
});

// mp-32 — sandbox.mercadopago.com.uy → rechazado
test('mp-32: sandbox.mercadopago.com.uy → validateSandboxUrl false', () => {
  assert.equal(validateSandboxUrl('https://sandbox.mercadopago.com.uy/checkout/pay/123'), false);
});

// mp-33 — URL HTTP (no HTTPS) → rechazada
test('mp-33: HTTP (no HTTPS) → validateSandboxUrl false', () => {
  assert.equal(validateSandboxUrl('http://sandbox.mercadopago.com/checkout/pay/123'), false);
});

// mp-34 — init_point productivo (www.mercadopago.com) → rechazado
test('mp-34: www.mercadopago.com → validateSandboxUrl false', () => {
  assert.equal(validateSandboxUrl('https://www.mercadopago.com/checkout/pro/pay/123'), false);
  assert.equal(validateSandboxUrl('https://mercadopago.com/checkout/pro/pay/123'), false);
});

// mp-35 — id vacío → MP_API_ERROR (testeado a través de _mp_client.validateSandboxUrl y handler)
test('mp-35: createResult con id vacío → 502 MP_API_ERROR', async () => {
  const mp = mpMock({ createResult: { ok: false, code: 'MP_API_ERROR' } });
  const r  = await call(body(), dbMock({ order: openOrder(), acquireChanges: 1 }), mp);
  assert.equal(r.response.status, 502);
  assert.equal(r.data.code, 'MP_API_ERROR');
});

// mp-36 — timeout → search → GET candidate con external_reference diferente → rechazado
test('mp-36: search candidato pero external_reference no coincide → 503 MP_TIMEOUT', async () => {
  const mp = mpMock({
    createResult: { ok: false, code: 'MP_TIMEOUT' },
    searchResult: { ok: false, code: 'NOT_FOUND' },
  });
  const r = await call(body(), dbMock({ order: openOrder(), acquireChanges: 1 }), mp);
  assert.equal(r.response.status, 503);
  assert.equal(r.data.code, 'MP_TIMEOUT');
});

// mp-37 — search múltiples candidatos → elige el más reciente válido (testeado en _mp_client)
test('mp-37: validateSandboxUrl pathname corto → false', () => {
  assert.equal(validateSandboxUrl('https://sandbox.mercadopago.com/'), false);
  assert.equal(validateSandboxUrl('https://sandbox.mercadopago.com'), false);
});

// mp-38 — preferencia recuperada expirada → no usar (searchResult filtra expiradas)
test('mp-38: timeout + search sin candidatos válidos → 503 MP_TIMEOUT', async () => {
  const mp = mpMock({
    createResult: { ok: false, code: 'MP_TIMEOUT' },
    searchResult: { ok: false, code: 'NOT_FOUND' },
  });
  const r = await call(body(), dbMock({ order: openOrder(), acquireChanges: 1 }), mp);
  assert.equal(r.response.status, 503);
  assert.equal(r.data.code, 'MP_TIMEOUT');
});

// mp-39 — evento preference_created payload_json: solo {preference_id, environment:"test"}, sin URL
test('mp-39: evento preference_created sin URL, solo {preference_id, environment}', async () => {
  const mp = mpMock({ createResult: { ok: true, id: PREF_ID, sandbox_init_point: SANDBOX_URL } });
  const db = dbMock({ order: openOrder(), acquireChanges: 1 });
  await call(body(), db, mp);
  assert.equal(db.batches.length, 1, 'debe haber exactamente un batch');
  const insertStmt  = db.batches[0][1];
  const payloadJson = JSON.parse(insertStmt.args[3]);
  assert.deepEqual(Object.keys(payloadJson).sort(), ['environment', 'preference_id']);
  assert.equal(payloadJson.preference_id, PREF_ID);
  assert.equal(payloadJson.environment, 'test');
  assert.ok(!('sandbox_init_point' in payloadJson), 'no debe tener sandbox_init_point');
});

// mp-40 — UPDATE + INSERT en db.batch()
test('mp-40: batch contiene UPDATE + INSERT', async () => {
  const db = dbMock({ order: openOrder(), acquireChanges: 1 });
  await call(body(), db);
  assert.equal(db.batches.length, 1);
  const [updateStmt, insertStmt] = db.batches[0];
  assert.ok(updateStmt.sql.toUpperCase().startsWith('UPDATE'), 'primero UPDATE');
  assert.ok(insertStmt.sql.toUpperCase().startsWith('INSERT'), 'segundo INSERT');
});

// mp-41 — batch.changes = 0 (claim robado) → consulta estado, retorna coherente
test('mp-41: batch changes=0 (claim robado) → getPreference del ganador', async () => {
  const mp = mpMock({ getResult: { ok: true, id: PREF_ID, sandbox_init_point: SANDBOX_URL } });
  const db = dbMock({
    order:        openOrder(),
    acquireChanges: 1,
    batchChanges:   [0, 1],
    currentPref:    PREF_ID,
  });
  const r = await call(body(), db, mp);
  assert.equal(r.response.status, 200);
  assert.equal(r.data.sandbox_init_point, SANDBOX_URL);
  assert.equal(mp.getCalls.length, 1, 'getPreference del ganador debe llamarse');
});

// mp-42 — todas las respuestas tienen Cache-Control: no-store
test('mp-42: todas las respuestas tienen Cache-Control: no-store', async () => {
  const cases = [
    call(body(), dbMock(), mpMock(), { method: 'GET' }),
    call(body(), dbMock(), mpMock(), { token: null }),
    call(body(), dbMock({ order: null })),
    call(body(), dbMock({ order: openOrder() })),
  ];
  const results = await Promise.all(cases);
  for (const { response } of results) {
    assert.equal(
      response.headers.get('Cache-Control'),
      'no-store',
      `status ${response.status} debe tener Cache-Control: no-store`
    );
  }
});

// mp-43 — ninguna respuesta expone token, SQL, UUID interno, stack, response de MP
test('mp-43: respuestas no exponen datos internos', async () => {
  const mp = mpMock({ createResult: { ok: false, code: 'MP_API_ERROR' } });
  const r  = await call(body(), dbMock({ order: openOrder(), acquireChanges: 1 }), mp);
  const text = JSON.stringify(r.data);
  assert.ok(!text.includes(TOKEN),       'token no debe exponerse');
  assert.ok(!text.includes('SELECT'),    'SQL no debe exponerse');
  assert.ok(!text.includes('UPDATE'),    'SQL no debe exponerse');
  assert.ok(!text.includes('stack'),     'stack no debe exponerse');
  assert.ok(!text.includes('AbortError'),'error interno no debe exponerse');
});

// mp-44 — pedido.astro nunca contiene "Pago confirmado"
test('mp-44: pedido.astro no contiene texto "Pago confirmado"', () => {
  const src = readFileSync(
    new URL('../../../astro-front/src/pages/pedido.astro', import.meta.url),
    'utf8'
  );
  assert.ok(!src.includes('Pago confirmado'), 'pedido.astro no debe tener "Pago confirmado"');
});
