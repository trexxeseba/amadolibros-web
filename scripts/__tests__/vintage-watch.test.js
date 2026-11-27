import test from 'node:test';
import assert from 'node:assert/strict';
import { assess, checkVintageHeartbeat, notifyNtfy } from '../../functions/_shared/vintage-watch.js';

const NOW = new Date('2026-10-24T15:00:00.000Z');
const T = NOW.getTime();
const H = 3600_000, M = 60_000;
const LIMITS = { stallMs: 45 * M, warmupMs: 60 * M, supplierGraceMs: 240 * M };
const healthy = { lastAltaAt: T - 10 * M, feedSourceAt: T - 5 * H, feedLoadedAt: T - 5 * H, runState: 'publishing' };

test('assess: altas recientes con lista vigente es normal', () => {
  assert.equal(assess(healthy, T, LIMITS).state, 'ok');
});

test('assess: sin altas por más del umbral con lista vigente avisa', () => {
  const v = assess({ ...healthy, lastAltaAt: T - 50 * M }, T, LIMITS);
  assert.equal(v.state, 'stalled');
  assert.equal(v.alert, 'stalled');
  assert.match(v.message, /50 min/);
});

test('assess: la espera nocturna por la lista de SBS no es una falla', () => {
  const v = assess({ ...healthy, lastAltaAt: T - 90 * M, feedSourceAt: T - 26 * H }, T, LIMITS);
  assert.equal(v.state, 'waiting_supplier');
  assert.equal(v.alert, undefined);
});

test('assess: si SBS tarda más que el margen avisa una vez cada 6 h', () => {
  const v = assess({ ...healthy, lastAltaAt: T - 90 * M, feedSourceAt: T - 30 * H }, T, LIMITS);
  assert.equal(v.alert, 'supplier_late');
  assert.equal(v.ttl, 6 * 3600);
});

test('assess: tras cargar una lista nueva el escaneo del inventario no cuenta como parada', () => {
  const v = assess({ ...healthy, lastAltaAt: T - 50 * M, feedSourceAt: T - 30 * M, feedLoadedAt: T - 20 * M }, T, LIMITS);
  assert.equal(v.state, 'warming_up');
});

test('assess: campaña pausada o terminada no avisa aunque no haya altas', () => {
  for (const runState of ['paused', 'complete', 'complete_with_review']) {
    assert.equal(assess({ ...healthy, lastAltaAt: T - 9 * H, runState }, T, LIMITS).state, 'idle');
  }
});

function dbMock(rows) {
  return {
    prepare(sql) {
      const stmt = {
        bind() { return stmt; },
        async first() {
          if (sql.includes('ml_vintage_pub_receipts')) return { at: rows.lastAltaAt };
          if (sql.includes('sbs_supplier_feeds')) return { source_date: new Date(rows.feedSourceAt).toISOString(), created_at: rows.feedLoadedAt };
          if (sql.includes('ml_vintage_pub_runs')) return { state: rows.runState };
          throw new Error('consulta inesperada: ' + sql);
        },
      };
      return stmt;
    },
  };
}

function kvMock() {
  const store = new Map();
  return { async get(k) { return store.get(k) ?? null; }, async put(k, v) { store.set(k, v); }, store };
}

function fetchSpy(ok = true) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return { ok, status: ok ? 200 : 500 }; };
  return { fn, calls };
}

const env = (overrides = {}) => ({ VINTAGE_WATCH_ENABLED: 'true', VINTAGE_NOTIFY_URL: 'https://ntfy.sh/tema-de-prueba', ...overrides });

test('check: con todo bien no manda nada', async () => {
  const spy = fetchSpy();
  const result = await checkVintageHeartbeat(env({ ORDERS_DB: dbMock(healthy), AMADO_KV: kvMock() }), { now: NOW, fetchFn: spy.fn });
  assert.equal(result.state, 'ok');
  assert.equal(spy.calls.length, 0);
});

test('check: una parada avisa por ntfy una sola vez por hora', async () => {
  const spy = fetchSpy(), kv = kvMock();
  const e = env({ ORDERS_DB: dbMock({ ...healthy, lastAltaAt: T - 50 * M }), AMADO_KV: kv });
  const first = await checkVintageHeartbeat(e, { now: NOW, fetchFn: spy.fn });
  assert.equal(first.notified, true);
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].url, 'https://ntfy.sh/tema-de-prueba');
  assert.equal(spy.calls[0].init.method, 'POST');
  assert.equal(spy.calls[0].init.headers.Title, 'Vintage: sin altas nuevas');
  assert.ok(kv.store.has('vintage:watch:alert:stalled'));
  const second = await checkVintageHeartbeat(e, { now: new Date(T + 5 * M), fetchFn: spy.fn });
  assert.equal(second.notified, false);
  assert.equal(second.reason, 'already_notified');
  assert.equal(spy.calls.length, 1);
});

test('check: apagado por configuración o sin base no hace nada', async () => {
  assert.deepEqual(await checkVintageHeartbeat(env({ VINTAGE_WATCH_ENABLED: 'false' })), { state: 'disabled' });
  assert.equal((await checkVintageHeartbeat(env())).state, 'unknown');
});

test('check: una base que falla no tira el cron', async () => {
  const db = { prepare() { return { bind() { return this; }, async first() { throw new Error('D1 down'); } }; } };
  const result = await checkVintageHeartbeat(env({ ORDERS_DB: db }), { now: NOW });
  assert.equal(result.state, 'error');
});

test('ntfy: sólo acepta un tópico de ntfy.sh por https', async () => {
  for (const bad of ['http://ntfy.sh/x', 'https://evil.example/amado-vintage', 'https://ntfy.sh/x?y=1', 'https://user:pw@ntfy.sh/x']) {
    const spy = fetchSpy();
    assert.deepEqual(await notifyNtfy({ VINTAGE_NOTIFY_URL: bad }, 't', 'm', { fetchFn: spy.fn }), { sent: false, reason: 'bad_url' });
    assert.equal(spy.calls.length, 0);
  }
  const spy = fetchSpy(false);
  assert.deepEqual(await notifyNtfy({ VINTAGE_NOTIFY_URL: 'https://ntfy.sh/tema-de-prueba' }, 't', 'm', { fetchFn: spy.fn }), { sent: false, status: 500 });
});

test('check: un envío fallido no reserva el aviso y el siguiente ciclo reintenta',async t=>{
 const kv=kvMock(),e=env({ORDERS_DB:dbMock({...healthy,lastAltaAt:T-50*M}),AMADO_KV:kv});
 const failing=fetchSpy(false);
 const first=await checkVintageHeartbeat(e,{now:NOW,fetchFn:failing.fn});
 assert.equal(first.notified,false);
 assert.equal(kv.store.has('vintage:watch:alert:stalled'),false,'a failed send must not reserve the alert');
 const working=fetchSpy(true);
 const second=await checkVintageHeartbeat(e,{now:new Date(T+5*M),fetchFn:working.fn});
 assert.equal(second.notified,true);
 assert.equal(working.calls.length,1);
 assert.equal(kv.store.has('vintage:watch:alert:stalled'),true);
});

test('check: un KV caído no impide el aviso ni tira el cron',async t=>{
 const brokenGet={async get(){throw new Error('KV down');},async put(){}};
 const spy=fetchSpy(true);
 const result=await checkVintageHeartbeat(env({ORDERS_DB:dbMock({...healthy,lastAltaAt:T-50*M}),AMADO_KV:brokenGet}),{now:NOW,fetchFn:spy.fn});
 assert.equal(result.notified,true);
 assert.equal(spy.calls.length,1);
 const brokenPut={async get(){return null;},async put(){throw new Error('KV down');}};
 const again=await checkVintageHeartbeat(env({ORDERS_DB:dbMock({...healthy,lastAltaAt:T-50*M}),AMADO_KV:brokenPut}),{now:NOW,fetchFn:spy.fn});
 assert.equal(again.notified,true,'the alert already went out; a failed reservation must not undo it');
});

// Desde el 27/11/2026 el latido corre en GitHub (scripts/vintage-cloud/latido.mjs), no en el Worker de Libros.
test('latido en GitHub: D1 por la API y reserva del aviso en una tabla de D1', async () => {
  const { d1Binding, d1Claims, latido } = await import('../vintage-cloud/latido.mjs');
  const claims = new Map(), consultas = [];
  const query = async (sql, params = []) => {
    consultas.push(sql);
    if (/FROM ml_vintage_pub_receipts/.test(sql)) return [{ at: T - 50 * M }];
    if (/FROM sbs_supplier_feeds/.test(sql)) return [{ source_date: new Date(T - 5 * H).toISOString(), created_at: T - 5 * H }];
    if (/FROM ml_vintage_pub_runs/.test(sql)) return [{ state: 'publishing' }];
    if (/^SELECT until/.test(sql)) return claims.has(params[0]) ? [{ until: claims.get(params[0]) }] : [];
    if (/^INSERT INTO vintage_watch_claims/.test(sql)) { claims.set(params[0], params[1]); return []; }
    return [];
  };
  assert.deepEqual(await d1Binding(query).prepare('SELECT state FROM ml_vintage_pub_runs WHERE id = ?').bind('x').first(), { state: 'publishing' });
  const kv = d1Claims(query, () => T);
  assert.equal(await kv.get('k'), null);
  await kv.put('k', 'v', { expirationTtl: 60 });
  assert.ok(await kv.get('k'));
  const spy = { calls: 0, fn: async () => { spy.calls++; return { ok: true, status: 200 }; } };
  const env = { VINTAGE_NOTIFY_URL: 'https://ntfy.sh/tema-de-prueba' };
  const r1 = await latido({ query, env, fetchFn: spy.fn, now: NOW });
  assert.equal(r1.state, 'stalled'); assert.equal(r1.notified, true);
  const r2 = await latido({ query, env, fetchFn: spy.fn, now: NOW });
  assert.equal(r2.reason, 'already_notified');
  assert.equal(spy.calls, 1);
  assert.ok(!consultas.some(s => /ml_oauth/.test(s)), 'el latido no lee tokens');
});
