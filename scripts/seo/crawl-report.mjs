import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const INPUT = process.env.CRAWL_REPORT_INPUT || 'artifacts/seo/crawl-stats-raw.json';
const OUTPUT_DIR = process.env.CRAWL_REPORT_OUTPUT_DIR || 'artifacts/seo';
const USEFUL_PATTERNS = new Set(['home', 'libro', 'libros', 'catalogo', 'static_page']);
const EXCLUDED_FROM_DENOMINATOR = new Set(['asset', 'api', 'sitemap', 'robots']);
const SEGMENT_ORDER = [
  'active',
  'by_request',
  'paused_other',
  'paused_unknown',
  'unknown_product',
  'non_product',
  'historical_unsegmented',
];

export function rowsFromWrangler(payload) {
  if (Array.isArray(payload)) {
    return payload.flatMap(entry => Array.isArray(entry?.results) ? entry.results : []);
  }
  return Array.isArray(payload?.results) ? payload.results : [];
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function emptySegment(segment) {
  return {
    segment,
    requestCount: 0,
    verifiedGooglebotRequests: 0,
    verifiedGooglebotStatus200: 0,
    verifiedGooglebotNon200: 0,
    durationMsSum: 0,
    averageDurationMs: null,
  };
}

function segmentForRow(row) {
  const segment = String(row.segment || '').trim();
  return segment || 'historical_unsegmented';
}

function finalizeSegment(segment) {
  segment.averageDurationMs = segment.requestCount
    ? Number((segment.durationMsSum / segment.requestCount).toFixed(2))
    : null;
}

function sortedSegments(bySegment) {
  return Object.values(bySegment).sort((a, b) => {
    const aIndex = SEGMENT_ORDER.indexOf(a.segment);
    const bIndex = SEGMENT_ORDER.indexOf(b.segment);
    const aRank = aIndex === -1 ? SEGMENT_ORDER.length : aIndex;
    const bRank = bIndex === -1 ? SEGMENT_ORDER.length : bIndex;
    return aRank - bRank || a.segment.localeCompare(b.segment);
  });
}

export function aggregate(rows) {
  const byDate = new Map();
  for (const row of rows) {
    const date = String(row.date || 'unknown');
    if (!byDate.has(date)) {
      byDate.set(date, {
        date,
        verifiedGooglebotRequests: 0,
        usefulNumerator: 0,
        usefulDenominator: 0,
        legacyRequests: 0,
        byPattern: {},
        byStatus: {},
        bySegment: {},
      });
    }
    const day = byDate.get(date);
    const count = number(row.request_count);
    const verified = number(row.verified);
    const status = number(row.status);
    const pattern = String(row.pattern || 'other');
    const segmentName = segmentForRow(row);

    day.byPattern[pattern] = (day.byPattern[pattern] || 0) + count;
    day.byStatus[status] = (day.byStatus[status] || 0) + count;
    if (pattern.startsWith('legacy_')) day.legacyRequests += count;

    if (!day.bySegment[segmentName]) day.bySegment[segmentName] = emptySegment(segmentName);
    const segment = day.bySegment[segmentName];
    segment.requestCount += count;
    segment.durationMsSum += number(row.duration_ms_sum);

    if (verified === 1) {
      day.verifiedGooglebotRequests += count;
      segment.verifiedGooglebotRequests += count;
      if (status === 200) segment.verifiedGooglebotStatus200 += count;
      else segment.verifiedGooglebotNon200 += count;

      const inDenominator = !EXCLUDED_FROM_DENOMINATOR.has(pattern);
      if (inDenominator) day.usefulDenominator += count;
      if (status === 200 && USEFUL_PATTERNS.has(pattern)) day.usefulNumerator += count;
    }
  }

  const daily = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const day of daily) {
    day.usefulCrawlRatioV1 = day.usefulDenominator
      ? Number((day.usefulNumerator / day.usefulDenominator).toFixed(6))
      : null;
    for (const segment of Object.values(day.bySegment)) finalizeSegment(segment);
  }

  const total = daily.reduce((acc, day) => {
    acc.verifiedGooglebotRequests += day.verifiedGooglebotRequests;
    acc.usefulNumerator += day.usefulNumerator;
    acc.usefulDenominator += day.usefulDenominator;
    acc.legacyRequests += day.legacyRequests;
    for (const segment of Object.values(day.bySegment)) {
      if (!acc.bySegment[segment.segment]) acc.bySegment[segment.segment] = emptySegment(segment.segment);
      const target = acc.bySegment[segment.segment];
      target.requestCount += segment.requestCount;
      target.verifiedGooglebotRequests += segment.verifiedGooglebotRequests;
      target.verifiedGooglebotStatus200 += segment.verifiedGooglebotStatus200;
      target.verifiedGooglebotNon200 += segment.verifiedGooglebotNon200;
      target.durationMsSum += segment.durationMsSum;
    }
    return acc;
  }, {
    verifiedGooglebotRequests: 0,
    usefulNumerator: 0,
    usefulDenominator: 0,
    legacyRequests: 0,
    bySegment: {},
  });
  total.usefulCrawlRatioV1 = total.usefulDenominator
    ? Number((total.usefulNumerator / total.usefulDenominator).toFixed(6))
    : null;
  for (const segment of Object.values(total.bySegment)) finalizeSegment(segment);

  return { daily, total };
}

function dailyCsv(daily) {
  const lines = ['date,verified_googlebot_requests,useful_numerator,useful_denominator,useful_crawl_ratio_v1,legacy_requests'];
  for (const day of daily) {
    lines.push([
      day.date,
      day.verifiedGooglebotRequests,
      day.usefulNumerator,
      day.usefulDenominator,
      day.usefulCrawlRatioV1 ?? '',
      day.legacyRequests,
    ].join(','));
  }
  return `${lines.join('\n')}\n`;
}

function segmentCsv(daily) {
  const lines = [
    'date,segment,request_count,verified_googlebot_requests,verified_googlebot_status_200,verified_googlebot_non_200,average_duration_ms',
  ];
  for (const day of daily) {
    for (const segment of sortedSegments(day.bySegment)) {
      lines.push([
        day.date,
        segment.segment,
        segment.requestCount,
        segment.verifiedGooglebotRequests,
        segment.verifiedGooglebotStatus200,
        segment.verifiedGooglebotNon200,
        segment.averageDurationMs ?? '',
      ].join(','));
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function main() {
  const payload = JSON.parse(await readFile(INPUT, 'utf8'));
  const rows = rowsFromWrangler(payload);
  const { daily, total } = aggregate(rows);
  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    metric: {
      name: 'useful_crawl_ratio_v1',
      numerator: 'verified=1 AND status=200 AND pattern IN (home, libro, libros, catalogo, static_page)',
      denominator: 'verified=1 AND pattern NOT IN (asset, api, sitemap, robots)',
      productSegments: {
        active: 'ficha resuelta desde catálogo activo',
        by_request: 'ficha pausada presente en sitemap-books-paused.xml',
        paused_other: 'ficha pausada fuera de la cohorte indexable',
        paused_unknown: 'ficha pausada cuyo sitemap no pudo verificarse',
        unknown_product: 'ruta de producto sin resolución concluyente',
        historical_unsegmented: 'datos anteriores a esta instrumentación',
      },
    },
    rowCount: rows.length,
    total,
    daily,
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await Promise.all([
    writeFile(path.join(OUTPUT_DIR, 'crawl-summary.json'), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(path.join(OUTPUT_DIR, 'crawl-daily.csv'), dailyCsv(daily)),
    writeFile(path.join(OUTPUT_DIR, 'crawl-segments.csv'), segmentCsv(daily)),
  ]);
  console.log(JSON.stringify(total));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
