import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCompetitionInputs, normalizeCompetition } from '../ml-competition.js';

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() { return body; },
  };
}

test('normalizeCompetition prioriza ganador exacto de catálogo', () => {
  const result = normalizeCompetition('MLU1', {
    item: { title: 'Libro X', catalog_product_id: 'MLU999', currency_id: 'UYU', attributes: [{ id: 'ISBN', value_name: '9781234567890' }] },
    salePrice: { amount: 4161, currency_id: 'UYU' },
    priceToWin: {
      catalog_product_id: 'MLU999', status: 'competing', current_price: 4161, price_to_win: 3500,
      winner: { item_id: 'MLU2', price: 3454, currency_id: 'UYU' },
    },
    reference: { lowest_price: { amount: 3600 }, suggested_price: { suggested_price_amount: 3700 }, compared_values: 3 },
  });
  assert.equal(result.own_price, 4161);
  assert.equal(result.exact_catalog_competition.winner_price, 3454);
  assert.equal(result.benchmark_source, 'catalog_winner');
  assert.equal(Math.round(result.gap_percent * 100) / 100, 20.47);
  assert.equal(result.recommendation, 'REVISAR_PRECIO');
  assert.equal(result.isbn, '9781234567890');
  assert.deepEqual(result.excluded_fields, ['competitor_shipping', 'competitor_stock']);
});

test('normalizeCompetition usa referencia ML cuando no hay catálogo exacto', () => {
  const result = normalizeCompetition('MLU1', {
    item: { title: 'Libro X', currency_id: 'UYU' },
    salePrice: { amount: 1000, currency_id: 'UYU' },
    priceToWin: null,
    reference: {
      lowest_price: { amount: 900 },
      suggested_price: { suggested_price_amount: 950 },
      internal_price: { amount: 920 },
      compared_values: 4,
      metadata: { graph: [{ price: { amount: 800 } }, { price: { amount: 1000 } }] },
    },
  });
  assert.equal(result.benchmark_source, 'ml_lowest_price');
  assert.equal(result.ml_reference.reference_median, 900);
  assert.equal(result.ml_reference.confidence, 'media');
  assert.equal(result.recommendation, 'REVISAR_PRECIO');
});

test('normalizeCompetition no inventa comparación si ML no devuelve referencia', () => {
  const result = normalizeCompetition('MLU1', {
    item: { title: 'Libro X', price: 1000, currency_id: 'UYU' },
    salePrice: null,
    priceToWin: null,
    reference: null,
  });
  assert.equal(result.own_price, 1000);
  assert.equal(result.benchmark_price, null);
  assert.equal(result.gap_percent, null);
  assert.equal(result.recommendation, 'SIN_REFERENCIA');
});

test('fetchCompetitionInputs tolera 404 en price_to_win y suggestion', async () => {
  const calls = [];
  const result = await fetchCompetitionInputs('MLU123', 'token', {
    mlGetDeps: {
      fetchFn: async url => {
        calls.push(String(url));
        if (String(url).includes('price_to_win') || String(url).includes('/suggestions/')) return response({}, 404);
        if (String(url).includes('/sale_price')) return response({ amount: 1200, currency_id: 'UYU' });
        return response({ id: 'MLU123', title: 'Libro' });
      },
    },
  });
  assert.equal(result.priceToWin, null);
  assert.equal(result.reference, null);
  assert.equal(result.salePrice.amount, 1200);
  assert.equal(calls.length, 4);
});

test('fetchCompetitionInputs rechaza item_id no MLU', async () => {
  await assert.rejects(() => fetchCompetitionInputs('ABC1', 'token'), /item_id MLU inválido/);
});
