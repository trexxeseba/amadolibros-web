import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  productLookupStateFromContext,
  recordCrawlRequest,
  resetCrawlAnalyticsCachesForTest,
  shouldCaptureCrawlRequest,
  classifyCrawlRequest,
} from '../_shared/crawl-analytics.js';

const BASE = 'https://www.amadolibros.com';

function analyticsRow(page, impressions = 20) {
  return {
    keys: [page],
    clicks: 1,
    impressions,
    ctr: 1 / impressions,
    position: 8,
  };
}

function fakeKv(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    async get(key) { return map.get(key) ?? null; },
    async put(key, value) { map.set(key, value); },
  };
}

function fakeDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        async run() {
          calls.push({ sql, args: [] });
          return { success: true };
        },
        bind(...args) {
          return {
            async run() {
              calls.push({ sql, args });
              return { success: true };
            },
          };
        },
      };
    },
  };
}

function googleRangesResponse() {
  return new Response(JSON.stringify({
    prefixes: [{ ipv4Prefix: '66.249.64.0/19' }],
  }), { status: 200 });
}

function pausedSitemap(ids) {
  const rows = ids.map((id) => `<url><loc>${BASE}/libro/${id}/libro-${id}</loc></url>`).join('');
  return new Response(
    `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${rows}</urlset>`,
    { status: 200, headers: { 'content-type': 'application/xml' } },
  );
}

test('GSC construye una muestra estable 200/200 entre activas y por encargo', async () => {
  const { buildCohortInspectionSample } = await import('../../scripts/seo/gsc-analysis.mjs');
  const active = Array.from(
    { length: 300 },
    (_, index) => `${BASE}/libro/MLU${1000 + index}/activo-${index}`,
  );
  const byRequest = Array.from(
    { length: 300 },
    (_, index) => `${BASE}/libro/MLU${5000 + index}/encargo-${index}`,
  );
  const pageRows = [
    ...active.slice(0, 80).map((page, index) => analyticsRow(page, 200 - index)),
    ...byRequest.slice(0, 80).map((page, index) => analyticsRow(page, 160 - index)),
  ];

  const first = buildCohortInspectionSample({
    activeSitemapUrls: active,
    pausedSitemapUrls: byRequest,
    pageRows,
    ctrOpportunities: pageRows.slice(0, 20).map((row) => ({ page: row.keys[0] })),
    size: 400,
  });
  const second = buildCohortInspectionSample({
    activeSitemapUrls: active,
    pausedSitemapUrls: byRequest,
    pageRows,
    size: 400,
  });

  assert.equal(first.length, 400);
  assert.equal(first.filter((row) => row.cohort === 'active').length, 200);
  assert.equal(first.filter((row) => row.cohort === 'by_request').length, 200);
  assert.equal(new Set(first.map((row) => row.page)).size, 400);
  assert.ok(first.every((row) => active.includes(row.page) || byRequest.includes(row.page)));

  const stableWithoutPriority = buildCohortInspectionSample({
    activeSitemapUrls: active,
    pausedSitemapUrls: byRequest,
    pageRows,
    size: 400,
  });
  assert.deepEqual(second, stableWithoutPriority);
});

test('el resumen de inspección conserva resultados separados por cohorte', async () => {
  const { summarizeInspections } = await import('../../scripts/seo/gsc-analysis.mjs');
  const summary = summarizeInspections([
    { cohort: 'active', stratum: 'seen_in_search', verdict: 'PASS', coverageState: 'Submitted and indexed' },
    { cohort: 'by_request', stratum: 'no_impressions', verdict: 'NEUTRAL', coverageState: 'Crawled - currently not indexed' },
    { cohort: 'by_request', stratum: 'no_impressions', error: 'HTTP 429' },
  ]);

  assert.equal(summary.requested, 3);
  assert.equal(summary.cohorts.active.completed, 1);
  assert.equal(summary.cohorts.active.verdicts.PASS, 1);
  assert.equal(summary.cohorts.by_request.requested, 2);
  assert.equal(summary.cohorts.by_request.errors, 1);
});

test('usa el resultado ya calculado por la ficha para distinguir catálogo activo y pausado', () => {
  assert.equal(productLookupStateFromContext({
    data: { perf: { segments: [{ name: 'active_lookup', found: true }] } },
  }), 'active');
  assert.equal(productLookupStateFromContext({
    data: { perf: { segments: [
      { name: 'active_lookup', found: false },
      { name: 'paused_lookup', found: true },
    ] } },
  }), 'paused');
  assert.equal(productLookupStateFromContext({ data: {} }), 'unknown');
});

async function recordSegment({ id, productLookupState, pausedIds }) {
  resetCrawlAnalyticsCachesForTest();
  const db = fakeDb();
  const env = {
    APP_ENV: 'production',
    AMADO_KV: fakeKv({ 'seo:crawl-logs-3:enabled:production': 'true' }),
    ORDERS_DB: db,
  };
  const sitemapFetches = [];
  const result = await recordCrawlRequest({
    request: new Request(`${BASE}/libro/${id}/libro-de-prueba`, {
      headers: {
        'user-agent': 'Googlebot/2.1',
        'cf-connecting-ip': '66.249.66.1',
      },
    }),
    response: new Response('ok', { status: 200, headers: { 'content-length': '200' } }),
    env,
    durationMs: 12,
    productLookupState,
  }, {
    nowFn: () => Date.parse('2026-08-17T20:00:00Z'),
    fetchFn: async (url, options = {}) => {
      if (String(url).includes('common-crawlers.json')) return googleRangesResponse();
      if (String(url).includes('sitemap-books-paused.xml')) {
        sitemapFetches.push(options);
        return pausedSitemap(pausedIds);
      }
      throw new Error(`Fetch inesperado: ${url}`);
    },
  });

  const insert = db.calls.find((call) => /INSERT INTO crawl_stats_segmented/.test(call.sql));
  assert.ok(insert, 'debe persistir la dimensión segmentada');
  return { result, insert, sitemapFetches };
}

test('Googlebot queda separado en active, by_request y paused_other sin guardar URL', async () => {
  const active = await recordSegment({
    id: 'MLU100',
    productLookupState: 'active',
    pausedIds: ['MLU200'],
  });
  assert.equal(active.result.segment, 'active');
  assert.equal(active.sitemapFetches.length, 0, 'una activa no necesita consultar el sitemap pausado');

  const byRequest = await recordSegment({
    id: 'MLU200',
    productLookupState: 'paused',
    pausedIds: ['MLU200'],
  });
  assert.equal(byRequest.result.segment, 'by_request');
  assert.equal(byRequest.sitemapFetches.length, 1);
  assert.equal(new Headers(byRequest.sitemapFetches[0].headers).get('x-amado-internal-observability'), '1');

  const pausedOther = await recordSegment({
    id: 'MLU300',
    productLookupState: 'paused',
    pausedIds: ['MLU200'],
  });
  assert.equal(pausedOther.result.segment, 'paused_other');

  assert.deepEqual(byRequest.insert.args.slice(0, 6), [
    '2026-08-17', 'libro', 'by_request', 200, 1, 1,
  ]);
  const persisted = JSON.stringify(byRequest.insert.args);
  assert.equal(persisted.includes('/libro/'), false);
  assert.equal(persisted.includes('66.249.66.1'), false);
  assert.equal(persisted.includes('Googlebot'), false);
});

test('la consulta interna del sitemap no vuelve a entrar al muestreo', () => {
  const request = new Request(`${BASE}/sitemap-books-paused.xml`, {
    headers: { 'x-amado-internal-observability': '1' },
  });
  const classification = classifyCrawlRequest(request);
  assert.equal(shouldCaptureCrawlRequest(request, classification, () => 0), false);
});

test('el reporte agregado entrega KPIs separados por cohorte', async () => {
  const { aggregate } = await import('../../scripts/seo/crawl-report.mjs');
  const { total, daily } = aggregate([
    {
      date: '2026-08-17', pattern: 'libro', segment: 'active', status: 200,
      verified: 1, request_count: 10, duration_ms_sum: 100,
    },
    {
      date: '2026-08-17', pattern: 'libro', segment: 'by_request', status: 200,
      verified: 1, request_count: 4, duration_ms_sum: 80,
    },
    {
      date: '2026-08-17', pattern: 'libro', segment: 'paused_other', status: 404,
      verified: 1, request_count: 2, duration_ms_sum: 20,
    },
  ]);

  assert.equal(total.bySegment.active.verifiedGooglebotRequests, 10);
  assert.equal(total.bySegment.by_request.verifiedGooglebotStatus200, 4);
  assert.equal(total.bySegment.paused_other.verifiedGooglebotNon200, 2);
  assert.equal(daily[0].bySegment.by_request.averageDurationMs, 20);
});

test('workflows y migración quedan conectados a las nuevas cohortes', () => {
  const gscWorkflow = readFileSync('.github/workflows/gsc-export.yml', 'utf8');
  const crawlWorkflow = readFileSync('.github/workflows/seo-crawl-report.yml', 'utf8');
  const migration = readFileSync('migrations/0009_crawl_stats_segmented.sql', 'utf8');
  const gscExport = readFileSync('scripts/seo/gsc-export.mjs', 'utf8');

  assert.match(gscWorkflow, /GSC_PAUSED_SITEMAP_URL: https:\/\/www\.amadolibros\.com\/sitemap-books-paused\.xml/);
  assert.match(gscWorkflow, /scripts\/seo\/gsc-analysis\.mjs/);
  assert.match(gscExport, /buildCohortInspectionSample/);
  assert.match(gscExport, /sitemap-cohorts\.json/);
  assert.match(crawlWorkflow, /FROM crawl_stats_segmented/);
  assert.match(crawlWorkflow, /crawl-segments\.csv/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS crawl_stats_segmented/);
  assert.match(migration, /historical_unsegmented/);
});
