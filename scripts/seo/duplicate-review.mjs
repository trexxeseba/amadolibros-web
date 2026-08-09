const LINEAR_FIELDS = ['height', 'width', 'length'];
const LINEAR_DIVERGENCE_LIMIT = 0.20;
const WEIGHT_DIVERGENCE_LIMIT = 0.35;
const PRICE_DIVERGENCE_LIMIT = 0.20;

function normalizeCondition(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || null;
}

function parseMeasurement(value, kind) {
  if (value == null || value === '') return null;
  const match = String(value).trim().replace(',', '.').match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/);
  if (!match) return null;
  const number = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(number) || number <= 0) return null;

  if (kind === 'weight') {
    if (['g', 'gr', 'gram', 'grams', 'gramo', 'gramos'].includes(unit)) return number;
    if (['kg', 'kilogram', 'kilograms', 'kilogramo', 'kilogramos'].includes(unit)) return number * 1000;
    if (['mg', 'milligram', 'milligrams', 'miligramo', 'miligramos'].includes(unit)) return number / 1000;
    return null;
  }

  if (['cm', 'centimeter', 'centimeters', 'centimetro', 'centimetros'].includes(unit)) return number;
  if (['mm', 'millimeter', 'millimeters', 'milimetro', 'milimetros'].includes(unit)) return number / 10;
  if (['m', 'meter', 'meters', 'metro', 'metros'].includes(unit)) return number * 100;
  return null;
}

function relativeSpread(values) {
  const valid = values.filter((value) => Number.isFinite(value) && value > 0);
  if (valid.length < 2) return null;
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  return { min, max, ratio: (max - min) / min };
}

function priceEvidence(items) {
  const values = items.map((item) => {
    const price = Number(item.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  });
  const spread = relativeSpread(values);
  return {
    values,
    complete: values.every((value) => value != null),
    min: spread?.min ?? null,
    max: spread?.max ?? null,
    spreadPct: spread ? Math.round(spread.ratio * 10000) / 100 : null,
    divergent: Boolean(spread && spread.ratio > PRICE_DIVERGENCE_LIMIT),
  };
}

function dimensionEvidence(items) {
  const normalizedByItem = items.map((item) => {
    const source = item.dimensions && typeof item.dimensions === 'object' ? item.dimensions : {};
    return {
      height: parseMeasurement(source.height, 'linear'),
      width: parseMeasurement(source.width, 'linear'),
      length: parseMeasurement(source.length, 'linear'),
      weight: parseMeasurement(source.weight, 'weight'),
    };
  });

  const comparisons = {};
  const commonFields = [];
  let divergent = false;

  for (const field of [...LINEAR_FIELDS, 'weight']) {
    const values = normalizedByItem.map((item) => item[field]);
    if (!values.every((value) => value != null)) continue;
    commonFields.push(field);
    const spread = relativeSpread(values);
    const limit = field === 'weight' ? WEIGHT_DIVERGENCE_LIMIT : LINEAR_DIVERGENCE_LIMIT;
    const isDivergent = Boolean(spread && spread.ratio > limit);
    if (isDivergent) divergent = true;
    comparisons[field] = {
      values,
      min: spread?.min ?? values[0] ?? null,
      max: spread?.max ?? values[0] ?? null,
      spreadPct: spread ? Math.round(spread.ratio * 10000) / 100 : 0,
      thresholdPct: Math.round(limit * 100),
      divergent: isDivergent,
      normalizedUnit: field === 'weight' ? 'g' : 'cm',
    };
  }

  const itemsWithAnyMeasurement = normalizedByItem.filter((item) =>
    Object.values(item).some((value) => value != null)
  ).length;

  return {
    completeForAll: itemsWithAnyMeasurement === items.length && commonFields.length > 0,
    itemsWithAnyMeasurement,
    commonFields,
    comparisons,
    divergent,
  };
}

export function classifyStrictDuplicateItems(items) {
  const conditions = items.map((item) => normalizeCondition(item.condition));
  const conditionValues = [...new Set(conditions.filter(Boolean))].sort();
  const conditionComplete = conditions.every(Boolean);
  const prices = priceEvidence(items);
  const dimensions = dimensionEvidence(items);

  const reasons = [];
  let decision = 'green_candidate';

  if (conditionValues.length > 1) {
    decision = 'no_consolidate';
    reasons.push('condition_differs');
  } else {
    if (!conditionComplete) reasons.push('condition_missing');
    if (!prices.complete) reasons.push('price_missing');
    if (prices.divergent) reasons.push('price_divergence_gt_20pct');
    if (!dimensions.completeForAll) reasons.push('dimensions_incomplete');
    if (dimensions.divergent) reasons.push('dimensions_divergent');

    if (reasons.length > 0) decision = 'review';
  }

  return {
    decision,
    reasons,
    evidence: {
      conditions: {
        values: conditions,
        distinct: conditionValues,
        complete: conditionComplete,
      },
      prices,
      dimensions,
    },
  };
}

export function enrichStrictDuplicateGroup(group, itemById) {
  const items = group.items.map((summary) => {
    const source = itemById.get(summary.id) || {};
    return {
      ...summary,
      condition: source.condition || null,
      price: Number.isFinite(Number(source.price)) ? Number(source.price) : null,
      dimensions: source.dimensions && typeof source.dimensions === 'object'
        ? source.dimensions
        : null,
    };
  });

  return {
    key: group.key,
    kind: group.kind,
    count: group.count,
    items,
    ...classifyStrictDuplicateItems(items),
  };
}

export function summarizeStrictReview(groups) {
  return groups.reduce((summary, group) => {
    summary.total++;
    summary[group.decision]++;
    return summary;
  }, {
    total: 0,
    green_candidate: 0,
    review: 0,
    no_consolidate: 0,
  });
}

export const DUPLICATE_REVIEW_THRESHOLDS = Object.freeze({
  pricePct: PRICE_DIVERGENCE_LIMIT * 100,
  linearDimensionPct: LINEAR_DIVERGENCE_LIMIT * 100,
  weightPct: WEIGHT_DIVERGENCE_LIMIT * 100,
});
