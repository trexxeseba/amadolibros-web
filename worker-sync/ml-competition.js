/**
 * RADAR DATA 4 / WEB V1 — competencia y referencias de precio read-only.
 *
 * Fuentes oficiales:
 * - GET /items/:id/price_to_win?version=v2
 * - GET /suggestions/items/:id/details
 * - GET /items/:id/sale_price
 * - GET /items/:id
 *
 * No usa ni expone stock de terceros ni condiciones de envío/boosts.
 */

import { mlGet } from './meli-catalog.js';

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstAttrValue(item, ids) {
  const wanted = new Set(ids);
  for (const attr of item?.attributes || []) {
    if (!wanted.has(attr?.id)) continue;
    const value = String(attr.value_name ?? attr.value ?? '').trim();
    if (value) return value;
  }
  return null;
}

function isNotFound(error) {
  return /HTTP 404\b/.test(String(error?.message || ''));
}

async function optionalGet(url, accessToken, options = {}) {
  try {
    return await mlGet(url, accessToken, options);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function fetchCompetitionInputs(itemId, accessToken, { mlGetDeps = {}, retryBudget } = {}) {
  if (!/^MLU\d+$/.test(String(itemId || ''))) throw new Error('[Competition] item_id MLU inválido.');
  const id = encodeURIComponent(itemId);
  const opts = { ...mlGetDeps, retryBudget };

  const [item, salePrice, priceToWin, reference] = await Promise.all([
    optionalGet(`https://api.mercadolibre.com/items/${id}`, accessToken, opts),
    optionalGet(`https://api.mercadolibre.com/items/${id}/sale_price`, accessToken, opts),
    optionalGet(`https://api.mercadolibre.com/items/${id}/price_to_win?version=v2`, accessToken, opts),
    optionalGet(`https://api.mercadolibre.com/suggestions/items/${id}/details`, accessToken, opts),
  ]);

  return { item, salePrice, priceToWin, reference };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function gap(own, other) {
  if (!Number.isFinite(own) || !Number.isFinite(other)) return { amount: null, percent: null };
  const amount = own - other;
  return {
    amount,
    percent: other > 0 ? (amount / other) * 100 : null,
  };
}

export function normalizeCompetition(itemId, { item, salePrice, priceToWin, reference } = {}) {
  const ownPrice = money(
    salePrice?.amount ??
    reference?.current_price?.amount ??
    priceToWin?.current_price ??
    item?.price
  );
  const winnerPrice = money(priceToWin?.winner?.price);
  const priceToWinAmount = money(priceToWin?.price_to_win);
  const suggestedPrice = money(reference?.suggested_price?.suggested_price_amount);
  const lowestPrice = money(reference?.lowest_price?.amount);
  const internalPrice = money(reference?.internal_price?.amount);
  const graphPrices = Array.isArray(reference?.metadata?.graph)
    ? reference.metadata.graph.map(entry => money(entry?.price?.amount)).filter(Number.isFinite)
    : [];
  const referenceMedian = median(graphPrices);

  const exactComparable = Boolean(priceToWin?.catalog_product_id && priceToWin?.winner?.item_id && winnerPrice != null);
  const bestBenchmark = exactComparable ? winnerPrice : (lowestPrice ?? suggestedPrice ?? internalPrice);
  const priceGap = gap(ownPrice, bestBenchmark);

  let recommendation = 'SIN_REFERENCIA';
  if (ownPrice != null && bestBenchmark != null) {
    if ((priceGap.percent ?? 0) > 3) recommendation = 'REVISAR_PRECIO';
    else if ((priceGap.percent ?? 0) < -3) recommendation = 'OPORTUNIDAD_COMPETENCIA';
    else recommendation = 'PRECIO_COMPETITIVO';
  }

  return {
    item_id: itemId,
    title: item?.title || null,
    isbn: firstAttrValue(item, ['ISBN', 'GTIN', 'EAN']),
    catalog_product_id: priceToWin?.catalog_product_id || item?.catalog_product_id || null,
    currency_id: salePrice?.currency_id || priceToWin?.currency_id || reference?.currency_id || item?.currency_id || 'UYU',
    own_price: ownPrice,
    exact_catalog_competition: exactComparable ? {
      status: priceToWin.status || null,
      winner_item_id: priceToWin.winner?.item_id || null,
      winner_price: winnerPrice,
      price_to_win: priceToWinAmount,
      gap_amount: exactComparable ? gap(ownPrice, winnerPrice).amount : null,
      gap_percent: exactComparable ? gap(ownPrice, winnerPrice).percent : null,
      confidence: 'alta',
    } : null,
    ml_reference: reference ? {
      status: reference.status || null,
      suggested_price: suggestedPrice,
      lowest_price: lowestPrice,
      internal_price: internalPrice,
      reference_median: referenceMedian,
      compared_values: Number(reference.compared_values) || 0,
      percent_difference: money(reference.percent_difference),
      last_updated: reference.last_updated || null,
      confidence: exactComparable ? 'complementaria' : 'media',
    } : null,
    benchmark_price: bestBenchmark,
    benchmark_source: exactComparable ? 'catalog_winner' : (lowestPrice != null ? 'ml_lowest_price' : suggestedPrice != null ? 'ml_suggested_price' : internalPrice != null ? 'ml_internal_price' : null),
    gap_amount: priceGap.amount,
    gap_percent: priceGap.percent,
    recommendation,
    excluded_fields: ['competitor_shipping', 'competitor_stock'],
    writes_to_ml: false,
  };
}
