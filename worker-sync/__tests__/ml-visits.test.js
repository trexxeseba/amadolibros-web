import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchVisitsRange, fetchVisitsTimeWindow } from '../ml-visits.js';

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    async json() { return body; },
  };
}

test('fetchVisitsRange: arma la URL con ids separados por coma y date_from/date_to', async () => {
  let capturedUrl;
  const fetchFn = async url => {
    capturedUrl = String(url);
    return jsonResponse([
      { item_id: 'MLU1', date_from: '2026-08-24', date_to: '2026-08-24', total_visits: 12 },
      { item_id: 'MLU2', date_from: '2026-08-24', date_to: '2026-08-24', total_visits: 0 },
    ]);
  };

  const rows = await fetchVisitsRange(['MLU1', 'MLU2'], 'token', {
    dateFrom: '2026-08-24',
    mlGetDeps: { fetchFn },
  });

  assert.match(capturedUrl, /^https:\/\/api\.mercadolibre\.com\/items\/visits\?ids=MLU1,MLU2&date_from=2026-08-24&date_to=2026-08-24$/);
  assert.deepEqual(rows, [
    { item_id: 'MLU1', total_visits: 12 },
    { item_id: 'MLU2', total_visits: 0 },
  ]);
});

test('fetchVisitsRange: dateTo por defecto es igual a dateFrom (un solo día calendario)', async () => {
  let capturedUrl;
  const fetchFn = async url => { capturedUrl = String(url); return jsonResponse([]); };
  await fetchVisitsRange(['MLU1'], 'token', { dateFrom: '2026-08-20', mlGetDeps: { fetchFn } });
  assert.ok(capturedUrl.includes('date_from=2026-08-20&date_to=2026-08-20'));
});

test('fetchVisitsRange: ids vacío no llama a fetch y devuelve []', async () => {
  let called = false;
  const fetchFn = async () => { called = true; return jsonResponse([]); };
  const rows = await fetchVisitsRange([], 'token', { dateFrom: '2026-08-20', mlGetDeps: { fetchFn } });
  assert.deepEqual(rows, []);
  assert.equal(called, false);
});

test('fetchVisitsRange: exige dateFrom', async () => {
  await assert.rejects(() => fetchVisitsRange(['MLU1'], 'token', {}), /dateFrom es requerido/);
});

test('fetchVisitsRange: ignora entradas sin item_id — nunca inventa filas', async () => {
  const fetchFn = async () => jsonResponse([
    { item_id: 'MLU1', total_visits: 5 },
    { total_visits: 99 }, // sin item_id — Mercado Libre no debería mandar esto, pero no se inventa a quién pertenece
    null,
  ]);
  const rows = await fetchVisitsRange(['MLU1'], 'token', { dateFrom: '2026-08-20', mlGetDeps: { fetchFn } });
  assert.deepEqual(rows, [{ item_id: 'MLU1', total_visits: 5 }]);
});

test('fetchVisitsTimeWindow: arma la URL con last/unit/ending', async () => {
  let capturedUrl;
  const fetchFn = async url => { capturedUrl = String(url); return jsonResponse({ total_visits: 42 }); };
  const result = await fetchVisitsTimeWindow('MLU1', 'token', {
    last: 30, unit: 'day', ending: '2026-08-27', mlGetDeps: { fetchFn },
  });
  assert.equal(capturedUrl, 'https://api.mercadolibre.com/items/MLU1/visits/time_window?last=30&unit=day&ending=2026-08-27');
  assert.deepEqual(result, { total_visits: 42 });
});

test('fetchVisitsTimeWindow: exige itemId', async () => {
  await assert.rejects(() => fetchVisitsTimeWindow('', 'token'), /itemId es requerido/);
});
