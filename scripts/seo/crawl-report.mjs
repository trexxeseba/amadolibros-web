import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const INPUT = process.env.CRAWL_REPORT_INPUT || 'artifacts/seo/crawl-stats-raw.json';
const OUTPUT_DIR = process.env.CRAWL_REPORT_OUTPUT_DIR || 'artifacts/seo';
const USEFUL_PATTERNS = new Set(['home', 'libro', 'libros', 'catalogo', 'static_page']);
const EXCLUDED_FROM_DENOMINATOR = new Set(['asset', 'api', 'sitemap', 'robots']);

function rowsFromWrangler(payload) {
  if (Array.isArray(payload)) {
    return payload.flatMap(entry => Array.isArray(entry?.results) ? entry.results : []);
  }
  return Array.isArray(payload?.results) ? payload.results : [];
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function aggregate(rows) {
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
      });
    }
    const day = byDate.get(date);
    const count = number(row.request_count);
    const verified = number(row.verified);
    const status = number(row.status);
    const pattern = String(row.pattern || 'other');

    day.byPattern[pattern] = (day.byPattern[pattern] || 0) + count;
    day.byStatus[status] = (day.byStatus[status] || 0) + count;
    if (pattern.startsWith('legacy_')) day.legacyRequests += count;

    if (verified === 1) {
      day.verifiedGooglebotRequests += count;
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
  }

  const total = daily.reduce((acc, day) => {
    acc.verifiedGooglebotRequests += day.verifiedGooglebotRequests;
    acc.usefulNumerator += day.usefulNumerator;
    acc.usefulDenominator += day.usefulDenominator;
    acc.legacyRequests += day.legacyRequests;
    return acc;
  }, { verifiedGooglebotRequests: 0, usefulNumerator: 0, usefulDenominator: 0, legacyRequests: 0 });
  total.usefulCrawlRatioV1 = total.usefulDenominator
    ? Number((total.usefulNumerator / total.usefulDenominator).toFixed(6))
    : null;

  return { daily, total };
}

function csv(daily) {
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

async function main() {
  const payload = JSON.parse(await readFile(INPUT, 'utf8'));
  const rows = rowsFromWrangler(payload);
  const { daily, total } = aggregate(rows);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    metric: {
      name: 'useful_crawl_ratio_v1',
      numerator: 'verified=1 AND status=200 AND pattern IN (home, libro, libros, catalogo, static_page)',
      denominator: 'verified=1 AND pattern NOT IN (asset, api, sitemap, robots)',
    },
    rowCount: rows.length,
    total,
    daily,
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await Promise.all([
    writeFile(path.join(OUTPUT_DIR, 'crawl-summary.json'), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(path.join(OUTPUT_DIR, 'crawl-daily.csv'), csv(daily)),
  ]);
  console.log(JSON.stringify(total));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
