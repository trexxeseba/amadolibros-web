import { createHash } from 'node:crypto';

const PRODUCT_PATH = '/libro/';
const MAX_INSPECTION_SAMPLE = 400;

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

function targetSampleSize(value) {
  return Math.max(1, Math.min(MAX_INSPECTION_SAMPLE, Math.trunc(number(value)) || MAX_INSPECTION_SAMPLE));
}

function uniqueProductUrls(urls = []) {
  return [...new Set(urls.filter(isProductUrl))];
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
  size = MAX_INSPECTION_SAMPLE,
} = {}) {
  const targetSize = targetSampleSize(size);
  const activeUrls = uniqueProductUrls(sitemapUrls);
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

/**
 * Muestra comparable entre las dos poblaciones comerciales:
 * - active: libros disponibles;
 * - by_request: cohorte publicada en sitemap-books-paused.xml.
 *
 * La asignación es 50/50 cuando ambas cohortes tienen suficiente volumen. Si
 * una no llega a su cupo, la otra completa el total. Dentro de cada cohorte se
 * conserva la selección estable por URL de buildInspectionSample().
 */
export function buildCohortInspectionSample({
  activeSitemapUrls = [],
  pausedSitemapUrls = [],
  pageRows = [],
  ctrOpportunities = [],
  size = MAX_INSPECTION_SAMPLE,
} = {}) {
  const targetSize = targetSampleSize(size);
  const activeUrls = uniqueProductUrls(activeSitemapUrls);
  const activeSet = new Set(activeUrls);
  const pausedUrls = uniqueProductUrls(pausedSitemapUrls).filter((page) => !activeSet.has(page));

  if (!activeUrls.length && !pausedUrls.length) return [];

  let activeTarget = 0;
  let pausedTarget = 0;
  if (activeUrls.length && pausedUrls.length) {
    activeTarget = Math.min(activeUrls.length, Math.floor(targetSize / 2));
    pausedTarget = Math.min(pausedUrls.length, targetSize - activeTarget);
  } else if (activeUrls.length) {
    activeTarget = Math.min(activeUrls.length, targetSize);
  } else {
    pausedTarget = Math.min(pausedUrls.length, targetSize);
  }

  let remaining = targetSize - activeTarget - pausedTarget;
  if (remaining > 0) {
    const activeCapacity = activeUrls.length - activeTarget;
    const activeFill = Math.min(activeCapacity, remaining);
    activeTarget += activeFill;
    remaining -= activeFill;
  }
  if (remaining > 0) {
    const pausedCapacity = pausedUrls.length - pausedTarget;
    const pausedFill = Math.min(pausedCapacity, remaining);
    pausedTarget += pausedFill;
  }

  const sampleFor = (urls, cohort, cohortSize) => {
    if (cohortSize <= 0) return [];
    return buildInspectionSample({
      sitemapUrls: urls,
      pageRows,
      ctrOpportunities,
      size: cohortSize,
    }).map((row) => ({ ...row, cohort }));
  };

  return [
    ...sampleFor(activeUrls, 'active', activeTarget),
    ...sampleFor(pausedUrls, 'by_request', pausedTarget),
  ];
}

function emptyInspectionGroup() {
  return {
    requested: 0,
    completed: 0,
    errors: 0,
    verdicts: {},
    coverageStates: {},
  };
}

function incrementInspectionGroup(group, row) {
  group.requested += 1;
  if (row.error) {
    group.errors += 1;
    return;
  }
  group.completed += 1;
  const verdict = row.verdict || 'UNKNOWN';
  const coverageState = row.coverageState || 'UNKNOWN';
  group.verdicts[verdict] = (group.verdicts[verdict] || 0) + 1;
  group.coverageStates[coverageState] = (group.coverageStates[coverageState] || 0) + 1;
}

export function summarizeInspections(rows = []) {
  const summary = {
    ...emptyInspectionGroup(),
    strata: {},
    cohorts: {},
  };
  for (const row of rows) {
    summary.strata[row.stratum] = (summary.strata[row.stratum] || 0) + 1;
    incrementInspectionGroup(summary, row);

    const cohort = row.cohort || 'unsegmented';
    if (!summary.cohorts[cohort]) summary.cohorts[cohort] = emptyInspectionGroup();
    incrementInspectionGroup(summary.cohorts[cohort], row);
  }
  return summary;
}
