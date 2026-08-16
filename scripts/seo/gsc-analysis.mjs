import { createHash } from 'node:crypto';

const PRODUCT_PATH = '/libro/';

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstKey(row, index = 0) {
  return row?.keys?.[index] || '';
}

function stableRank(value) {
  return createHash('sha256').update(value).digest('hex');
}

function uniqueByPage(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    if (!row.page || seen.has(row.page)) return false;
    seen.add(row.page);
    return true;
  });
}

export function isProductUrl(url) {
  try {
    return new URL(url).pathname.startsWith(PRODUCT_PATH);
  } catch {
    return false;
  }
}

export function normalizePageRows(rows = []) {
  return rows.map((row) => ({
    page: firstKey(row),
    clicks: number(row.clicks),
    impressions: number(row.impressions),
    ctr: number(row.ctr),
    position: number(row.position),
  }));
}

export function summarizeProductPerformance(pageRows = []) {
  const products = normalizePageRows(pageRows).filter((row) => isProductUrl(row.page));
  const clicks = products.reduce((sum, row) => sum + row.clicks, 0);
  const impressions = products.reduce((sum, row) => sum + row.impressions, 0);
  return {
    pageCount: products.length,
    clicks,
    impressions,
    ctr: impressions ? clicks / impressions : 0,
  };
}

function queriesByPage(pageQueryRows = []) {
  const grouped = new Map();
  for (const row of pageQueryRows) {
    const page = firstKey(row);
    const query = firstKey(row, 1);
    if (!page || !query) continue;
    const values = grouped.get(page) || [];
    values.push({
      query,
      clicks: number(row.clicks),
      impressions: number(row.impressions),
      ctr: number(row.ctr),
      position: number(row.position),
    });
    grouped.set(page, values);
  }
  for (const values of grouped.values()) {
    values.sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks || a.query.localeCompare(b.query));
  }
  return grouped;
}

export function selectCtrOpportunities({
  pageRows = [],
  pageQueryRows = [],
  limit = 20,
  minImpressions = 10,
  minPosition = 3,
  maxPosition = 15,
} = {}) {
  const summary = summarizeProductPerformance(pageRows);
  const queryMap = queriesByPage(pageQueryRows);
  const rows = normalizePageRows(pageRows)
    .filter((row) => (
      isProductUrl(row.page)
      && row.impressions >= minImpressions
      && row.position >= minPosition
      && row.position <= maxPosition
      && row.ctr < summary.ctr
    ))
    .map((row) => ({
      ...row,
      benchmarkCtr: summary.ctr,
      estimatedMissedClicks: Math.max(0, (summary.ctr - row.ctr) * row.impressions),
      topQueries: (queryMap.get(row.page) || []).slice(0, 5),
    }))
    .sort((a, b) => (
      b.estimatedMissedClicks - a.estimatedMissedClicks
      || b.impressions - a.impressions
      || a.position - b.position
      || a.page.localeCompare(b.page)
    ))
    .slice(0, limit);

  return {
    criteria: { limit, minImpressions, minPosition, maxPosition },
    benchmark: summary,
    rows,
  };
}

export function buildInspectionSample({
  sitemapUrls = [],
  pageRows = [],
  ctrOpportunities = [],
  size = 400,
} = {}) {
  const targetSize = Math.max(1, Math.min(400, Math.trunc(number(size)) || 400));
  const activeUrls = [...new Set(sitemapUrls.filter(isProductUrl))];
  const activeSet = new Set(activeUrls);
  const normalizedPages = normalizePageRows(pageRows)
    .filter((row) => isProductUrl(row.page) && activeSet.has(row.page));
  const pagesWithImpressions = new Set(normalizedPages.map((row) => row.page));

  const priorityCap = Math.min(100, Math.ceil(targetSize * 0.25));
  const seenCap = Math.min(100, Math.ceil(targetSize * 0.25));
  const selected = [];
  const selectedUrls = new Set();

  const add = (page, stratum) => {
    if (!activeSet.has(page) || selectedUrls.has(page) || selected.length >= targetSize) return false;
    selected.push({ page, stratum });
    selectedUrls.add(page);
    return true;
  };

  const priority = uniqueByPage([
    ...ctrOpportunities,
    ...normalizedPages.slice().sort((a, b) => b.impressions - a.impressions || a.page.localeCompare(b.page)),
  ]);
  for (const row of priority.slice(0, priorityCap)) add(row.page, 'ctr_or_high_demand');

  const otherSeen = normalizedPages
    .filter((row) => !selectedUrls.has(row.page))
    .sort((a, b) => stableRank(a.page).localeCompare(stableRank(b.page)));
  for (const row of otherSeen.slice(0, seenCap)) add(row.page, 'seen_in_search');

  const unseen = activeUrls
    .filter((page) => !pagesWithImpressions.has(page))
    .sort((a, b) => stableRank(a).localeCompare(stableRank(b)));
  for (const page of unseen) add(page, 'no_impressions');

  const remainder = activeUrls
    .filter((page) => !selectedUrls.has(page))
    .sort((a, b) => stableRank(a).localeCompare(stableRank(b)));
  for (const page of remainder) {
    add(page, pagesWithImpressions.has(page) ? 'seen_in_search_fill' : 'no_impressions_fill');
  }

  return selected;
}

export function summarizeInspections(rows = []) {
  const summary = {
    requested: rows.length,
    completed: 0,
    errors: 0,
    verdicts: {},
    coverageStates: {},
    strata: {},
  };
  for (const row of rows) {
    summary.strata[row.stratum] = (summary.strata[row.stratum] || 0) + 1;
    if (row.error) {
      summary.errors += 1;
      continue;
    }
    summary.completed += 1;
    const verdict = row.verdict || 'UNKNOWN';
    const coverageState = row.coverageState || 'UNKNOWN';
    summary.verdicts[verdict] = (summary.verdicts[verdict] || 0) + 1;
    summary.coverageStates[coverageState] = (summary.coverageStates[coverageState] || 0) + 1;
  }
  return summary;
}
