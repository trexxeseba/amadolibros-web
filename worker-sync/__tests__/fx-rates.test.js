import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createFxRates, latestFx } from '../fx-rates.js';

function database(t) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  const statement = (sql, args = []) => ({ sql, args, bind(...values) { return statement(sql, values); }, async first() { return sqlite.prepare(sql).get(...args) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; }, async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; } });
  return { prepare: sql => statement(sql), async batch(items) { return items.map(s => ({ results: sqlite.prepare(s.sql).all(...s.args) })); } };
}

test('tipo de cambio: una consulta por día y pesos por unidad de cada moneda', async t => {
  const db = database(t);
  let calls = 0;
  const fx = createFxRates({ now: () => Date.parse('2026-10-25T12:00:00Z'), fetcher: async () => { calls++; return Response.json({ result: 'success', rates: { UYU: 1, USD: 0.025, EUR: 0.0222, ARS: 25, BRL: 0.14 } }); } });
  assert.equal((await fx.sync({ ORDERS_DB: db })).state, 'done');
  assert.equal((await fx.sync({ ORDERS_DB: db })).state, 'fresh');
  assert.equal(calls, 1);
  const r = await latestFx(db);
  assert.equal(r.USD, 40);
  assert.equal(Math.round(r.EUR * 100) / 100, 45.05);
  assert.equal(r.ARS, 0.04);
  assert.equal(r._date, '2026-10-25');
});

test('tipo de cambio: si la API falla no rompe y no guarda nada', async t => {
  const db = database(t);
  const fx = createFxRates({ fetcher: async () => new Response('x', { status: 500 }) });
  assert.equal((await fx.sync({ ORDERS_DB: db })).state, 'error');
  assert.deepEqual(await latestFx(db), { UYU: 1, _date: null });
});
